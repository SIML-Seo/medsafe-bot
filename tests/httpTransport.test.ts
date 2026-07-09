import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function startServer(
  port: number,
  extraEnv: Record<string, string> = {}
): Promise<{ close: () => Promise<void>; exited: () => boolean }> {
  const child = spawn(process.execPath, ["dist/src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_MODE: "fixture",
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  const onData = (data: Buffer) => {
    output += data.toString();
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  const deadline = Date.now() + 15000;
  while (!output.includes("listening on")) {
    assert.ok(Date.now() < deadline, `server did not start: ${output}`);
    if (child.exitCode !== null) {
      throw new Error(`server exited early: ${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return {
    exited: () => child.exitCode !== null,
    close: async () => {
      child.kill("SIGINT");
      await Promise.race([
        once(child, "exit"),
        new Promise((resolve) => setTimeout(resolve, 2000))
      ]);
    }
  };
}

function openGet(
  port: number,
  path: string,
  headers: Record<string, string> = {}
): Promise<{ statusCode: number | undefined; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      res.on("data", () => undefined);
      resolve({
        statusCode: res.statusCode,
        close: () => {
          req.destroy();
          res.destroy();
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function httpGetStatus(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

function postJsonStatus(
  port: number,
  path: string,
  headers: Record<string, string>,
  body: string
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "POST", headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("Streamable HTTP server supports tools/list and tools/call", async () => {
  const port = 3137;
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

test("MCP host and origin allowlists support explicit wildcard deployment mode", async () => {
  const port = 3143;
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

test("HTTP server exposes health/readiness and rejects oversized MCP bodies", async () => {
  const port = 3139;
  const server = await startServer(port, { MCP_BODY_LIMIT_BYTES: "64" });
  try {
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
    assert.equal(ready.status, 200);

    const tooLarge = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
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
  const port = 3140;
  const server = await startServer(port, { RATE_LIMIT_MAX: "1", RATE_LIMIT_WINDOW_MS: "10000" });
  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const first = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body
    });
    assert.notEqual(first.status, 429);

    const second = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body
    });
    assert.equal(second.status, 429);
  } finally {
    await server.close();
  }
});

test("trusted proxy mode does not use spoofed leftmost X-Forwarded-For value", async () => {
  const port = 3142;
  const server = await startServer(port, {
    TRUST_PROXY: "true",
    RATE_LIMIT_MAX: "1",
    RATE_LIMIT_WINDOW_MS: "10000"
  });
  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const first = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10, 10.0.0.5" },
      body
    });
    assert.notEqual(first.status, 429);

    const second = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.20, 10.0.0.5" },
      body
    });
    assert.equal(second.status, 429);
  } finally {
    await server.close();
  }
});

test("GET /mcp SSE stream does not trip request timeout and crash the server", async () => {
  const port = 3141;
  const server = await startServer(port, { MCP_REQUEST_TIMEOUT_MS: "1000" });
  const stream = await openGet(port, "/mcp", { accept: "text/event-stream" });
  try {
    assert.equal(stream.statusCode, 200);
    await new Promise((resolve) => setTimeout(resolve, 1800));
    assert.equal(server.exited(), false);
    assert.equal(await httpGetStatus(port, "/healthz"), 200);
  } finally {
    stream.close();
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
      PORT: "3138"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const [code] = (await once(child, "exit")) as [number];
  assert.notEqual(code, 0);
});
