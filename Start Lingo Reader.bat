@echo off
rem Double-click this file to start Lingo Reader and open it in your browser.
rem Keep this window open while you use the app; close it to stop.
cd /d "%~dp0"
start "" http://localhost:8080/
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
pause
