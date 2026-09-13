#!/bin/bash
# PicWall Relay 一键部署脚本
# 用法:
#   curl -sL https://raw.githubusercontent.com/ichq1069/telegram-r2-worker/main/relay/install.sh | bash
#   或: bash install.sh --port 18088 --api-key teleup2026

set -e

PORT="${PORT:-18088}"
API_KEY="${API_KEY:-teleup2026}"
REPO="ichq1069/telegram-r2-worker"
BRANCH="main"

# 解析参数
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --api-key) API_KEY="$2"; shift 2 ;;
    *) shift ;;
  esac
done

echo "=== PicWall Relay 安装 ==="
echo "端口: $PORT"
echo "API Key: $API_KEY"

# 检查 Docker
if ! command -v docker &> /dev/null; then
  echo "Docker 未安装，正在安装..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
fi

# 创建临时目录
TMPDIR=$(mktemp -d)
cd "$TMPDIR"

# 下载 relay 文件
echo "下载 relay 文件..."
curl -sL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/relay/relay.py" -o relay.py
curl -sL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/relay/requirements.txt" -o requirements.txt
curl -sL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/relay/Dockerfile" -o Dockerfile
curl -sL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/relay/docker-compose.yml" -o docker-compose.yml

# 替换 docker-compose.yml 中的端口和 API_KEY
sed -i "s/18088:18088/${PORT}:18088/g" docker-compose.yml
sed -i "s/API_KEY=teleup2026/API_KEY=${API_KEY}/g" docker-compose.yml

# 构建并启动
echo "构建 Docker 镜像..."
docker build -t picwall-relay .

echo "启动容器..."
docker rm -f picwall-relay 2>/dev/null || true
docker run -d \
  --name picwall-relay \
  --restart unless-stopped \
  -p ${PORT}:18088 \
  -e PORT=18088 \
  -e API_KEY=${API_KEY} \
  picwall-relay

# 清理
cd /
rm -rf "$TMPDIR"

echo ""
echo "=== 部署完成 ==="
echo "容器状态: docker ps | grep picwall-relay"
echo "健康检查: curl http://localhost:${PORT}/relay/health"
echo "日志查看: docker logs -f picwall-relay"
echo ""
echo "Worker 环境变量配置:"
echo "  RELAY_URL=http://你的服务器IP:${PORT}"
echo "  RELAY_KEY=${API_KEY}"
