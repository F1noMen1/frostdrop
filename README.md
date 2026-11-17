# FrostDrop

Симулятор открытия кейсов CS2 с друзьями: кейсы, апгрейд, контракт, зимний краш, лесенка, кейс-баттлы, онлайн-чат.
Весь баланс виртуальный.

## Запуск у себя
`start_server.bat` (или `npm start`) → http://localhost:8800

## Деплой на Render (бесплатно)
1. Залей эту папку в репозиторий на GitHub.
2. https://upstash.com → Create Database (Redis, Free) → вкладка **REST API** → скопируй `UPSTASH_REDIS_REST_URL` и `UPSTASH_REDIS_REST_TOKEN`.
   Без этой базы аккаунты на Render сотрутся при каждом перезапуске.
3. https://render.com → New → **Blueprint** → выбери репозиторий (Render прочитает `render.yaml`).
4. В переменных окружения укажи:
   - `ADMIN_EMAIL` — почта, у которой будет админка;
   - `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` — из шага 2.
5. Deploy → получишь ссылку вида `https://frostdrop.onrender.com` — кидай друзьям.

На бесплатном тарифе сервер засыпает без игроков, первый заход после сна ~30 секунд.
