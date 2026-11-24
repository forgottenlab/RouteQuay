@echo off
node "%~dp0apps\cli\src\vpncp.ts" %*
exit /b %errorlevel%
