@echo off
REM 一键启动本地预览（Windows）
cd /d "%~dp0"
set PORT=8080
if not "%1"=="" set PORT=%1
echo >>> 启动中，请在浏览器打开: http://localhost:%PORT%
echo >>> 按 Ctrl+C 停止
python -m http.server %PORT% 2>nul || py -m http.server %PORT%
