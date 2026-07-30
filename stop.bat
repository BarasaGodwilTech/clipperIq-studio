@echo off
echo ===========================================
echo Stopping ClipperIQ Studio Services
echo ===========================================
echo.

echo [1/2] Stopping Node.js backend...
taskkill /F /IM node.exe >nul 2>&1
echo Node.js processes stopped
echo.

echo [2/2] Stopping ngrok...
taskkill /F /IM ngrok.exe >nul 2>&1
echo Ngrok processes stopped
echo.

echo ===========================================
echo All services stopped successfully
echo ===========================================
echo.
timeout /t 2 /nobreak >nul
