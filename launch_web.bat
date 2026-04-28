@echo off
setlocal
cd /d "%~dp0"

powershell -ExecutionPolicy Bypass -File ".\start_server.ps1"
start "" "http://127.0.0.1:4173"
