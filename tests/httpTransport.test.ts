import test from "node:test";
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { defaultMaxListeners, once, setMaxListeners } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import initSqlJs from "sql.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMedsafeHttpServer } from "../src/server.js";
import {
  addressInConfiguredNetworks,
  validConfiguredIpNetwork
} from "../src/utils/networkPolicy.js";

const MCP_POST_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream"
};
const TEST_PORT_BASE = randomInt(10_000, 50_000);

function testPort(seed: number): number {
  return 10_000 + ((TEST_PORT_BASE + seed) % 50_000);
}

async function startServer(
  port: number,
  extraEnv: Record<string, string> = {}
): Promise<{ close: () => Promise<void> }> {
  const running = await startMedsafeHttpServer(
    {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_MODE: "fixture",
      ...extraEnv
    },
    { logListening: false }
  );
  return { close: running.close };
}

function openSlowPost(
  port: number,
  headers: Record<string, string> = {}
): { close: () => void } {
  const req = httpRequest({
    host: "127.0.0.1",
    port,
    path: "/mcp",
    method: "POST",
    headers: { ...MCP_POST_HEADERS, ...headers }
  });
  req.on("response", (res) => res.resume());
  req.on("error", () => undefined);
  req.write('{"jsonrpc":');
  return { close: () => req.destroy() };
}

function openRejectedSlowPost(
  port: number
): Promise<{ status: number; closed: Promise<void>; close: () => void }> {
  return new Promise((resolve, reject) => {
    let closeRequest = (): void => undefined;
    const closed = new Promise<void>((complete) => {
      closeRequest = complete;
    });
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      headers: {
        "content-type": "text/plain",
        accept: "application/json, text/event-stream",
        "content-length": "1000000"
      }
    });
    req.once("response", (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, closed, close: () => req.destroy() });
    });
    req.once("close", closeRequest);
    req.once("error", reject);
    req.flushHeaders();
  });
}

function postJsonStatus(
  port: number,
  path: string,
  headers: Record<string, string>,
  body: string
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "POST", headers: { ...MCP_POST_HEADERS, ...headers } },
      (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

function rawRequest(
  port: number,
  method: string,
  headers: Record<string, string> = {},
  body?: string
): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/mcp", method, headers }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, headers: res.headers });
    });
    req.on("error", reject);
    req.end(body);
  });
}

function postJsonResponse(
  port: number,
  body: Record<string, unknown>
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: MCP_POST_HEADERS
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const raw = Buffer.concat(chunks).toString("utf8");
            const dataLine = raw
              .split(/\r?\n/)
              .find((line) => line.startsWith("data:"));
            resolve({
              status: res.statusCode ?? 0,
              json: JSON.parse(dataLine ? dataLine.slice(5).trim() : raw) as Record<string, unknown>
            });
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

test("Streamable HTTP server supports tools/list and tools/call", async () => {
  const port = testPort(3137);
  const server = await startServer(port);
  const client = new Client({ name: "http-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "check_medication_safety"));
    const response = await client.callTool({
      name: "resolve_medications",
      arguments: { queries: ["게보린"] }
    });
    const content = response.content as Array<{ type: string; text?: string }>;
    assert.match(content[0]?.text ?? "", /게보린/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("default socket request budget supports a full release verification session", async () => {
  const port = testPort(3155);
  const server = await startServer(port, {
    RATE_LIMIT_MAX: "500",
    RATE_LIMIT_INGRESS_MAX: "500"
  });
  const client = new Client({ name: "long-session-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  setMaxListeners(0);

  try {
    await client.connect(transport);
    for (let index = 0; index < 120; index += 1) {
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 3);
    }
  } finally {
    setMaxListeners(defaultMaxListeners);
    await client.close();
    await server.close();
  }
});

test("Streamable HTTP negotiates every PlayMCP-supported protocol version", async () => {
  const port = testPort(3154);
  const server = await startServer(port);
  try {
    for (const protocolVersion of ["2025-03-26", "2025-06-18", "2025-11-25"]) {
      const response = await postJsonResponse(port, {
        jsonrpc: "2.0",
        id: protocolVersion,
        method: "initialize",
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: "playmcp-version-test", version: "1.0.0" }
        }
      });
      assert.equal(response.status, 200);
      const result = response.json.result as { protocolVersion?: string } | undefined;
      assert.equal(result?.protocolVersion, protocolVersion);
      assert.equal(
        await postJsonStatus(
          port,
          "/mcp",
          { "mcp-protocol-version": protocolVersion },
          JSON.stringify({ jsonrpc: "2.0", id: `${protocolVersion}-ping`, method: "ping" })
        ),
        200
      );
    }
  } finally {
    await server.close();
  }
});

test("MCP host and origin allowlists support explicit wildcard deployment mode", async () => {
  const port = testPort(3143);
  const server = await startServer(port, { ALLOWED_HOSTS: "*", ALLOWED_ORIGINS: "*" });
  try {
    const status = await postJsonStatus(
      port,
      "/mcp",
      {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        host: "issued-playmcp-endpoint.example",
        origin: "https://playmcp.kakao.com"
      },
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    );
    assert.equal(status, 200);
  } finally {
    await server.close();
  }
});

test("MCP host allowlist accepts bracketed IPv6 and rejects malformed authorities", async () => {
  const port = testPort(3146);
  const server = await startServer(port, { ALLOWED_HOSTS: "::1,127.0.0.1" });
  try {
    assert.equal(
      await postJsonStatus(
        port,
        "/mcp",
        { Host: `[::1]:${port}`, "content-type": "application/json" },
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })
      ),
      200
    );
    assert.equal(
      await postJsonStatus(
        port,
        "/mcp",
        { Host: `[0:0:0:0:0:0:0:1]:${port}`, "content-type": "application/json" },
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })
      ),
      200
    );
    for (const malformedHost of [
      "evil.example@127.0.0.1",
      "[not-ipv6]:80",
      "[::1]x80",
      "[::1]:0",
      "[::1]:65536"
    ]) {
      assert.equal(
        await postJsonStatus(
          port,
          "/mcp",
          { Host: malformedHost, "content-type": "application/json" },
          JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })
        ),
        403
      );
    }
  } finally {
    await server.close();
  }
});

test("HTTP server exposes health/readiness and rejects oversized MCP bodies", async () => {
  const port = testPort(3139);
  const server = await startServer(port, { MCP_BODY_LIMIT_BYTES: "64" });
  try {
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
    assert.equal(ready.status, 200);
    const readyBody = (await ready.json()) as Record<string, unknown>;
    assert.equal(readyBody.dataSource, "DEMO_FIXTURE");

    const tooLarge = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: MCP_POST_HEADERS,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "resolve_medications", arguments: { queries: ["타이레놀".repeat(100)] } }
      })
    });
    assert.equal(tooLarge.status, 413);
  } finally {
    await server.close();
  }
});

test("HTTP server rate-limits MCP requests before tool execution", async () => {
  const port = testPort(3140);
  const server = await startServer(port, { RATE_LIMIT_MAX: "1", RATE_LIMIT_WINDOW_MS: "10000" });
  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const first = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: MCP_POST_HEADERS,
      body
    });
    assert.notEqual(first.status, 429);

    const second = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: MCP_POST_HEADERS,
      body
    });
    assert.equal(second.status, 429);
  } finally {
    await server.close();
  }
});

test("trusted proxy mode does not use spoofed leftmost X-Forwarded-For value", async () => {
  const port = testPort(3142);
  const server = await startServer(port, {
    TRUST_PROXY: "true",
    TRUST_PROXY_CIDRS: "127.0.0.0/8",
    RATE_LIMIT_MAX: "1",
    RATE_LIMIT_WINDOW_MS: "10000"
  });
  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const first = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { ...MCP_POST_HEADERS, "x-forwarded-for": "203.0.113.10, 10.0.0.5" },
      body
    });
    assert.notEqual(first.status, 429);

    const second = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { ...MCP_POST_HEADERS, "x-forwarded-for": "198.51.100.20, 10.0.0.5" },
      body
    });
    assert.equal(second.status, 429);
  } finally {
    await server.close();
  }
});

test("trusted proxy mode canonicalizes equivalent IPv6 client addresses", async () => {
  const port = testPort(3156);
  const server = await startServer(port, {
    TRUST_PROXY: "true",
    TRUST_PROXY_CIDRS: "127.0.0.0/8",
    RATE_LIMIT_MAX: "1",
    RATE_LIMIT_INGRESS_MAX: "10",
    RATE_LIMIT_WINDOW_MS: "10000"
  });
  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const first = await postJsonStatus(
      port,
      "/mcp",
      { "x-forwarded-for": "2001:0db8:0:0:0:0:0:1" },
      body
    );
    const second = await postJsonStatus(
      port,
      "/mcp",
      { "x-forwarded-for": "2001:db8::1" },
      body
    );
    assert.equal(first, 200);
    assert.equal(second, 429);
  } finally {
    await server.close();
  }
});

test("trusted proxy mode ignores XFF from an untrusted direct peer", async () => {
  const port = testPort(3161);
  const server = await startServer(port, {
    TRUST_PROXY: "true",
    TRUST_PROXY_CIDRS: "10.0.0.0/8",
    RATE_LIMIT_MAX: "1",
    RATE_LIMIT_INGRESS_MAX: "10",
    RATE_LIMIT_WINDOW_MS: "10000"
  });
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  try {
    assert.equal(
      await postJsonStatus(port, "/mcp", { "x-forwarded-for": "203.0.113.1" }, body),
      200
    );
    assert.equal(
      await postJsonStatus(port, "/mcp", { "x-forwarded-for": "198.51.100.2" }, body),
      429
    );
  } finally {
    await server.close();
  }
});

test("trusted proxy CIDR validation handles IPv4, mapped IPv4, and IPv6", () => {
  const networks = ["10.0.0.0/8", "2001:db8::/32"];
  assert.equal(validConfiguredIpNetwork("10.0.0.0/8"), true);
  assert.equal(validConfiguredIpNetwork("2001:db8::/32"), true);
  assert.equal(validConfiguredIpNetwork("10.0.0.0/33"), false);
  assert.equal(validConfiguredIpNetwork("not-an-address"), false);
  assert.equal(addressInConfiguredNetworks("10.2.3.4", networks), true);
  assert.equal(addressInConfiguredNetworks("::ffff:10.2.3.4", networks), true);
  assert.equal(addressInConfiguredNetworks("2001:db8::1", networks), true);
  assert.equal(addressInConfiguredNetworks("192.0.2.1", networks), false);
});

test("expired rate-limit keys do not block a new client for a second window", async () => {
  const port = testPort(3150);
  const server = await startServer(port, {
    TRUST_PROXY: "true",
    TRUST_PROXY_CIDRS: "127.0.0.0/8",
    RATE_LIMIT_MAX: "10",
    RATE_LIMIT_INGRESS_MAX: "10",
    RATE_LIMIT_MAX_KEYS: "1",
    RATE_LIMIT_WINDOW_MS: "300"
  });
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  try {
    const first = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { ...MCP_POST_HEADERS, "x-forwarded-for": "203.0.113.1" },
      body
    });
    assert.equal(first.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const nextClient = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { ...MCP_POST_HEADERS, "x-forwarded-for": "203.0.113.2" },
      body
    });
    assert.equal(nextClient.status, 200);
  } finally {
    await server.close();
  }
});

test("stateless MCP declines standalone GET and DELETE streams", async () => {
  const port = testPort(3151);
  const server = await startServer(port);
  try {
    const get = await rawRequest(port, "GET", { accept: "text/event-stream" });
    assert.equal(get.status, 405);
    assert.equal(get.headers.allow, "POST, OPTIONS");
    const deletion = await rawRequest(port, "DELETE");
    assert.equal(deletion.status, 405);
    assert.equal(deletion.headers.allow, "POST, OPTIONS");
  } finally {
    await server.close();
  }
});

test("JSON-RPC batches are version-bounded, size-bounded, and charged per message", async () => {
  const port = testPort(3157);
  const server = await startServer(port, {
    MCP_MAX_BATCH_ITEMS: "2",
    RATE_LIMIT_MAX: "3",
    RATE_LIMIT_INGRESS_MAX: "3",
    RATE_LIMIT_WINDOW_MS: "10000"
  });
  const batch = JSON.stringify([
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", id: 2, method: "ping" }
  ]);
  try {
    assert.equal(
      await postJsonStatus(
        port,
        "/mcp",
        { "mcp-protocol-version": "2025-03-26" },
        batch
      ),
      200
    );
    assert.equal(
      await postJsonStatus(
        port,
        "/mcp",
        { "mcp-protocol-version": "2025-03-26" },
        JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" })
      ),
      200
    );
    assert.equal(
      await postJsonStatus(
        port,
        "/mcp",
        { "mcp-protocol-version": "2025-03-26" },
        JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" })
      ),
      429
    );
  } finally {
    await server.close();
  }

  const validationPort = testPort(3160);
  const validationServer = await startServer(validationPort, { MCP_MAX_BATCH_ITEMS: "2" });
  try {
    assert.equal(
      await postJsonStatus(
        validationPort,
        "/mcp",
        { "mcp-protocol-version": "2025-11-25" },
        batch
      ),
      400
    );
    assert.equal(
      await postJsonStatus(
        validationPort,
        "/mcp",
        { "mcp-protocol-version": "2025-03-26" },
        JSON.stringify([
          { jsonrpc: "2.0", id: 1, method: "ping" },
          { jsonrpc: "2.0", id: 2, method: "ping" },
          { jsonrpc: "2.0", id: 3, method: "ping" }
        ])
      ),
      413
    );
    assert.equal(
      await postJsonStatus(
        validationPort,
        "/mcp",
        { "mcp-protocol-version": "2099-01-01" },
        JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" })
      ),
      400
    );
  } finally {
    await validationServer.close();
  }
});

test("slow POST bodies cannot exhaust unbounded request handlers", async () => {
  const port = testPort(3158);
  const server = await startServer(port, {
    MCP_POST_MAX_INFLIGHT: "1",
    MCP_POST_MAX_PER_CLIENT: "1",
    MCP_POST_MAX_PER_INGRESS: "1",
    MCP_REQUEST_TIMEOUT_MS: "5000"
  });
  const slow = openSlowPost(port);
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await postJsonStatus(
      port,
      "/mcp",
      {},
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    );
    assert.equal(second, 429);
  } finally {
    slow.close();
    await server.close();
  }
});

test("early HTTP rejection closes an unread slow request body", async () => {
  const port = testPort(3162);
  const server = await startServer(port, { HTTP_MAX_CONNECTIONS: "1" });
  const rejected = await openRejectedSlowPost(port);
  try {
    assert.equal(rejected.status, 415);
    await Promise.race([
      rejected.closed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("rejected slow request socket stayed open")), 1000)
      )
    ]);
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
  } finally {
    rejected.close();
    await server.close();
  }
});

test("MCP transport rejects lookalike media types and advertises allowed methods", async () => {
  const port = testPort(3152);
  const server = await startServer(port);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
  try {
    const badContentType = await rawRequest(
      port,
      "POST",
      { "content-type": "application/jsonp", accept: "application/json, text/event-stream" },
      body
    );
    assert.equal(badContentType.status, 415);

    const badAccept = await rawRequest(
      port,
      "POST",
      { "content-type": "application/json", accept: "application/json-seq, text/event-streaming" },
      body
    );
    assert.equal(badAccept.status, 406);

    const rejectedByQuality = await rawRequest(
      port,
      "POST",
      { "content-type": "application/json", accept: "application/json;q=0, text/event-stream" },
      body
    );
    assert.equal(rejectedByQuality.status, 406);

    const ambiguousContentType = await rawRequest(
      port,
      "POST",
      {
        "content-type": "application/json, application/jsonp",
        accept: "application/json, text/event-stream"
      },
      body
    );
    assert.equal(ambiguousContentType.status, 415);

    const put = await rawRequest(port, "PUT");
    assert.equal(put.status, 405);
    assert.equal(put.headers.allow, "POST, OPTIONS");

    const deletionWithoutAccept = await rawRequest(port, "DELETE");
    assert.equal(deletionWithoutAccept.status, 405);
  } finally {
    await server.close();
  }
});

test("status endpoints enforce host policy and bounded methods", async () => {
  const port = testPort(3159);
  const server = await startServer(port);
  try {
    const badHost = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path: "/readyz", method: "GET", headers: { Host: "evil.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(badHost, 403);

    const badMethod = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path: "/healthz", method: "POST" },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(badMethod, 405);
  } finally {
    await server.close();
  }
});

test("fixture mode refuses public production startup unless explicitly allowed", async () => {
  const child = spawn(process.execPath, ["dist/src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "0.0.0.0",
      DATA_MODE: "fixture",
      PORT: String(testPort(3138))
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const [code] = (await once(child, "exit")) as [number];
  assert.notEqual(code, 0);
});

test("live mode refuses a fixture master DB even on a private bind address", async () => {
  const child = spawn(process.execPath, ["dist/src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      DATA_MODE: "live",
      LIVE_SELF_TEST_ITEM_SEQ: "DEMO-WARFARIN",
      LIVE_SELF_TEST_EXPECT_CONTRAINDICATION: "true",
      PORT: String(testPort(3144))
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const [code] = (await once(child, "exit")) as [number];
  assert.notEqual(code, 0);
});

test("public production rejects IPv6 loopback-only host and origin allowlists", async () => {
  const child = spawn(process.execPath, ["dist/src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "0.0.0.0",
      DATA_MODE: "live",
      MASTER_DB_PATH: "data/master.sqlite",
      CONFIRMATION_SECRET: "production-test-secret-at-least-32-characters",
      LIVE_SELF_TEST_ITEM_SEQ: "200108429",
      LIVE_SELF_TEST_TARGET_ITEM_SEQ: "197900145",
      LIVE_SELF_TEST_EXPECT_CONTRAINDICATION: "true",
      ALLOWED_HOSTS: "::1",
      ALLOWED_ORIGINS: "http://[::1]",
      PORT: String(testPort(3147))
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const [code] = (await once(child, "exit")) as [number];
  assert.notEqual(code, 0);
});

test("production rejects malformed hosts and insecure non-local origins", async () => {
  const baseEnv = {
    ...process.env,
    NODE_ENV: "production",
    HOST: "0.0.0.0",
    DATA_MODE: "live",
    MASTER_DB_PATH: "data/master.sqlite",
    CONFIRMATION_SECRET: "production-test-secret-at-least-32-characters",
    LIVE_SELF_TEST_ITEM_SEQ: "200108429",
    LIVE_SELF_TEST_TARGET_ITEM_SEQ: "197900145",
    LIVE_SELF_TEST_EXPECT_CONTRAINDICATION: "true"
  };
  const invalidConfigurations = [
    {
      PORT: String(testPort(3148)),
      ALLOWED_HOSTS: "medsafe-bot.example,bad host",
      ALLOWED_ORIGINS: "https://playmcp.kakao.com"
    },
    {
      PORT: String(testPort(3149)),
      ALLOWED_HOSTS: "medsafe-bot.example",
      ALLOWED_ORIGINS: "http://playmcp.kakao.com"
    },
    {
      PORT: String(testPort(3155)),
      ALLOWED_HOSTS: "medsafe-bot.example",
      ALLOWED_ORIGINS: "https://playmcp.kakao.com",
      RATE_LIMIT_MAX: "0"
    },
    {
      PORT: "0",
      ALLOWED_HOSTS: "medsafe-bot.example",
      ALLOWED_ORIGINS: "https://playmcp.kakao.com"
    }
  ];
  for (const extraEnv of invalidConfigurations) {
    const child = spawn(process.execPath, ["dist/src/server.js"], {
      cwd: process.cwd(),
      env: { ...baseEnv, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const [code] = (await once(child, "exit")) as [number];
    assert.notEqual(code, 0);
  }
});

test("production treats a specific non-loopback bind address as public", async () => {
  const child = spawn(process.execPath, ["dist/src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "10.0.0.5",
      DATA_MODE: "live",
      MASTER_DB_PATH: "data/master.sqlite",
      CONFIRMATION_SECRET: "production-test-secret-at-least-32-characters",
      LIVE_SELF_TEST_ITEM_SEQ: "200108429",
      LIVE_SELF_TEST_TARGET_ITEM_SEQ: "197900145",
      LIVE_SELF_TEST_EXPECT_CONTRAINDICATION: "true",
      ALLOWED_HOSTS: "*",
      ALLOWED_ORIGINS: "*",
      PORT: String(testPort(3153))
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const [code] = (await once(child, "exit")) as [number];
  assert.notEqual(code, 0);
});

test("production rejects wildcard policy even on a loopback bind address", async () => {
  const child = spawn(process.execPath, ["dist/src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      DATA_MODE: "live",
      MASTER_DB_PATH: "data/master.sqlite",
      CONFIRMATION_SECRET: "production-test-secret-at-least-32-characters",
      LIVE_SELF_TEST_ITEM_SEQ: "200108429",
      LIVE_SELF_TEST_TARGET_ITEM_SEQ: "197900145",
      LIVE_SELF_TEST_EXPECT_CONTRAINDICATION: "true",
      ALLOWED_HOSTS: "*",
      ALLOWED_ORIGINS: "*",
      PORT: String(testPort(3160))
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (data: Buffer) => (output += data.toString()));
  child.stderr.on("data", (data: Buffer) => (output += data.toString()));
  const [code] = (await once(child, "exit")) as [number];
  assert.notEqual(code, 0);
  assert.match(output, /does not allow wildcard host or origin policy/);
});

test("production live mode refuses a legacy model-v2 data plane", async () => {
  const directory = mkdtempSync(join(tmpdir(), "medsafe-model-v2-"));
  const legacyDbPath = join(directory, "master-v2.sqlite");
  const SQL = await initSqlJs({
    locateFile: (file) => join(process.cwd(), "node_modules/sql.js/dist", file)
  });
  const database = new SQL.Database(readFileSync("data/master.sqlite"));
  database.run("UPDATE metadata SET value = '2' WHERE key = 'dataModelVersion'");
  writeFileSync(legacyDbPath, Buffer.from(database.export()));
  database.close();

  try {
    const child = spawn(process.execPath, ["dist/src/server.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        DATA_MODE: "live",
        MASTER_DB_PATH: legacyDbPath,
        CONFIRMATION_SECRET: "production-test-secret-at-least-32-characters",
        LIVE_SELF_TEST_ITEM_SEQ: "200108429",
        LIVE_SELF_TEST_TARGET_ITEM_SEQ: "197900145",
        LIVE_SELF_TEST_EXPECT_CONTRAINDICATION: "true",
        ALLOWED_HOSTS: "127.0.0.1",
        PORT: String(testPort(3145))
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (data: Buffer) => (output += data.toString()));
    child.stderr.on("data", (data: Buffer) => (output += data.toString()));
    const [code] = (await once(child, "exit")) as [number];
    assert.notEqual(code, 0);
    assert.match(output, /live DB model version mismatch/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("production live mode refuses metadata counts that disagree with stored rows", async () => {
  const directory = mkdtempSync(join(tmpdir(), "medsafe-count-mismatch-"));
  const brokenDbPath = join(directory, "master-count-mismatch.sqlite");
  const SQL = await initSqlJs({
    locateFile: (file) => join(process.cwd(), "node_modules/sql.js/dist", file)
  });
  const database = new SQL.Database(readFileSync("data/master.sqlite"));
  database.run("UPDATE metadata SET value = '99999' WHERE key = 'productCount'");
  writeFileSync(brokenDbPath, Buffer.from(database.export()));
  database.close();

  try {
    const child = spawn(process.execPath, ["dist/src/server.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        DATA_MODE: "live",
        MASTER_DB_PATH: brokenDbPath,
        CONFIRMATION_SECRET: "production-test-secret-at-least-32-characters",
        LIVE_SELF_TEST_ITEM_SEQ: "200108429",
        LIVE_SELF_TEST_TARGET_ITEM_SEQ: "197900145",
        LIVE_SELF_TEST_EXPECT_CONTRAINDICATION: "true",
        ALLOWED_HOSTS: "127.0.0.1",
        PORT: String(testPort(3146))
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (data: Buffer) => (output += data.toString()));
    child.stderr.on("data", (data: Buffer) => (output += data.toString()));
    const [code] = (await once(child, "exit")) as [number];
    assert.notEqual(code, 0);
    assert.match(output, /DB row-count metadata mismatch/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
