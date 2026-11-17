// FrostDrop multiplayer server — no dependencies (Node 18+).
// Site + accounts (email/password) + Server-Sent Events (/api/events) + JSON POST (/api/send).
// Shared: online list, chat, real live drops, crash rounds, case-battle lobbies.
// Storage: Upstash Redis REST (env UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN) or a local JSON file.
'use strict';
const http=require('http'),fs=require('fs'),path=require('path'),vm=require('vm'),crypto=require('crypto');
const ROOT=path.join(__dirname,'..');const PORT=+process.env.PORT||8800;const HOST=process.env.HOST||'0.0.0.0';
let LOCALCFG={};try{LOCALCFG=JSON.parse(fs.readFileSync(path.join(__dirname,'config.local.json'),'utf8'));}catch(e){}
const ADMIN_EMAIL=String(process.env.ADMIN_EMAIL||LOCALCFG.adminEmail||'').trim().toLowerCase();

// ---------- storage
const UP_URL=process.env.UPSTASH_REDIS_REST_URL||LOCALCFG.upstashUrl,UP_TOK=process.env.UPSTASH_REDIS_REST_TOKEN||LOCALCFG.upstashToken;
const store=UP_URL?{
  kind:'upstash',
  async cmd(a){const r=await fetch(UP_URL,{method:'POST',headers:{Authorization:'Bearer '+UP_TOK,'Content-Type':'application/json'},body:JSON.stringify(a)});const j=await r.json();if(j.error)throw new Error(j.error);return j.result;},
  async get(k){const v=await this.cmd(['GET',k]);return v==null?null:JSON.parse(v);},
  async set(k,v){await this.cmd(['SET',k,JSON.stringify(v)]);},
  async del(k){await this.cmd(['DEL',k]);}
}:(()=>{const F=path.join(__dirname,'data','db.json');let db={};try{db=JSON.parse(fs.readFileSync(F,'utf8'));}catch(e){}
  let t=0;const flush=()=>{clearTimeout(t);t=setTimeout(()=>{fs.mkdirSync(path.dirname(F),{recursive:true});fs.writeFileSync(F+'.tmp',JSON.stringify(db));fs.renameSync(F+'.tmp',F);},500);};
  return {kind:'file',async get(k){return db[k]===undefined?null:JSON.parse(JSON.stringify(db[k]));},async set(k,v){db[k]=v;flush();},async del(k){delete db[k];flush();}};})();

// ---------- game data (our own generated files)
const ctx={window:{}};
vm.runInNewContext(fs.readFileSync(path.join(ROOT,'data','items.js'),'utf8'),ctx);
vm.runInNewContext(fs.readFileSync(path.join(ROOT,'data','cases.js'),'utf8'),ctx);
const ITEM=Object.fromEntries(ctx.window.FD_ITEMS.map(r=>[r[0],{id:r[0],price:r[4],rar:r[3]}]));
const CASE=Object.fromEntries(ctx.window.FD_CASES.map(c=>[c.id,c]));
const RTP=0.88,oddsCache={};
function caseOdds(c){if(oddsCache[c.id])return oddsCache[c.id];const its=c.items.map(id=>ITEM[id]).filter(Boolean);const ps=its.map(i=>i.price);
  const mn=Math.min(...ps),mx=Math.max(...ps);const target=Math.max(mn+(mx-mn)*.0005,Math.min(mx-(mx-mn)*.03,c.price*RTP));
  const ev=k=>{let sw=0,se=0;for(const p of ps){const w=Math.pow(p,-k);sw+=w;se+=w*p;}return se/sw;};
  let lo=-4,hi=14;for(let i=0;i<80;i++){const m=(lo+hi)/2;if(ev(m)>target)lo=m;else hi=m;}const k=(lo+hi)/2;const ws=ps.map(p=>Math.pow(p,-k));const s=ws.reduce((a,b)=>a+b,0);
  return oddsCache[c.id]=its.map((item,i)=>({item,p:ws[i]/s}));}
function pick(arr){const r=Math.random();let a=0;for(const o of arr){a+=o.p;if(r<a)return o.item;}return arr[arr.length-1].item;}

// ---------- accounts
const EMAIL_RE=/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const clean=(s,n)=>String(s||'').replace(/[\u0000-\u001f<>]/g,'').trim().slice(0,n);
const hashPw=(pw,salt)=>crypto.scryptSync(String(pw),salt,64).toString('hex');
const users=new Map(); // id -> user (cache)
async function userByEmail(email){return store.get('user:'+email);}
async function saveUser(u){users.set(u.id,u);await store.set('user:'+u.email,u);await store.set('uid:'+u.id,u.email);}
async function userById(id){if(users.has(id))return users.get(id);const em=await store.get('uid:'+id);if(!em)return null;const u=await userByEmail(em);if(u)users.set(id,u);return u;}
const sessCache=new Map();
async function userByToken(tok){if(!/^[a-f0-9]{48}$/.test(String(tok||'')))return null;let id=sessCache.get(tok);if(!id){id=await store.get('sess:'+tok);if(!id)return null;sessCache.set(tok,id);}return userById(id);}
async function newSession(u){const tok=crypto.randomBytes(24).toString('hex');await store.set('sess:'+tok,u.id);sessCache.set(tok,u.id);return tok;}
function pubUser(u){return {id:u.id,email:u.email,nick:u.nick,ava:u.ava,img:u.imgv?`/api/ava/${u.id}?v=${u.imgv}`:'',admin:!!(ADMIN_EMAIL&&u.email===ADMIN_EMAIL)};}
const loginRate=new Map();
function tooMany(ip){const n=Date.now();const a=(loginRate.get(ip)||[]).filter(t=>n-t<60000);a.push(n);loginRate.set(ip,a);return a.length>8;}
function validImg(img){return typeof img==='string'&&/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(img)&&img.length<=150000;}
async function setAvatar(u,img){if(img===''){u.imgv=0;await store.del('ava:'+u.id);return;}if(!validImg(img))throw new Error('Фото не подходит (до ~100 КБ)');await store.set('ava:'+u.id,img);u.imgv=(u.imgv||0)+1;}

// ---------- realtime
const clients=new Map(); // userId -> {cid,u,streams:Set}
function pub(c){return {cid:c.cid,nick:c.u.nick,ava:c.u.ava,img:c.u.imgv?`/api/ava/${c.u.id}?v=${c.u.imgv}`:''};}
function write(res,obj){try{res.write('data: '+JSON.stringify(obj)+'\n\n');}catch(e){}}
function bcast(obj){const s='data: '+JSON.stringify(obj)+'\n\n';for(const c of clients.values())for(const r of c.streams){try{r.write(s);}catch(e){}}}
let onlineT=0;function bOnline(){clearTimeout(onlineT);onlineT=setTimeout(()=>bcast({t:'online',list:[...clients.values()].map(pub)}),300);}
const chat=[],feed=[];

// ---------- crash
const GROW=0.075,BOTS=[['FrostByte','#38b6ff'],['Snowball','#7fd8ff'],['IceKing','#5a7bff'],['Rudolf','#c0622a'],['Дед Мороз','#e03a4a'],['Krampus','#8a2be2'],['Yeti','#9aa8b8'],['Blizzard','#2ec4b6'],['Пингвин','#3a4a6a'],['Снегурка','#ff6aa0']];
const cr={round:1,phase:'wait',waitEnd:Date.now()+7000,start:0,cp:1,crashAt:0,bets:[]};
function crGen(){const r=Math.random();return Math.max(1,Math.floor(96/(1-Math.min(r,.9999)))/100);}
function crMult(now){return Math.exp(GROW*(now-cr.start)/1000);}
function crState(){return {t:'crash',round:cr.round,phase:cr.phase,waitEnd:cr.waitEnd,start:cr.start,cp:cr.phase==='crash'?cr.cp:null,bets:cr.bets,now:Date.now()};}
function crBets(){bcast({t:'cbets',round:cr.round,bets:cr.bets});}
function crBots(){const n=2+Math.floor(Math.random()*3);const bs=BOTS.slice().sort(()=>Math.random()-.5).slice(0,n);
  for(const [nick,ava] of bs)cr.bets.push({cid:'bot:'+nick,nick,ava,img:'',bot:true,amount:Math.round((1+Math.random()*(Math.random()<.2?300:50))*100)/100,auto:Math.random()<.1?0:+(1.1+Math.pow(Math.random(),2.2)*9).toFixed(2),out:0});}
crBots();
setInterval(()=>{const now=Date.now();
  if(cr.phase==='wait'&&now>=cr.waitEnd){cr.phase='fly';cr.start=now;cr.cp=crGen();bcast(crState());}
  else if(cr.phase==='fly'){const m=crMult(now);let ch=false;
    for(const b of cr.bets)if(!b.out&&b.auto>=1.01&&m>=b.auto&&b.auto<cr.cp){b.out=b.auto;ch=true;}
    if(m>=cr.cp){cr.phase='crash';cr.crashAt=now;bcast(crState());}else if(ch)crBets();}
  else if(cr.phase==='crash'&&now>=cr.crashAt+3200){cr.round++;cr.phase='wait';cr.waitEnd=now+7000;cr.bets=[];crBots();bcast(crState());}
},50);

// ---------- battles
const lobbies=new Map();
function lobPub(l){return {id:l.id,owner:l.owner,cases:l.cases,size:l.size,mode:l.mode,players:l.players,status:l.status,cost:l.cost,res:l.status!=='open'?l.res:null,winner:l.status!=='open'?l.winner:null,startAt:l.startAt,created:l.created};}
function bLobbies(){bcast({t:'lobbies',list:[...lobbies.values()].filter(l=>l.status!=='closed').map(lobPub)});}
function runLobby(l){l.status='run';l.res=l.cases.map(cid=>l.players.map(()=>pick(caseOdds(CASE[cid])).id));
  const tot=l.players.map((p,j)=>Math.round(l.res.reduce((s,r)=>s+ITEM[r[j]].price,0)*100)/100);
  const tg=l.mode==='crazy'?Math.min(...tot):Math.max(...tot);const c=tot.map((t,i)=>t===tg?i:-1).filter(i=>i>=0);l.winner=c[Math.floor(Math.random()*c.length)];
  l.startAt=Date.now()+1200;bcast({t:'battle',lobby:lobPub(l)});bLobbies();
  setTimeout(()=>{l.status='done';bLobbies();setTimeout(()=>{lobbies.delete(l.id);bLobbies();},90000);},l.cases.length*6500+8000);}
function closeLobby(l,why){l.status='closed';bcast({t:'bclosed',id:l.id,refund:l.players.filter(p=>!p.bot).map(p=>p.cid),cost:l.cost,why});lobbies.delete(l.id);bLobbies();}
setInterval(()=>{for(const l of lobbies.values())if(l.status==='open'&&Date.now()-l.created>15*60000)closeLobby(l,'timeout');},30000);

// ---------- realtime actions
const rate=new Map();function limited(cid,key,ms){const k=cid+key,n=Date.now();if((rate.get(k)||0)>n)return true;rate.set(k,n+ms);return false;}
function act(c,m){
  switch(m.t){
    case 'chat':{const text=clean(m.text,200);if(!text)return {err:'empty'};if(limited(c.cid,'chat',700))return {err:'slow'};const msg={...pub(c),text,ts:Date.now()};chat.push(msg);if(chat.length>80)chat.shift();bcast({t:'chat',m:msg});return {ok:1};}
    case 'drop':{if(!ITEM[m.id]||limited(c.cid,'drop',200))return {ok:0};const d={...pub(c),id:m.id};feed.push(d);if(feed.length>25)feed.shift();bcast({t:'drop',...d});return {ok:1};}
    case 'bet':{if(cr.phase!=='wait')return {err:'not wait'};if(cr.bets.some(b=>b.cid===c.cid))return {err:'already'};const a=Math.round(+m.amount*100)/100;if(!(a>=0.1&&a<=1e8))return {err:'amount'};
      cr.bets.push({...pub(c),amount:a,auto:Math.max(0,+m.auto||0),out:0});crBets();return {ok:1,round:cr.round};}
    case 'cancel':{if(cr.phase!=='wait')return {err:'late'};const i=cr.bets.findIndex(b=>b.cid===c.cid);if(i<0)return {err:'none'};cr.bets.splice(i,1);crBets();return {ok:1};}
    case 'cashout':{if(cr.phase!=='fly')return {err:'late'};const b=cr.bets.find(b=>b.cid===c.cid);if(!b||b.out)return {err:'none'};const mm=Math.floor(crMult(Date.now())*100)/100;if(mm>=cr.cp)return {err:'late'};b.out=mm;crBets();return {ok:1,m:mm};}
    case 'bcreate':{const cases=(Array.isArray(m.cases)?m.cases:[]).filter(id=>CASE[id]).slice(0,12);if(!cases.length)return {err:'cases'};
      if([...lobbies.values()].some(l=>l.status==='open'&&l.owner===c.cid))return {err:'Уже есть твоё открытое лобби'};
      const l={id:crypto.randomBytes(4).toString('hex'),owner:c.cid,cases,size:Math.min(4,Math.max(2,+m.size||2)),mode:m.mode==='crazy'?'crazy':'classic',players:[pub(c)],status:'open',created:Date.now()};
      l.cost=Math.round(cases.reduce((s,id)=>s+CASE[id].price,0)*100)/100;lobbies.set(l.id,l);bLobbies();return {ok:1,id:l.id,cost:l.cost};}
    case 'bjoin':{const l=lobbies.get(m.id);if(!l||l.status!=='open')return {err:'Лобби уже не доступно'};if(l.players.some(p=>p.cid===c.cid))return {err:'Ты уже в лобби'};if(l.players.length>=l.size)return {err:'Мест нет'};
      l.players.push(pub(c));if(l.players.length>=l.size)runLobby(l);else bLobbies();return {ok:1,cost:l.cost};}
    case 'bbots':{const l=lobbies.get(m.id);if(!l||l.status!=='open'||l.owner!==c.cid)return {err:'no'};const bs=BOTS.slice().sort(()=>Math.random()-.5);
      while(l.players.length<l.size){const [nick,ava]=bs.pop();l.players.push({cid:'bot:'+nick,nick,ava,img:'',bot:true});}runLobby(l);return {ok:1};}
    case 'bleave':{const l=lobbies.get(m.id);if(!l||l.status!=='open')return {err:'no'};if(l.owner===c.cid){closeLobby(l,'owner');return {ok:1};}
      const i=l.players.findIndex(p=>p.cid===c.cid);if(i<0)return {err:'no'};l.players.splice(i,1);bLobbies();return {ok:1,refund:l.cost};}
  }
  return {err:'unknown'};
}

// ---------- account API
async function api(route,m,ip){
  switch(route){
    case 'register':{if(tooMany(ip))return {err:'Слишком много попыток, подожди минуту'};
      const email=String(m.email||'').trim().toLowerCase();if(!EMAIL_RE.test(email))return {err:'Неверная почта'};
      if(String(m.password||'').length<6)return {err:'Пароль — минимум 6 символов'};if(String(m.password).length>200)return {err:'Слишком длинный пароль'};
      if(await userByEmail(email))return {err:'Эта почта уже зарегистрирована — войди'};
      const nick=clean(m.nick,16)||clean(email.split('@')[0],16)||'Игрок';const salt=crypto.randomBytes(16).toString('hex');
      const u={id:crypto.randomBytes(8).toString('hex'),email,nick,ava:/^#[0-9a-f]{6}$/i.test(m.ava)?m.ava:'#ffc93c',salt,hash:hashPw(m.password,salt),created:Date.now(),imgv:0};
      if(m.img){try{await setAvatar(u,m.img);}catch(e){}}
      await saveUser(u);const token=await newSession(u);return {ok:1,token,me:{user:pubUser(u),state:null}};}
    case 'login':{if(tooMany(ip))return {err:'Слишком много попыток, подожди минуту'};
      const email=String(m.email||'').trim().toLowerCase();const u=await userByEmail(email);
      if(!u||!crypto.timingSafeEqual(Buffer.from(hashPw(m.password||'',u.salt),'hex'),Buffer.from(u.hash,'hex')))return {err:'Неверная почта или пароль'};
      users.set(u.id,u);const token=await newSession(u);return {ok:1,token,me:{user:pubUser(u),state:await store.get('state:'+u.id)}};}
    case 'me':{const u=await userByToken(m.token);if(!u)return {err:'auth'};return {ok:1,user:pubUser(u),state:await store.get('state:'+u.id)};}
    case 'save':{const u=await userByToken(m.token);if(!u)return {err:'auth'};const s=m.state;if(!s||typeof s.balance!=='number'||!Array.isArray(s.inv))return {err:'bad'};await store.set('state:'+u.id,s);return {ok:1};}
    case 'profile':{const u=await userByToken(m.token);if(!u)return {err:'auth'};if(m.nick!==undefined)u.nick=clean(m.nick,16)||u.nick;if(/^#[0-9a-f]{6}$/i.test(m.ava||''))u.ava=m.ava;
      if(m.img!==undefined){try{await setAvatar(u,m.img);}catch(e){return {err:e.message};}}
      await saveUser(u);const c=clients.get(u.id);if(c)c.u=u;bOnline();return {ok:1,user:pubUser(u)};}
    case 'logout':{if(/^[a-f0-9]{48}$/.test(String(m.token||''))){sessCache.delete(m.token);await store.del('sess:'+m.token);}return {ok:1};}
  }
  return {err:'unknown'};
}

// ---------- http
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css','.json':'application/json','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon'};
function serveStatic(req,res){let p=decodeURIComponent(new URL(req.url,'http://x').pathname);if(p==='/')p='/index.html';
  const f=path.normalize(path.join(ROOT,p));if(!f.startsWith(ROOT+path.sep)||/^[\\/](server|tools|node_modules|\.git)([\\/]|$)/.test(f.slice(ROOT.length))||/start_server|render\.yaml|package/.test(f)){res.writeHead(403);return res.end();}
  fs.stat(f,(e,st)=>{if(e||!st.isFile()){res.writeHead(404);return res.end('not found');}
    res.writeHead(200,{'Content-Type':MIME[path.extname(f).toLowerCase()]||'application/octet-stream','Cache-Control':/\.(webp|png|jpg)$/.test(f)?'public, max-age=86400':'no-cache'});fs.createReadStream(f).pipe(res);});}
function readBody(req,limit){return new Promise((res,rej)=>{let b='';req.on('data',d=>{b+=d;if(b.length>limit){rej(new Error('too big'));req.destroy();}});req.on('end',()=>{try{res(JSON.parse(b||'{}'));}catch(e){rej(e);}});});}
const json=(res,o,code=200)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(o));};
const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://x');const ip=(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();
  try{
  if(u.pathname==='/api/hello')return json(res,{frostdrop:2,now:Date.now()});
  const am=u.pathname.match(/^\/api\/(register|login|me|save|profile|logout)$/);
  if(am&&req.method==='POST'){const m=await readBody(req,am[1]==='save'?2e6:300000);return json(res,await api(am[1],m,ip));}
  const av=u.pathname.match(/^\/api\/ava\/([a-f0-9]{16})$/);
  if(av){const d=await store.get('ava:'+av[1]);if(!d){res.writeHead(404);return res.end();}const mm=d.match(/^data:(image\/\w+);base64,(.*)$/);res.writeHead(200,{'Content-Type':mm[1],'Cache-Control':'public, max-age=31536000, immutable'});return res.end(Buffer.from(mm[2],'base64'));}
  if(u.pathname==='/api/events'){
    const user=await userByToken(u.searchParams.get('token'));if(!user){res.writeHead(401);return res.end();}
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write('retry: 2000\n\n');
    let c=clients.get(user.id);if(!c){c={cid:user.id,u:user,streams:new Set()};clients.set(user.id,c);}c.u=user;c.streams.add(res);
    write(res,{t:'hello',now:Date.now(),me:user.id,online:[...clients.values()].map(pub),chat:chat.slice(-50),feed:feed.slice(-15),crash:crState(),lobbies:[...lobbies.values()].map(lobPub)});
    bOnline();
    const hb=setInterval(()=>{try{res.write(': hb\n\n');}catch(e){}},20000);
    req.on('close',()=>{clearInterval(hb);c.streams.delete(res);if(!c.streams.size)setTimeout(()=>{if(!c.streams.size){clients.delete(c.cid);
      for(const l of lobbies.values())if(l.status==='open'&&l.players.some(p=>p.cid===c.cid)){if(l.owner===c.cid)closeLobby(l,'owner left');else{l.players=l.players.filter(p=>p.cid!==c.cid);bLobbies();}}
      bOnline();}},8000);});
    return;}
  if(u.pathname==='/api/send'&&req.method==='POST'){const m=await readBody(req,8000);const user=await userByToken(m.token);const c=user&&clients.get(user.id);return json(res,c?act(c,m):{err:'not connected'});}
  if(req.method!=='GET'){res.writeHead(405);return res.end();}
  serveStatic(req,res);
  }catch(e){console.error(e);if(!res.headersSent)json(res,{err:'Ошибка сервера'},500);else res.end();}
});
server.listen(PORT,HOST,()=>console.log(`FrostDrop server: http://localhost:${PORT}  storage=${store.kind}  admin=${ADMIN_EMAIL?'set':'none'}`));
