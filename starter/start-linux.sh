#!/bin/sh
# Starts (or updates) the NetNet Intel bot and opens its setup page. Needs Docker Engine.
set -e
IMAGE=ghcr.io/nodecattel/netnetintel-bot:latest
docker pull "$IMAGE"
docker rm -f netnetintel-bot >/dev/null 2>&1 || true
docker run -d --name netnetintel-bot --restart unless-stopped -p 127.0.0.1:8787:8787 -v netnetintel-bot-data:/data "$IMAGE" >/dev/null
sleep 3; (xdg-open http://localhost:8787 >/dev/null 2>&1 &) || true
echo "Setup page: http://localhost:8787"
