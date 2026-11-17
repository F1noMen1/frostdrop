@echo off
cd /d "%~dp0"
title FrostDrop server
start "" http://localhost:8800
node server\server.js
pause
