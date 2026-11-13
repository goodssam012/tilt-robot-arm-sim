@echo off
title 기울기 로봇팔 시뮬레이터
cd /d "%~dp0"
echo.
echo   ==== 기울기 로봇팔 시뮬레이터 ====
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo   [!] Node.js 가 설치되어 있지 않아요.
  echo       잠시 후 열리는 nodejs.org 에서 LTS 버전을 설치한 뒤
  echo       이 파일을 다시 더블클릭해 주세요.
  start "" https://nodejs.org
  echo.
  pause
  exit /b 1
)
if not exist "node_modules\three\build\three.module.js" (
  echo   처음 실행이라 필요한 프로그램을 설치하고 있어요. 1~2분 걸려요...
  echo.
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo.
    echo   [!] 설치에 실패했어요. 인터넷 연결을 확인하고 다시 실행해 주세요.
    pause
    exit /b 1
  )
)
echo   시뮬레이터를 시작합니다. 잠시 후 브라우저가 열려요.
echo   이 창을 닫으면 시뮬레이터가 꺼져요.
node server.js --open
echo.
pause
