@echo off
rem Installs anything missing (Node.js, Google Cloud CLI), signs in to Google Cloud,
rem then starts VM GUI. Double-click it in File Explorer.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-windows.ps1"
if errorlevel 1 pause
