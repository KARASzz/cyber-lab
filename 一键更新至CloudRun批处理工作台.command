#!/bin/bash

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)" || exit 1
cd "$PROJECT_DIR" || exit 1

PYTHON_BIN="$(command -v python3 2>/dev/null || true)"
if [ -z "$PYTHON_BIN" ]; then
  for candidate in /usr/bin/python3 /usr/local/bin/python3 /opt/homebrew/bin/python3; do
    if [ -x "$candidate" ]; then
      PYTHON_BIN="$candidate"
      break
    fi
  done
fi

if [ -z "$PYTHON_BIN" ]; then
  echo "未检测到 Python 3。请安装 Python 3 后重试。"
  read -r -p "按回车键退出..."
  exit 1
fi

echo "正在启动 CYBER//LAB Cloud Run 本机运维工作台..."
echo "项目目录：$PROJECT_DIR"
exec "$PYTHON_BIN" "$PROJECT_DIR/cloud_run_ops_workbench.py"
