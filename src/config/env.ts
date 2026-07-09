export interface AppConfig {
  nodeEnv: string;
  host: string;
  port: number;
  dataMode: "fixture" | "live";
  allowFixtureInPublic: boolean;
  masterDbPath: string;
  mfdsServiceKey: string | null;
  liveSelfTestItemSeq: string | null;
  liveSelfTestExpectContraindication: boolean;
  confirmationSecret: string | null;
  durTimeoutMs: number;
  durSelfTestTimeoutMs: number;
  durMaxRetries: number;
  durMaxPages: number;
  durCacheTtlMs: number;
  durBaseDate: string;
  mcpBodyLimitBytes: number;
  mcpRequestTimeoutMs: number;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  shutdownTimeoutMs: number;
  trustProxy: boolean;
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
  return {
    nodeEnv: env.NODE_ENV ?? "development",
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? "3000"),
    dataMode: env.DATA_MODE === "live" ? "live" : "fixture",
    allowFixtureInPublic: env.ALLOW_FIXTURE_IN_PUBLIC === "true",
    masterDbPath: env.MASTER_DB_PATH ?? "data/master.sqlite",
    mfdsServiceKey: env.MFDS_SERVICE_KEY?.trim() || null,
    liveSelfTestItemSeq: env.LIVE_SELF_TEST_ITEM_SEQ?.trim() || null,
    liveSelfTestExpectContraindication: env.LIVE_SELF_TEST_EXPECT_CONTRAINDICATION === "true",
    confirmationSecret: env.CONFIRMATION_SECRET?.trim() || null,
    durTimeoutMs: numberValue(env.DUR_TIMEOUT_MS, 2500),
    durSelfTestTimeoutMs: numberValue(env.DUR_SELF_TEST_TIMEOUT_MS, 12000),
    durMaxRetries: numberValue(env.DUR_MAX_RETRIES, 0),
    durMaxPages: numberValue(env.DUR_MAX_PAGES, 20),
    durCacheTtlMs: numberValue(env.DUR_CACHE_TTL_MS, 600000),
    durBaseDate: env.DUR_BASE_DATE ?? "2026-07-01",
    mcpBodyLimitBytes: numberValue(env.MCP_BODY_LIMIT_BYTES, 65536),
    mcpRequestTimeoutMs: numberValue(env.MCP_REQUEST_TIMEOUT_MS, 30000),
    rateLimitWindowMs: numberValue(env.RATE_LIMIT_WINDOW_MS, 60000),
    rateLimitMax: numberValue(env.RATE_LIMIT_MAX, 60),
    shutdownTimeoutMs: numberValue(env.SHUTDOWN_TIMEOUT_MS, 5000),
    trustProxy: env.TRUST_PROXY === "true",
    allowedHosts: csv(env.ALLOWED_HOSTS, ["localhost", "127.0.0.1"]),
    allowedOrigins: csv(env.ALLOWED_ORIGINS, ["http://localhost:3000", "http://127.0.0.1:3000"])
  };
}
