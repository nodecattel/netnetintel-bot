#!/bin/bash
# Starts (or updates) the NetNet Intel bot and opens its setup page. Needs Docker Desktop.
IMAGE=ghcr.io/nodecattel/netnetintel-bot:latest
if ! docker info >/dev/null 2>&1; then
  echo "Starting Docker Desktop…"; open -a Docker
  until docker info >/dev/null 2>&1; do sleep 2; done
fi
docker pull "$IMAGE" && docker rm -f netnetintel-bot >/dev/null 2>&1
docker run -d --name netnetintel-bot --restart unless-stopped -p 127.0.0.1:8787:8787 -v netnetintel-bot-data:/data "$IMAGE" >/dev/null && sleep 3 && open http://localhost:8787
echo "The bot is running. You can close this window."
