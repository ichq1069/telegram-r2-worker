#!/bin/bash
# PicWall Relay 一键部署脚本
# 用法: curl -sL https://your-server/install.sh | bash -s -- --port 18088 --api-key your-secret
# 或下载后: bash install.sh --port 18088 --api-key your-secret

set -e

PORT="${PORT:-18088}"
API_KEY="${API_KEY:-teleup2026}"
INSTALL_DIR="/opt/picwall-relay"

# 解析参数
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --api-key) API_KEY="$2"; shift 2 ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    *) shift ;;
  esac
done

echo "=== PicWall Relay 安装 ==="
echo "端口: $PORT"
echo "目录: $INSTALL_DIR"

# 安装依赖
apt-get update -qq && apt-get install -y -qq python3 python3-pip > /dev/null 2>&1 || true

# 创建目录
mkdir -p "$INSTALL_DIR"

# 下载 relay.py（如果本地没有则从当前目录复制）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/relay.py" ]; then
  cp "$SCRIPT_DIR/relay.py" "$INSTALL_DIR/relay.py"
elif [ -f "$SCRIPT_DIR/relay/relay.py" ]; then
  cp "$SCRIPT_DIR/relay/relay.py" "$INSTALL_DIR/relay.py"
else
  echo "错误: 找不到 relay.py，请在项目根目录运行此脚本"
  exit 1
fi

# 安装 Python 依赖
pip3 install -q aiohttp 2>/dev/null || pip3 install -q --break-system-packages aiohttp

# 创建 systemd 服务
cat > /etc/systemd/system/picwall-relay.service << EOF
[Unit]
Description=PicWall Relay Server
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
Environment=PORT=$PORT
Environment=API_KEY=$API_KEY
ExecStart=$(which python3) $INSTALL_DIR/relay.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable picwall-relay
systemctl restart picwall-relay

echo ""
echo "=== 安装完成 ==="
echo "服务状态: systemctl status picwall-relay"
echo "健康检查: curl http://localhost:$PORT/relay/health"
echo "API Key: ${API_KEY:-teleup2026 (默认)})"
echo ""
echo "Worker 环境变量配置:"
echo "  RELAY_URL=http://你的服务器IP:$PORT"
echo "  RELAY_KEY=$API_KEY"
