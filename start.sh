#!/usr/bin/env bash
set -e

# 获取脚本所在根目录并切换
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=================================================="
echo "   CYBER//LAB 赛博实验室 · 一键启动"
echo "=================================================="

# 检查 Node.js 环境
if ! command -v node >/dev/null 2>&1; then
  echo "❌ 错误: 未检测到 Node.js 环境，请先安装 Node.js 22+"
  exit 1
fi

# 检查并同步构建最新静态资源到 dist/
echo "📦 正在检查并同步构建最新静态资源..."
npm run build

PORT="${PORT:-8080}"
URL="http://127.0.0.1:${PORT}"

echo "🚀 正在启动 CYBER//LAB 本地服务 (端口: ${PORT})..."

# 后台等待服务就绪后自动拉起默认浏览器
(
  for i in $(seq 1 30); do
    if curl -s -o /dev/null "$URL" >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
  echo "🌐 正在为您打开浏览器: $URL"
  if command -v open >/dev/null 2>&1; then
    open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL"
  fi
) &

echo "--------------------------------------------------"
echo "✅ CYBER//LAB 已就绪！"
echo "📍 本地访问地址: $URL"
echo "🔑 门禁初始密码: 2580"
echo "💡 提示: 保持本终端窗口开启；按 Ctrl+C 即可停止服务。"
echo "--------------------------------------------------"

# 启动 Node HTTP 服务
PORT="$PORT" node cloudrun/server.mjs
