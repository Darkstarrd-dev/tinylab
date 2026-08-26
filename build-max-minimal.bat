@echo off
rem build-max-minimal.bat - wrapper for build-max-minimal.ps1
rem Full-featured (tray+webview+playground) Windows build with maximum UPX compression.
rem Usage: build-max-minimal.bat [-Fast] [-OutputDir dist]
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-max-minimal.ps1" %*
