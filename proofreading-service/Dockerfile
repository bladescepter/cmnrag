# 校对后台生产镜像：Node 22 + 固定版本 Pi SDK。
# 端口不发布到宿主公网，仅 Docker 内网（hermes-net）可达；公网一律经 Caddy TLS 反代。
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

# 生产运行参数（可在 docker run/compose 覆盖）：
#   PROOFREADING_HOST=0.0.0.0  PROOFREADING_PORT=8788
#   PROOFREADING_STATE_DIR=/app/data    （卷：任务库与诊断日志）
#   PROOFREADING_RULES_DIR=/app/rules   （bind mount：技能包，rsync 更新后重启生效）
#   密钥经挂载的 .env 提供（--env-file），权限 600，不入镜像。
ENV PROOFREADING_HOST=0.0.0.0 PROOFREADING_PORT=8788 PROOFREADING_STATE_DIR=/app/data PROOFREADING_RULES_DIR=/app/rules
RUN mkdir -p /app/data /app/rules && chown -R node:node /app
USER node
EXPOSE 8788
CMD ["node", "--env-file=/app/.env", "src/main.js"]
