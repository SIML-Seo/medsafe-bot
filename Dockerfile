# syntax=docker/dockerfile:1

FROM node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752 AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752 AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATA_MODE=live
ENV MASTER_DB_PATH=data/master.sqlite
ENV LIVE_SELF_TEST_ITEM_SEQ=200108429
ENV LIVE_SELF_TEST_TARGET_ITEM_SEQ=197900145
ENV LIVE_SELF_TEST_EXPECT_CONTRAINDICATION=true
ENV DUR_TIMEOUT_MS=2500
ENV DUR_SELF_TEST_TIMEOUT_MS=12000
ENV DUR_MAX_RETRIES=0
ENV RATE_LIMIT_MAX=600
ENV RATE_LIMIT_INGRESS_MAX=6000
ENV RATE_LIMIT_MAX_KEYS=10000
ENV MCP_MAX_BATCH_ITEMS=8
ENV MCP_POST_MAX_INFLIGHT=100
ENV MCP_POST_MAX_PER_CLIENT=10
ENV MCP_POST_MAX_PER_INGRESS=50
ENV HTTP_MAX_CONNECTIONS=500
ENV HTTP_HEADERS_TIMEOUT_MS=10000
ENV HTTP_MAX_REQUESTS_PER_SOCKET=1000
ENV TRUST_PROXY=false
ENV TRUST_PROXY_HOPS=0
ENV TRUST_PROXY_CIDRS=""
ENV ALLOWED_HOSTS=medsafe-bot.playmcp-endpoint.kakaocloud.io,localhost,127.0.0.1
ENV ALLOWED_ORIGINS=https://playmcp.kakao.com,https://playmcp.kakaocloud.io

COPY package.json package-lock.json ./
COPY Dockerfile ./Dockerfile
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY data/master.sqlite ./data/master.sqlite

RUN chmod -R a-w /app && chmod -R a+rX /app

EXPOSE 3000

STOPSIGNAL SIGTERM

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/readyz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "dist/src/server.js"]
