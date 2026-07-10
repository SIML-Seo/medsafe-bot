import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import type { Socket } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config/env.js";
import type { AppConfig } from "./config/env.js";
import { createAppServices, type AppServices } from "./app.js";
import { buildMcpServer } from "./mcpServer.js";
import { computeBuildId } from "./version.js";
import {
  addressInConfiguredNetworks,
  canonicalIpAddress,
  canonicalHostHeader,
  hostAllowed,
  isLocalHost,
  isLocalOrigin,
  originAllowed,
  secureConfiguredOrigin,
  validConfiguredHost,
  validConfiguredIpNetwork,
  validConfiguredOrigin
} from "./utils/networkPolicy.js";
import {
  timestampIsValidPastOrPresent,
  timestampWithinPastWindow
} from "./utils/time.js";
import {
  CRITICAL_RELEASE_SAFETY_PROBE_COUNT,
  criticalReleaseSafetyFailures
} from "./utils/releaseProbes.js";

const BUILD_ID = computeBuildId();
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-03-26",
  "2025-06-18",
  "2025-11-25"
]);
const BATCH_PROTOCOL_VERSION = "2025-03-26";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly rpcCode = -32600
  ) {
    super(message);
  }
}

class RateLimiter {
  private readonly hits = new Map<string, { windowStartedAt: number; count: number }>();

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
    private readonly maxKeys: number
  ) {}

  allow(key: string, cost = 1): { ok: true } | { ok: false; retryAfterSeconds: number } {
    if (this.max <= 0 || this.windowMs <= 0) return { ok: true };
    const normalizedCost = Math.max(1, Math.floor(cost));
    const now = Date.now();
    const current = this.hits.get(key);
    if (!current || now - current.windowStartedAt >= this.windowMs) {
      this.prune(now);
      if (!current && this.hits.size >= this.maxKeys) {
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(this.windowMs / 1000)) };
      }
      this.hits.set(key, { windowStartedAt: now, count: normalizedCost });
      return normalizedCost <= this.max
        ? { ok: true }
        : { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(this.windowMs / 1000)) };
    }
    current.count += normalizedCost;
    if (current.count <= this.max) return { ok: true };
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((this.windowMs - (now - current.windowStartedAt)) / 1000))
    };
  }

  private prune(now: number): void {
    for (const [key, value] of this.hits) {
      if (now - value.windowStartedAt >= this.windowMs) {
        this.hits.delete(key);
      }
    }
  }
}

class ConnectionLimiter {
  private total = 0;
  private readonly perKey = new Map<string, number>();

  constructor(
    private readonly maxTotal: number,
    private readonly maxPerKey: number
  ) {}

  acquire(key: string): (() => void) | null {
    const current = this.perKey.get(key) ?? 0;
    if (this.total >= this.maxTotal || current >= this.maxPerKey) return null;
    this.total += 1;
    this.perKey.set(key, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total -= 1;
      const next = (this.perKey.get(key) ?? 1) - 1;
      if (next <= 0) this.perKey.delete(key);
      else this.perKey.set(key, next);
    };
  }
}

function acquireAcrossLimits(
  logicalLimiter: ConnectionLimiter,
  logicalKey: string,
  ingressLimiter: ConnectionLimiter,
  ingressKeyValue: string
): (() => void) | null {
  const releaseLogical = logicalLimiter.acquire(logicalKey);
  if (!releaseLogical) return null;
  const releaseIngress = ingressLimiter.acquire(ingressKeyValue);
  if (!releaseIngress) {
    releaseLogical();
    return null;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseIngress();
    releaseLogical();
  };
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers
  });
  res.end(JSON.stringify(body));
}

function writeNoContent(
  res: ServerResponse,
  status: number,
  headers: Record<string, string> = {}
): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, headers);
  res.end();
}

function closeUnreadRequestAfterResponse(req: IncomingMessage, res: ServerResponse): void {
  if (req.complete) return;
  res.setHeader("connection", "close");
  res.once("finish", () => req.socket.destroy());
  req.resume();
}

function writeRejectedJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  closeUnreadRequestAfterResponse(req, res);
  writeJson(res, status, body, headers);
}

function writeRejectedNoContent(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  headers: Record<string, string> = {}
): void {
  closeUnreadRequestAfterResponse(req, res);
  writeNoContent(res, status, headers);
}

function corsHeaders(origin: string | undefined, config: AppConfig): Record<string, string> {
  const headers: Record<string, string> = {
    vary: "Origin",
    "x-content-type-options": "nosniff",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, mcp-session-id, mcp-protocol-version"
  };
  if (origin && originAllowed(origin, config.allowedOrigins)) {
    headers["access-control-allow-origin"] = origin;
  }
  return headers;
}

function requestPath(req: IncomingMessage): string | null {
  try {
    return new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    return null;
  }
}

function originHeader(req: IncomingMessage): string | undefined {
  const origin = req.headers.origin;
  return Array.isArray(origin) ? origin[0] : origin;
}

function clientKey(req: IncomingMessage, config: AppConfig): string {
  const forwarded = req.headers["x-forwarded-for"];
  const firstForwarded = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (
    config.trustProxy &&
    config.trustProxyHops > 0 &&
    addressInConfiguredNetworks(req.socket.remoteAddress, config.trustProxyCidrs)
  ) {
    const chain = firstForwarded
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const trustedClientIndex = (chain?.length ?? 0) - config.trustProxyHops;
    return canonicalIpAddress(chain?.[trustedClientIndex]) ?? ingressKey(req);
  }
  return ingressKey(req);
}

function ingressKey(req: IncomingMessage): string {
  return canonicalIpAddress(req.socket.remoteAddress) ?? "unknown";
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(",") : value ?? "";
}

function acceptedMediaTypes(value: string | string[] | undefined): Set<string> {
  const accepted = new Set<string>();
  for (const entry of headerValue(value).split(",")) {
    const [rawType, ...rawParameters] = entry.split(";");
    const type = rawType?.trim().toLowerCase();
    if (!type) continue;
    let quality = 1;
    for (const parameter of rawParameters) {
      const [name, rawValue] = parameter.split("=", 2).map((part) => part.trim().toLowerCase());
      if (name !== "q") continue;
      const parsed = Number(rawValue);
      quality = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
    }
    if (quality > 0) accepted.add(type);
  }
  return accepted;
}

function contentMediaType(value: string | string[] | undefined): string | null {
  const raw = headerValue(value);
  if (!raw || raw.includes(",")) return null;
  return raw.split(";", 1)[0]?.trim().toLowerCase() || null;
}

function validateMcpMediaTypes(req: IncomingMessage): HttpError | null {
  const accepted = acceptedMediaTypes(req.headers.accept);
  if (req.method === "POST") {
    if (contentMediaType(req.headers["content-type"]) !== "application/json") {
      return new HttpError(415, "Content-Type must be application/json");
    }
    if (!accepted.has("application/json") || !accepted.has("text/event-stream")) {
      return new HttpError(406, "Accept must include application/json and text/event-stream");
    }
  } else if (req.method === "GET" && !accepted.has("text/event-stream")) {
    return new HttpError(406, "Accept must include text/event-stream");
  }
  return null;
}

function mcpProtocolVersion(req: IncomingMessage): string | null {
  const raw = headerValue(req.headers["mcp-protocol-version"]).trim();
  if (!raw) return null;
  if (raw.includes(",") || !SUPPORTED_PROTOCOL_VERSIONS.has(raw)) {
    throw new HttpError(400, "unsupported MCP-Protocol-Version");
  }
  return raw;
}

function jsonRpcMessageCount(
  body: unknown,
  protocolVersion: string | null,
  maxBatchItems: number
): number {
  if (!Array.isArray(body)) return 1;
  if (body.length === 0) throw new HttpError(400, "empty JSON-RPC batch is invalid");
  if (protocolVersion && protocolVersion !== BATCH_PROTOCOL_VERSION) {
    throw new HttpError(400, "JSON-RPC batching is not supported by this MCP protocol version");
  }
  if (body.length > maxBatchItems) {
    throw new HttpError(413, `JSON-RPC batch exceeds ${maxBatchItems} messages`);
  }
  return body.length;
}

function assertDeploymentMode(config: AppConfig): void {
  const publicHost = !isLocalHost(config.host);
  const production = config.nodeEnv === "production";
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  if (!config.host.trim()) throw new Error("HOST must not be empty.");
  if (config.allowedHosts.some((host) => !validConfiguredHost(host))) {
    throw new Error("ALLOWED_HOSTS contains an invalid host value.");
  }
  if (config.allowedOrigins.some((origin) => !validConfiguredOrigin(origin))) {
    throw new Error("ALLOWED_ORIGINS contains an invalid origin value.");
  }
  if (
    production &&
    (config.allowedHosts.includes("*") || config.allowedOrigins.includes("*"))
  ) {
    throw new Error("Production deployment does not allow wildcard host or origin policy.");
  }
  if (config.dataMode === "fixture" && (publicHost || production) && !config.allowFixtureInPublic) {
    throw new Error(
      "Refusing to start fixture data mode in public/production deployment. Set DATA_MODE=live or ALLOW_FIXTURE_IN_PUBLIC=true for an explicit demo-only deployment."
    );
  }
  if (production && config.dataMode !== "live") {
    throw new Error("Production deployment requires DATA_MODE=live.");
  }
  if (production && (!config.confirmationSecret || config.confirmationSecret.length < 32)) {
    throw new Error("Production deployment requires CONFIRMATION_SECRET with at least 32 characters.");
  }
  if (
    production &&
    (!config.liveSelfTestItemSeq ||
      !config.liveSelfTestTargetItemSeq ||
      !config.liveSelfTestExpectContraindication)
  ) {
    throw new Error("Production deployment requires a source+target red-case self-test.");
  }
  if (
    production &&
    publicHost &&
    config.allowedHosts.every(isLocalHost)
  ) {
    throw new Error("Public production deployment requires a non-local ALLOWED_HOSTS allowlist.");
  }
  if (
    production &&
    publicHost &&
    config.allowedOrigins.every(isLocalOrigin)
  ) {
    throw new Error("Public production deployment requires a non-local ALLOWED_ORIGINS allowlist.");
  }
  if (production && config.allowedOrigins.some((origin) => !secureConfiguredOrigin(origin))) {
    throw new Error("Production ALLOWED_ORIGINS must use HTTPS except for loopback origins.");
  }
  if (
    production &&
    (config.rateLimitWindowMs <= 0 ||
      config.rateLimitMax <= 0 ||
      config.rateLimitIngressMax <= 0)
  ) {
    throw new Error("Production rate limits must be enabled with positive values.");
  }
  if (
    production &&
    (config.mcpBodyLimitBytes < 1024 ||
      config.mcpBodyLimitBytes > 1024 * 1024 ||
      config.mcpMaxBatchItems < 1 ||
      config.mcpMaxBatchItems > 16)
  ) {
    throw new Error(
      "Production MCP body limit must be 1024..1048576 bytes and batch limit must be 1..16."
    );
  }
  if (
    production &&
    (config.mcpRequestTimeoutMs < 1000 || config.mcpRequestTimeoutMs > 120000)
  ) {
    throw new Error("Production MCP_REQUEST_TIMEOUT_MS must be between 1000 and 120000.");
  }
  if (
    production &&
    (config.mcpPostMaxInflight < 1 ||
      config.mcpPostMaxPerClient < 1 ||
      config.mcpPostMaxPerClient > config.mcpPostMaxInflight ||
      config.mcpPostMaxPerIngress < 1 ||
      config.mcpPostMaxPerIngress > config.mcpPostMaxInflight ||
      config.httpMaxConnections < 1 ||
      config.httpHeadersTimeoutMs < 1000 ||
      config.httpHeadersTimeoutMs > 120000 ||
      config.httpMaxRequestsPerSocket < 1)
  ) {
    throw new Error("Production HTTP concurrency and timeout limits are invalid.");
  }
  if (config.trustProxy && config.trustProxyHops < 1) {
    throw new Error("TRUST_PROXY=true requires TRUST_PROXY_HOPS of at least 1.");
  }
  if (
    config.trustProxy &&
    (config.trustProxyCidrs.length === 0 ||
      config.trustProxyCidrs.some((network) => !validConfiguredIpNetwork(network)))
  ) {
    throw new Error("TRUST_PROXY=true requires valid TRUST_PROXY_CIDRS entries.");
  }
}

async function readinessStatus(config: AppConfig, services: AppServices): Promise<{
  ok: boolean;
  dataMode: AppConfig["dataMode"];
  dataSource: string | null;
  dataModelVersion: string | null;
  buildId: string;
  dataSha256: string;
  generationId: string | null;
  fetchedAt: string | null;
  generatedAt: string | null;
  counts: Record<string, number>;
  coverage: {
    productIngredients: { covered: number; total: number; ratio: number };
    easyDrug: { covered: number; total: number; ratio: number };
    durSnapshots: { covered: number; total: number; ratio: number; scope: string };
    curatedDur: { covered: number; total: number; ratio: number };
    ingredientDur: { covered: number; total: number; ratio: number; scope: string };
    catalogIdentityMapping: {
      covered: number;
      total: number;
      ratio: number;
      scope: string;
    };
    activeCatalogIdentityMapping: {
      covered: number;
      total: number;
      ratio: number;
      scope: string;
    };
  };
  dur: string;
  criticalSafety: { checked: number; ok: boolean };
  reasons: string[];
}> {
  const dataSource = services.repository.metadata("source");
  const dataModelVersion = services.repository.metadata("dataModelVersion");
  const generatedAt = services.repository.metadata("generatedAt");
  const generationId = services.repository.metadata("generationId");
  const fetchedAt = services.repository.metadata("fetchedAt");
  const metadataCountKeys = [
      "productCount",
      "productApiTotalCount",
      "mfdsDurProductCount",
      "productCancelledRowCount",
      "productInvalidRowCount",
      "productDuplicateItemSeqCount",
      "ingredientCount",
      "productIngredientDurKeyCount",
      "easyDrugInfoCount",
      "easyDrugApiTotalCount",
      "easyDrugInvalidRowCount",
      "easyDrugDuplicateItemSeqCount",
      "easyDrugConflictingItemSeqCount",
      "durSnapshotCount",
      "durFindingCount",
      "durIngredientFindingCount",
      "durIngredientCatalogIdentityCount",
      "durIngredientCatalogMappedIdentityCount",
      "durIngredientCatalogUnmappedIdentityCount",
      "durIngredientActiveCatalogIdentityCount",
      "durIngredientActiveCatalogMappedIdentityCount",
      "durIngredientProductCoverageCount",
      "durIngredientAliasCount",
      "durIngredientMultiMappedAliasCount",
      "durIngredientRelationFieldCount",
      "durIngredientUnparsedRelationFieldCount",
      "durIngredientMixtureFieldCount",
      "durIngredientUnparsedMixtureFieldCount",
      "durIngredientConservativeFormMappingCount",
      "durIngredientCuratedSpellingMappingCount",
      "durIngredientAmbiguousFormMappingCount",
      "durIngredientRiskyFallbackMappingCount",
      "durIngredientCatalogAbsentMappingCount",
      "durIngredientDeclaredRelationAliasCount",
      "durIngredientUnmappedRelationAliasCount",
      "durIngredientActiveUnmappedRelationAliasCount",
      "durIngredientActiveUnmappedRelationProductCount",
      "durIngredientActiveOfficialRelationCount",
      "durIngredientActiveOfficialRelationMappedCount",
      "durIngredientDeletedRowCount",
      "durIngredientApiTotalCount",
      "durIngredientActiveRowCount",
      "durIngredientDuplicateRuleCount",
      "durIngredientMissingReasonCount",
      "productIngredientCoverageCount",
      "curatedDurProductCount",
      "aliasCount"
  ];
  const declaredCounts = Object.fromEntries(
    metadataCountKeys.map((key) => [key, Number(services.repository.metadata(key) ?? "0")])
  );
  const storedCounts = services.repository.getStoredCounts();
  const mappingBasisCounts = services.repository.getDurIngredientMappingBasisCounts();
  const counts = { ...declaredCounts, ...storedCounts };
  const productCount = counts.productCount ?? 0;
  const verifiedIngredientDurCoverage = services.repository.getDurIngredientCoverage();
  counts.durIngredientVerifiedCoverageCount = verifiedIngredientDurCoverage.coveredProducts;
  counts.durIngredientCatalogIdentityCount = verifiedIngredientDurCoverage.catalogIdentityCount;
  counts.durIngredientCatalogMappedIdentityCount =
    verifiedIngredientDurCoverage.mappedCatalogIdentityCount;
  counts.durIngredientCatalogUnmappedIdentityCount =
    verifiedIngredientDurCoverage.unmappedCatalogIdentityCount;
  const coverage = {
    productIngredients: ratioMetric(counts.productIngredientCoverageCount ?? 0, productCount),
    easyDrug: ratioMetric(counts.easyDrugInfoCount ?? 0, productCount),
    durSnapshots: {
      ...ratioMetric(counts.durSnapshotCount ?? 0, productCount),
      scope: "curated alias and evidence products only"
    },
    curatedDur: ratioMetric(
      counts.durSnapshotCount ?? 0,
      counts.curatedDurProductCount ?? 0
    ),
    ingredientDur: {
      ...ratioMetric(verifiedIngredientDurCoverage.coveredProducts, productCount),
      scope: "products whose ingredient identities are fully parsed for complete local DUR catalog lookup"
    },
    catalogIdentityMapping: {
      ...ratioMetric(
        verifiedIngredientDurCoverage.mappedCatalogIdentityCount,
        verifiedIngredientDurCoverage.catalogIdentityCount
      ),
      scope: "all DUR catalog identities represented by the current active product master; inactive historical identities remain in the catalog"
    },
    activeCatalogIdentityMapping: {
      ...ratioMetric(
        counts.durIngredientActiveCatalogMappedIdentityCount ?? 0,
        counts.durIngredientActiveCatalogIdentityCount ?? 0
      ),
      scope: "independently derived official DUR identities required by active product material relations"
    }
  };
  const dur = await services.durClient.selfTest();
  const criticalSafetyFailures =
    config.dataMode === "live"
      ? await criticalReleaseSafetyFailures(
          services.repository,
          services.safety,
          services.resolver
        )
      : [];
  const criticalSafety = {
    checked: config.dataMode === "live" ? CRITICAL_RELEASE_SAFETY_PROBE_COUNT : 0,
    ok: criticalSafetyFailures.length === 0
  };
  const reasons: string[] = [];
  if (!timestampIsValidPastOrPresent(generatedAt)) reasons.push("invalid or future generatedAt");
  if (config.dataMode === "live") {
    if (dataSource !== "PUBLIC_DATA_LIVE") reasons.push("live DB source mismatch");
    if (dataModelVersion !== "3") {
      reasons.push("live DB model version mismatch");
    }
    if (!generationId) reasons.push("live DB generation ID is missing");
    const storedCountMismatch = Object.entries(storedCounts).find(
      ([key, actual]) => declaredCounts[key] !== actual
    );
    if (storedCountMismatch) {
      reasons.push(
        `DB row-count metadata mismatch: ${storedCountMismatch[0]}=${String(declaredCounts[storedCountMismatch[0]])}/${storedCountMismatch[1]}`
      );
    }
    if (
      !timestampWithinPastWindow(
        fetchedAt,
        config.dataMaxAgeDays * 24 * 60 * 60 * 1000
      )
    ) {
      reasons.push(`live source fetchedAt is invalid, future, or older than ${config.dataMaxAgeDays} days`);
    }
    if ((counts.productCount ?? 0) < 10000) reasons.push("live product count below threshold");
    if ((counts.ingredientCount ?? 0) < 10000) reasons.push("live ingredient count below threshold");
    if ((counts.productIngredientDurKeyCount ?? 0) < (counts.ingredientCount ?? 0)) {
      reasons.push("product DUR identity relation count is incomplete");
    }
    if ((counts.easyDrugInfoCount ?? 0) < 1000) reasons.push("live e약은요 count below threshold");
    if (
      (counts.productApiTotalCount ?? -1) !==
        (counts.mfdsDurProductCount ?? -1) +
          (counts.productCancelledRowCount ?? -1) +
          (counts.productInvalidRowCount ?? -1) +
          (counts.productDuplicateItemSeqCount ?? -1) ||
      (counts.productDuplicateItemSeqCount ?? -1) !== 0
    ) {
      reasons.push("MFDS product source row reconciliation failed");
    }
    if (
      (counts.easyDrugApiTotalCount ?? -1) !==
        (counts.easyDrugInfoCount ?? -1) +
          (counts.easyDrugInvalidRowCount ?? -1) +
          (counts.easyDrugDuplicateItemSeqCount ?? -1) ||
      (counts.easyDrugConflictingItemSeqCount ?? -1) !== 0
    ) {
      reasons.push("e약은요 source row reconciliation failed");
    }
    if ((counts.curatedDurProductCount ?? 0) < 2) reasons.push("curated DUR product count below threshold");
    if ((counts.durSnapshotCount ?? 0) !== (counts.curatedDurProductCount ?? 0)) {
      reasons.push("curated DUR snapshot coverage is incomplete");
    }
    if (!services.repository.hasCompleteDurIngredientCatalog()) {
      reasons.push("DUR ingredient catalog is incomplete");
    }
    if ((counts.durIngredientFindingCount ?? 0) < 100) {
      reasons.push("DUR ingredient rule count below threshold");
    }
    if (
      (counts.durIngredientApiTotalCount ?? 0) !==
        (counts.durIngredientActiveRowCount ?? -1) +
          (counts.durIngredientDeletedRowCount ?? -1) ||
      (counts.durIngredientActiveRowCount ?? 0) !==
        (counts.durIngredientFindingCount ?? -1) +
          (counts.durIngredientDuplicateRuleCount ?? -1)
    ) {
      reasons.push("DUR ingredient source row reconciliation failed");
    }
    if (
      (counts.durIngredientProductCoverageCount ?? 0) !==
      verifiedIngredientDurCoverage.coveredProducts
    ) {
      reasons.push("DUR ingredient coverage metadata does not match verified DB coverage");
    }
    if (verifiedIngredientDurCoverage.coveredProducts < productCount * 0.8) {
      reasons.push("DUR ingredient product coverage below threshold");
    }
    const declaredCatalogIdentityCount = Number(
      services.repository.metadata("durIngredientCatalogIdentityCount") ?? "-1"
    );
    const declaredMappedCatalogIdentityCount = Number(
      services.repository.metadata("durIngredientCatalogMappedIdentityCount") ?? "-1"
    );
    const declaredUnmappedCatalogIdentityCount = Number(
      services.repository.metadata("durIngredientCatalogUnmappedIdentityCount") ?? "-1"
    );
    const declaredCatalogMappingRatio = Number(
      services.repository.metadata("durIngredientCatalogMappingRatio") ?? "-1"
    );
    const declaredActiveCatalogIdentityCount = Number(
      services.repository.metadata("durIngredientActiveCatalogIdentityCount") ?? "-1"
    );
    const declaredActiveMappedCatalogIdentityCount = Number(
      services.repository.metadata("durIngredientActiveCatalogMappedIdentityCount") ?? "-1"
    );
    const declaredActiveCatalogMappingRatio = Number(
      services.repository.metadata("durIngredientActiveCatalogMappingRatio") ?? "-1"
    );
    if (
      declaredCatalogIdentityCount !== verifiedIngredientDurCoverage.catalogIdentityCount ||
      declaredMappedCatalogIdentityCount !==
        verifiedIngredientDurCoverage.mappedCatalogIdentityCount ||
      declaredUnmappedCatalogIdentityCount !==
        verifiedIngredientDurCoverage.unmappedCatalogIdentityCount ||
      Math.abs(
        declaredCatalogMappingRatio - verifiedIngredientDurCoverage.catalogMappingRatio
      ) >= 0.000001
    ) {
      reasons.push("DUR catalog identity mapping metadata does not match verified DB coverage");
    }
    if (
      declaredActiveCatalogIdentityCount < 100 ||
      declaredActiveMappedCatalogIdentityCount !== declaredActiveCatalogIdentityCount ||
      declaredActiveCatalogMappingRatio !== 1
    ) {
      reasons.push("active-product DUR identity mapping is incomplete");
    }
    if (
      (counts.durIngredientActiveOfficialRelationCount ?? 0) < 100 ||
      (counts.durIngredientActiveOfficialRelationMappedCount ?? -1) !==
        (counts.durIngredientActiveOfficialRelationCount ?? -2)
    ) {
      reasons.push("active-product official DUR relation mapping is incomplete");
    }
    if (
      (mappingBasisCounts.FALLBACK ?? 0) !==
        (counts.durIngredientRiskyFallbackMappingCount ?? -1) ||
      (mappingBasisCounts.AMBIGUOUS_FORM ?? 0) !==
        (counts.durIngredientAmbiguousFormMappingCount ?? -1) ||
      (mappingBasisCounts.CURATED_SPELLING ?? 0) !==
        (counts.durIngredientCuratedSpellingMappingCount ?? -1) ||
      (mappingBasisCounts.CATALOG_ABSENT ?? 0) !==
        (counts.durIngredientCatalogAbsentMappingCount ?? -1)
    ) {
      reasons.push("DUR mapping-basis metadata does not match stored relations");
    }
    if (criticalSafetyFailures.length > 0) {
      reasons.push(`critical safety probes failed: ${criticalSafetyFailures.join("; ")}`);
    }
    if ((counts.durIngredientUnparsedRelationFieldCount ?? -1) !== 0) {
      reasons.push("DUR ingredient relation fields are not fully parsed");
    }
    if ((counts.durIngredientUnparsedMixtureFieldCount ?? -1) !== 0) {
      reasons.push("DUR ingredient mixture fields are not fully parsed");
    }
  } else {
    if (dataSource !== "DEMO_FIXTURE") reasons.push("fixture DB source mismatch");
    if ((counts.productCount ?? 0) < 1) reasons.push("fixture product DB is empty");
  }
  if (!dur.ok) reasons.push(dur.message);
  return {
    ok: reasons.length === 0,
    dataMode: config.dataMode,
    dataSource,
    dataModelVersion,
    buildId: BUILD_ID,
    dataSha256: services.dataSha256,
    generationId,
    fetchedAt,
    generatedAt,
    counts,
    coverage,
    dur: dur.message,
    criticalSafety,
    reasons
  };
}

function ratioMetric(covered: number, total: number): { covered: number; total: number; ratio: number } {
  return {
    covered,
    total,
    ratio: total > 0 ? Number((covered / total).toFixed(6)) : 0
  };
}

function cachedReadinessStatus(
  config: AppConfig,
  startup: Awaited<ReturnType<typeof readinessStatus>>
): Awaited<ReturnType<typeof readinessStatus>> {
  if (
    config.dataMode !== "live" ||
    timestampWithinPastWindow(
      startup.fetchedAt,
      config.dataMaxAgeDays * 24 * 60 * 60 * 1000
    )
  ) {
    return startup;
  }
  const staleReason = `live source fetchedAt is invalid, future, or older than ${config.dataMaxAgeDays} days`;
  return {
    ...startup,
    ok: false,
    reasons: Array.from(new Set([...startup.reasons, staleReason]))
  };
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const contentLength = req.headers["content-length"];
  if (contentLength) {
    if (!/^\d+$/.test(contentLength) || !Number.isSafeInteger(Number(contentLength))) {
      throw new HttpError(400, "invalid Content-Length");
    }
    if (Number(contentLength) > maxBytes) {
      throw new HttpError(413, "request body too large");
    }
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        finish(() => reject(new HttpError(413, "request body too large")));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      finish(() => {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        if (!raw) {
          resolve(undefined);
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new HttpError(400, "invalid JSON request body", -32700));
        }
      });
    });

    req.on("error", (error) => {
      finish(() => reject(error));
    });
  });
}

async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: AppConfig,
  services: AppServices,
  rateLimiter: RateLimiter,
  ingressRateLimiter: RateLimiter,
  postLimiter: ConnectionLimiter,
  postIngressLimiter: ConnectionLimiter
): Promise<void> {
  const origin = originHeader(req);
  const headers = corsHeaders(origin, config);
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
  res.setHeader("cache-control", "no-store");

  if (!hostAllowed(req.headers.host, config.allowedHosts)) {
    writeRejectedJson(req, res, 403, { error: "host not allowed" }, headers);
    return;
  }
  req.headers.host = canonicalHostHeader(req.headers.host ?? "") ?? req.headers.host;

  if (!originAllowed(origin, config.allowedOrigins)) {
    writeRejectedJson(req, res, 403, { error: "origin not allowed" }, headers);
    return;
  }

  if (req.method === "OPTIONS") {
    writeRejectedNoContent(req, res, 204, headers);
    return;
  }

  if (req.method !== "POST") {
    writeRejectedJson(req, res, 405, { error: "method not allowed" }, {
      ...headers,
      allow: "POST, OPTIONS"
    });
    return;
  }

  const mediaError = validateMcpMediaTypes(req);
  if (mediaError) {
    writeRejectedJson(req, res, mediaError.status, { error: mediaError.message }, headers);
    return;
  }

  let protocolVersion: string | null;
  try {
    protocolVersion = mcpProtocolVersion(req);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unsupported MCP protocol version";
    writeRejectedJson(req, res, 400, {
      jsonrpc: "2.0",
      error: { code: -32600, message },
      id: null
    }, headers);
    return;
  }

  const physicalKey = ingressKey(req);
  const ingress = ingressRateLimiter.allow(physicalKey);
  const logicalKey = clientKey(req, config);
  const rate = rateLimiter.allow(logicalKey);
  if (!ingress.ok || !rate.ok) {
    const retryAfterSeconds = Math.max(
      ingress.ok ? 0 : ingress.retryAfterSeconds,
      rate.ok ? 0 : rate.retryAfterSeconds
    );
    writeRejectedJson(
      req,
      res,
      429,
      { error: "rate limit exceeded" },
      { ...headers, "retry-after": String(retryAfterSeconds) }
    );
    return;
  }

  const releaseActiveRequest = acquireAcrossLimits(
    postLimiter,
    logicalKey,
    postIngressLimiter,
    physicalKey
  );
  if (!releaseActiveRequest) {
    writeRejectedJson(
      req,
      res,
      429,
      { error: "POST concurrency limit exceeded" },
      { ...headers, "retry-after": "1" }
    );
    return;
  }
  if (releaseActiveRequest) {
    res.once("close", releaseActiveRequest);
    res.once("finish", releaseActiveRequest);
  }

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    writeJson(res, 503, { error: "request timeout" }, headers);
    req.destroy();
  }, config.mcpRequestTimeoutMs);

  try {
    const parsedBody = await readJsonBody(req, config.mcpBodyLimitBytes);
    if (timedOut) return;
    const messageCount = jsonRpcMessageCount(
      parsedBody,
      protocolVersion,
      config.mcpMaxBatchItems
    );
    if (messageCount > 1) {
      const extraIngress = ingressRateLimiter.allow(physicalKey, messageCount - 1);
      const extraRate = rateLimiter.allow(logicalKey, messageCount - 1);
      if (!extraIngress.ok || !extraRate.ok) {
        const retryAfterSeconds = Math.max(
          extraIngress.ok ? 0 : extraIngress.retryAfterSeconds,
          extraRate.ok ? 0 : extraRate.retryAfterSeconds
        );
        writeRejectedJson(
          req,
          res,
          429,
          { error: "rate limit exceeded" },
          { ...headers, "retry-after": String(retryAfterSeconds) }
        );
        return;
      }
    }

    const mcpServer = buildMcpServer(services);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const closeTransport = (): void => {
      void transport.close().catch((error) => console.error("MCP transport close failed", error));
      void mcpServer.close().catch((error) => console.error("MCP server close failed", error));
    };
    res.on("close", closeTransport);
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (error) {
    if (isExpectedRequestAbort(error, req, res)) return;
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof HttpError ? error.message : "Internal server error";
    if (!(error instanceof HttpError)) {
      console.error("MCP request failed", error);
    }
    if (!res.headersSent) {
      writeRejectedJson(req, res, status, {
        jsonrpc: "2.0",
        error: { code: error instanceof HttpError ? error.rpcCode : -32603, message },
        id: null
      }, headers);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function isExpectedRequestAbort(
  error: unknown,
  req: IncomingMessage,
  res: ServerResponse
): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "ECONNRESET" &&
    (req.aborted || req.destroyed || res.destroyed)
  );
}

export interface RunningMedsafeHttpServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

export async function startMedsafeHttpServer(
  env: NodeJS.ProcessEnv = process.env,
  options: { logListening?: boolean } = {}
): Promise<RunningMedsafeHttpServer> {
  const config = loadConfig(env);
  assertDeploymentMode(config);
  const services = await createAppServices(config);
  const startupReadiness = await readinessStatus(config, services);
  if (!startupReadiness.ok) {
    services.repository.close();
    throw new Error(`Readiness validation failed: ${startupReadiness.reasons.join(", ")}`);
  }

  const rateLimiter = new RateLimiter(
    config.rateLimitWindowMs,
    config.rateLimitMax,
    config.rateLimitMaxKeys
  );
  const ingressRateLimiter = new RateLimiter(
    config.rateLimitWindowMs,
    config.rateLimitIngressMax,
    config.rateLimitMaxKeys
  );
  const postLimiter = new ConnectionLimiter(
    config.mcpPostMaxInflight,
    config.mcpPostMaxPerClient
  );
  const postIngressLimiter = new ConnectionLimiter(
    config.mcpPostMaxInflight,
    config.mcpPostMaxPerIngress
  );
  const probeRateLimiter = new RateLimiter(
    config.rateLimitWindowMs,
    config.rateLimitIngressMax,
    config.rateLimitMaxKeys
  );
  const sockets = new Set<Socket>();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = requestPath(req);
    if (path === null) {
      writeRejectedJson(req, res, 400, { error: "invalid request target" });
      return;
    }
    if (path === "/healthz" || path === "/readyz") {
      const origin = originHeader(req);
      const headers = corsHeaders(origin, config);
      if (!hostAllowed(req.headers.host, config.allowedHosts)) {
        writeRejectedJson(req, res, 403, { error: "host not allowed" }, headers);
        return;
      }
      if (!originAllowed(origin, config.allowedOrigins)) {
        writeRejectedJson(req, res, 403, { error: "origin not allowed" }, headers);
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        writeRejectedJson(req, res, 405, { error: "method not allowed" }, {
          ...headers,
          allow: "GET, HEAD"
        });
        return;
      }
      const probeRate = probeRateLimiter.allow(ingressKey(req));
      if (!probeRate.ok) {
        writeRejectedJson(req, res, 429, { error: "rate limit exceeded" }, {
          ...headers,
          "retry-after": String(probeRate.retryAfterSeconds)
        });
        return;
      }
      if (path === "/healthz") {
        writeJson(res, 200, { ok: true }, headers);
        return;
      }
      const readiness = cachedReadinessStatus(config, startupReadiness);
      writeJson(res, readiness.ok ? 200 : 503, readiness, headers);
      return;
    }

    if (path !== "/mcp") {
      writeRejectedJson(req, res, 404, { error: "not found" });
      return;
    }

    await handleMcpRequest(
      req,
      res,
      config,
      services,
      rateLimiter,
      ingressRateLimiter,
      postLimiter,
      postIngressLimiter
    );
  });

  httpServer.maxConnections = config.httpMaxConnections;
  httpServer.headersTimeout = config.httpHeadersTimeoutMs;
  httpServer.requestTimeout = Math.max(
    config.httpHeadersTimeoutMs,
    config.mcpRequestTimeoutMs + 1000
  );
  httpServer.maxRequestsPerSocket = config.httpMaxRequestsPerSocket;
  httpServer.maxHeadersCount = 64;
  httpServer.keepAliveTimeout = 5000;

  httpServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolveListening, reject) => {
    const onError = (error: Error): void => {
      httpServer.off("listening", onListening);
      services.repository.close();
      reject(error);
    };
    const onListening = (): void => {
      httpServer.off("error", onError);
      resolveListening();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(config.port, config.host);
  });

  const address = httpServer.address();
  const listeningPort = typeof address === "object" && address ? address.port : config.port;
  if (options.logListening !== false) {
    console.log(`medsafe-bot MCP server listening on http://${config.host}:${listeningPort}/mcp`);
  }

  let closePromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closePromise ??= new Promise<void>((resolveClose) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(forceClose);
        services.repository.close();
        resolveClose();
      };
      const forceClose = setTimeout(() => {
        for (const socket of sockets) socket.destroy();
        finish();
      }, config.shutdownTimeoutMs);
      forceClose.unref();

      if (!httpServer.listening) {
        finish();
        return;
      }
      httpServer.close(finish);
      httpServer.closeIdleConnections();
    });
    return closePromise;
  };

  return { server: httpServer, port: listeningPort, close };
}

async function main(): Promise<void> {
  const running = await startMedsafeHttpServer(process.env, { logListening: true });
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`received ${signal}; shutting down`);
    void running.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint && pathToFileURL(resolve(entrypoint)).href === import.meta.url);
}

if (isMainModule()) {
  process.on("uncaughtException", (error) => {
    console.error("uncaught exception", error);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("unhandled rejection", reason);
    process.exit(1);
  });

  await main();
}
