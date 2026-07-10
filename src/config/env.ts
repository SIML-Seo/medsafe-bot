export interface AppConfig {
  nodeEnv: string;
  host: string;
  port: number;
  dataMode: "fixture" | "live";
  allowFixtureInPublic: boolean;
  masterDbPath: string;
  mfdsServiceKey: string | null;
  liveSelfTestItemSeq: string | null;
  liveSelfTestTargetItemSeq: string | null;
  liveSelfTestExpectContraindication: boolean;
  confirmationSecret: string | null;
  durTimeoutMs: number;
  durSelfTestTimeoutMs: number;
  durMaxRetries: number;
  durMaxPages: number;
  durCacheTtlMs: number;
  durCacheMaxEntries: number;
  durBaseDate: string;
  dataMaxAgeDays: number;
  mcpBodyLimitBytes: number;
  mcpMaxBatchItems: number;
  mcpRequestTimeoutMs: number;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  rateLimitIngressMax: number;
  rateLimitMaxKeys: number;
  mcpPostMaxInflight: number;
  mcpPostMaxPerClient: number;
  mcpPostMaxPerIngress: number;
  httpMaxConnections: number;
  httpHeadersTimeoutMs: number;
  httpMaxRequestsPerSocket: number;
  shutdownTimeoutMs: number;
  trustProxy: boolean;
  trustProxyHops: number;
  trustProxyCidrs: string[];
  allowedHosts: string[];
  allowedOrigins: string[];
}

function csv(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function numberValue(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const trustProxy = env.TRUST_PROXY === "true";
  const dataMode = env.DATA_MODE === "live" ? "live" : "fixture";
  const rateLimitMax = numberValue(env.RATE_LIMIT_MAX, 60);
  const mcpPostMaxInflight = Math.max(1, Math.floor(numberValue(env.MCP_POST_MAX_INFLIGHT, 100)));
  return {
    nodeEnv: env.NODE_ENV ?? "development",
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? "3000"),
    dataMode,
    allowFixtureInPublic: env.ALLOW_FIXTURE_IN_PUBLIC === "true",
    masterDbPath:
      env.MASTER_DB_PATH ??
      (dataMode === "live" ? "data/master.sqlite" : "data/master.fixture.sqlite"),
    mfdsServiceKey: env.MFDS_SERVICE_KEY?.trim() || null,
    liveSelfTestItemSeq: env.LIVE_SELF_TEST_ITEM_SEQ?.trim() || null,
    liveSelfTestTargetItemSeq: env.LIVE_SELF_TEST_TARGET_ITEM_SEQ?.trim() || null,
    liveSelfTestExpectContraindication: env.LIVE_SELF_TEST_EXPECT_CONTRAINDICATION === "true",
    confirmationSecret: env.CONFIRMATION_SECRET?.trim() || null,
    durTimeoutMs: numberValue(env.DUR_TIMEOUT_MS, 2500),
    durSelfTestTimeoutMs: numberValue(env.DUR_SELF_TEST_TIMEOUT_MS, 12000),
    durMaxRetries: numberValue(env.DUR_MAX_RETRIES, 0),
    durMaxPages: numberValue(env.DUR_MAX_PAGES, 20),
    durCacheTtlMs: numberValue(env.DUR_CACHE_TTL_MS, 600000),
    durCacheMaxEntries: Math.max(1, numberValue(env.DUR_CACHE_MAX_ENTRIES, 5000)),
    durBaseDate: env.DUR_BASE_DATE ?? "2026-07-01",
    dataMaxAgeDays: Math.max(1, numberValue(env.DATA_MAX_AGE_DAYS, 30)),
    mcpBodyLimitBytes: numberValue(env.MCP_BODY_LIMIT_BYTES, 65536),
    mcpMaxBatchItems: Math.max(
      1,
      Math.floor(numberValue(env.MCP_MAX_BATCH_ITEMS, 8))
    ),
    mcpRequestTimeoutMs: numberValue(env.MCP_REQUEST_TIMEOUT_MS, 30000),
    rateLimitWindowMs: numberValue(env.RATE_LIMIT_WINDOW_MS, 60000),
    rateLimitMax,
    rateLimitIngressMax: numberValue(env.RATE_LIMIT_INGRESS_MAX, rateLimitMax),
    rateLimitMaxKeys: Math.max(1, numberValue(env.RATE_LIMIT_MAX_KEYS, 10000)),
    mcpPostMaxInflight,
    mcpPostMaxPerClient: Math.min(
      mcpPostMaxInflight,
      Math.max(1, Math.floor(numberValue(env.MCP_POST_MAX_PER_CLIENT, 10)))
    ),
    mcpPostMaxPerIngress: Math.min(
      mcpPostMaxInflight,
      Math.max(1, Math.floor(numberValue(env.MCP_POST_MAX_PER_INGRESS, 50)))
    ),
    httpMaxConnections: Math.max(
      1,
      Math.floor(numberValue(env.HTTP_MAX_CONNECTIONS, 500))
    ),
    httpHeadersTimeoutMs: Math.max(
      1000,
      Math.floor(numberValue(env.HTTP_HEADERS_TIMEOUT_MS, 10000))
    ),
    httpMaxRequestsPerSocket: Math.max(
      1,
      Math.floor(numberValue(env.HTTP_MAX_REQUESTS_PER_SOCKET, 1000))
    ),
    shutdownTimeoutMs: numberValue(env.SHUTDOWN_TIMEOUT_MS, 5000),
    trustProxy,
    trustProxyHops: Math.max(
      0,
      numberValue(env.TRUST_PROXY_HOPS, trustProxy ? 1 : 0)
    ),
    trustProxyCidrs: csv(env.TRUST_PROXY_CIDRS, []),
    allowedHosts: csv(env.ALLOWED_HOSTS, ["localhost", "127.0.0.1"]),
    allowedOrigins: csv(env.ALLOWED_ORIGINS, ["http://localhost:3000", "http://127.0.0.1:3000"])
  };
}
