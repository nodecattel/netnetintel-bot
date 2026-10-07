@echo off
rem Starts (or updates) the NetNet Intel bot and opens its setup page. Needs Docker Desktop, running.
set IMAGE=ghcr.io/nodecattel/netnetintel-bot:latest
docker info >nul 2>&1 || (echo Open Docker Desktop first, wait until it says it is running, then run this again. & pause & exit /b 1)
docker pull %IMAGE% || (pause & exit /b 1)
docker rm -f netnetintel-bot >nul 2>&1
docker run -d --name netnetintel-bot --restart unless-stopped -p 127.0.0.1:8787:8787 -v netnetintel-bot-data:/data %IMAGE% || (pause & exit /b 1)
timeout /t 3 >nul
start http://localhost:8787
echo The bot is running. You can close this window.
pause
