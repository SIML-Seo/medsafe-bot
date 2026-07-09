import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config/env.js";
import type { AppConfig } from "./config/env.js";
import { createAppServices, type AppServices } from "./app.js";
import { buildMcpServer } from "./mcpServer.js";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

class RateLimiter {
  private readonly hits = new Map<string, { windowStartedAt: number; count: number }>();

  constructor(
    private readonly windowMs: number,
    private readonly max: number
  ) {}

  allow(key: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
    if (this.max <= 0 || this.windowMs <= 0) return { ok: true };
    const now = Date.now();
    const current = this.hits.get(key);
    if (!current || now - current.windowStartedAt >= this.windowMs) {
      this.hits.set(key, { windowStartedAt: now, count: 1 });
      this.prune(now);
      return { ok: true };
    }
    current.count += 1;
    if (current.count <= this.max) return { ok: true };
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((this.windowMs - (now - current.windowStartedAt)) / 1000))
    };
  }

  private prune(now: number): void {
    for (const [key, value] of this.hits) {
      if (now - value.windowStartedAt >= this.windowMs * 2) {
        this.hits.delete(key);
      }
    }
  }
}

function hostAllowed(hostHeader: string | undefined, allowedHosts: string[]): boolean {
  if (allowedHosts.includes("*")) return true;
  if (!hostHeader) return true;
  const host = hostHeader.split(":")[0]?.toLowerCase();
  return !!host && allowedHosts.map((item) => item.toLowerCase()).includes(host);
}

function originAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (allowedOrigins.includes("*")) return true;
  if (!origin) return true;
  return allowedOrigins.includes(origin);
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json", ...headers });
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

function corsHeaders(origin: string | undefined, config: AppConfig): Record<string, string> {
  const headers: Record<string, string> = {
    vary: "Origin",
    "x-content-type-options": "nosniff",
    "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, mcp-session-id, mcp-protocol-version"
  };
  if (origin && originAllowed(origin, config.allowedOrigins)) {
    headers["access-control-allow-origin"] = origin;
  }
  return headers;
}

function requestPath(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://localhost").pathname;
}

function originHeader(req: IncomingMessage): string | undefined {
  const origin = req.headers.origin;
  return Array.isArray(origin) ? origin[0] : origin;
}

function clientKey(req: IncomingMessage, config: AppConfig): string {
  const forwarded = req.headers["x-forwarded-for"];
  const firstForwarded = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (config.trustProxy) {
    const chain = firstForwarded
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return chain?.at(-1) || req.socket.remoteAddress || "unknown";
  }
  return req.socket.remoteAddress || "unknown";
}

function assertDeploymentMode(config: AppConfig): void {
  const publicHost = config.host === "0.0.0.0" || config.host === "::";
  const production = config.nodeEnv === "production";
  if (config.dataMode === "fixture" && (publicHost || production) && !config.allowFixtureInPublic) {
    throw new Error(
      "Refusing to start fixture data mode in public/production deployment. Set DATA_MODE=live or ALLOW_FIXTURE_IN_PUBLIC=true for an explicit demo-only deployment."
    );
  }
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const contentLength = req.headers["content-length"];
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new HttpError(413, "request body too large");
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
          reject(new HttpError(400, "invalid JSON request body"));
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
  rateLimiter: RateLimiter
): Promise<void> {
  const origin = originHeader(req);
  const headers = corsHeaders(origin, config);
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }

  if (!hostAllowed(req.headers.host, config.allowedHosts)) {
    writeJson(res, 403, { error: "host not allowed" }, headers);
    return;
  }

  if (!originAllowed(origin, config.allowedOrigins)) {
    writeJson(res, 403, { error: "origin not allowed" }, headers);
    return;
  }

  if (req.method === "OPTIONS") {
    writeNoContent(res, 204, headers);
    return;
  }

  if (!["POST", "GET", "DELETE"].includes(req.method ?? "")) {
    writeJson(res, 405, { error: "method not allowed" }, headers);
    return;
  }

  const rate = rateLimiter.allow(clientKey(req, config));
  if (!rate.ok) {
    writeJson(
      res,
      429,
      { error: "rate limit exceeded" },
      { ...headers, "retry-after": String(rate.retryAfterSeconds) }
    );
    return;
  }

  let timedOut = false;
  const timeout =
    req.method === "POST"
      ? setTimeout(() => {
          timedOut = true;
          writeJson(res, 503, { error: "request timeout" }, headers);
          req.destroy();
        }, config.mcpRequestTimeoutMs)
      : null;

  try {
    const parsedBody = req.method === "POST" ? await readJsonBody(req, config.mcpBodyLimitBytes) : undefined;
    if (timedOut) return;

    const mcpServer = buildMcpServer(services);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const closeTransport = (): void => {
      void transport.close();
      void mcpServer.close();
    };
    res.on("close", closeTransport);
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof HttpError ? error.message : "Internal server error";
    if (!(error instanceof HttpError)) {
      console.error("MCP request failed", error);
    }
    if (!res.headersSent) {
      writeJson(res, status, {
        jsonrpc: "2.0",
        error: { code: status === 400 ? -32700 : -32603, message },
        id: null
      }, headers);
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  assertDeploymentMode(config);
  const services = await createAppServices(config);
  const selfTest = await services.durClient.selfTest();
  if (!selfTest.ok && config.dataMode === "live") {
    throw new Error(`DUR self-test failed: ${selfTest.message}`);
  }
  if (!selfTest.ok) {
    console.warn(`DUR self-test skipped/degraded: ${selfTest.message}`);
  }

  const rateLimiter = new RateLimiter(config.rateLimitWindowMs, config.rateLimitMax);
  const sockets = new Set<Socket>();
  const generatedAt = services.repository.metadata("generatedAt");

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = requestPath(req);
    if (path === "/healthz") {
      writeJson(res, 200, { ok: true });
      return;
    }

    if (path === "/readyz") {
      const ok = Boolean(generatedAt) && (config.dataMode === "fixture" || selfTest.ok);
      writeJson(res, ok ? 200 : 503, {
        ok,
        dataMode: config.dataMode,
        generatedAt,
        dur: selfTest.message
      });
      return;
    }

    if (path !== "/mcp") {
      writeJson(res, 404, { error: "not found" });
      return;
    }

    await handleMcpRequest(req, res, config, services, rateLimiter);
  });

  httpServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  httpServer.listen(config.port, config.host, () => {
    console.log(`medsafe-bot MCP server listening on http://${config.host}:${config.port}/mcp`);
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`received ${signal}; shutting down`);
    const forceClose = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
    }, config.shutdownTimeoutMs);
    forceClose.unref();
    httpServer.close(() => {
      clearTimeout(forceClose);
      services.repository.close();
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();
