@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 보스 출현 예상 시간 타이머 서버를 시작합니다...
node server.js --open
pause
