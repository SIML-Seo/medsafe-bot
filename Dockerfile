# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATA_MODE=live
ENV MASTER_DB_PATH=data/master.sqlite
ENV LIVE_SELF_TEST_ITEM_SEQ=199701294
ENV LIVE_SELF_TEST_EXPECT_CONTRAINDICATION=true
ENV DUR_TIMEOUT_MS=2500
ENV DUR_SELF_TEST_TIMEOUT_MS=12000
ENV DUR_MAX_RETRIES=0
ENV RATE_LIMIT_MAX=300
ENV ALLOWED_HOSTS=*
ENV ALLOWED_ORIGINS=https://playmcp.kakao.com,https://playmcp.kakaocloud.io

COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY data/master.sqlite ./data/master.sqlite

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "start"]
