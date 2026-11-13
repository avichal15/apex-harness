@echo off
title Apex Harness Desktop App Launcher
set "ROOT_DIR=%~dp0"
if "%ROOT_DIR:~-1%"=="\" set "ROOT_DIR=%ROOT_DIR:~0,-1%"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$port = 5199; " ^
  "$running = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue; " ^
  "if (-not $running) { " ^
  "  Start-Process -FilePath 'node' -ArgumentList '--experimental-strip-types', '%ROOT_DIR%\server\apex-app-server.ts' -WorkingDirectory '%ROOT_DIR%' -WindowStyle Hidden; " ^
  "  Start-Sleep -Milliseconds 1200; " ^
  "} " ^
  "Start-Process 'msedge.exe' -ArgumentList '--app=http://127.0.0.1:5199', '--window-size=1440,920'"
