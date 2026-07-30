@echo off
set "NODE_PATH=C:\Program Files\nodejs\node.exe"
set "NGROK_PATH=C:\Users\J0SC0M\AppData\Local\Microsoft\WinGet\Packages\Ngrok.Ngrok_Microsoft.Winget.Source_8wekyb3d8bbwe\ngrok.exe"

echo ===========================================
echo Starting ClipperIQ Studio Services
echo ===========================================
echo.

if not exist "%NODE_PATH%" (
    echo ERROR: Node.js not found at %NODE_PATH%
    pause
    exit /b 1
)

if not exist "%NGROK_PATH%" (
    echo ERROR: ngrok not found at %NGROK_PATH%
    pause
    exit /b 1
)

echo [1/3] Killing existing processes on port 3000...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000') do (
    taskkill /F /PID %%a >nul 2>&1
)
echo Port 3000 cleared
echo.

echo [2/3] Starting Node.js backend...
start "ClipperIQ Backend" cmd /k "cd /d "%~dp0server" && "%NODE_PATH%" index.js"
echo Backend started
echo.

echo [3/3] Starting ngrok tunnel...
start "Ngrok Tunnel" cmd /k "cd /d "%~dp0" && "%NGROK_PATH%" http 3000"
echo Ngrok started
echo.

echo ===========================================
echo Services are now running!
echo - Backend: http://localhost:3000
echo - Check the Ngrok window for your public URL
echo ===========================================
echo.
echo Run stop.bat to stop both services
echo.
timeout /t 3 /nobreak >nul
