# NetNet Intel self-run Predict bot. Build: docker build -t netnetintel-bot .
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
ENV NODE_ENV=production DATA_DIR=/data PORT=8787
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/api/state >/dev/null || exit 1
CMD ["node", "src/main.mjs"]
