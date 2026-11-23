@echo off
chcp 65001 >nul
title CYBER//LAB 赛博实验室 一键启动
cd /d "%~dp0"

echo ==================================================
echo    CYBER//LAB 赛博实验室 · 一键启动
echo ==================================================

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [X] 错误: 未检测到 Node.js 环境，请先安装 Node.js 22+
    pause
    exit /b 1
)

echo [*] 正在检查并同步构建最新静态资源...
call npm run build

set PORT=8080
set URL=http://127.0.0.1:%PORT%

echo [*] 正在准备打开默认浏览器: %URL%
start "" "%URL%"

echo --------------------------------------------------
echo [OK] CYBER//LAB 已就绪！
echo 本地访问地址: %URL%
echo 门禁初始密码: 2580
echo 提示: 保持本窗口开启；按 Ctrl+C 即可停止服务。
echo --------------------------------------------------

set PORT=%PORT%
node cloudrun/server.mjs
pause
