import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAppServices } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { buildMcpServer } from "../src/mcpServer.js";

interface TextContent {
  type: string;
  text?: string;
}

const outputFlagIndex = process.argv.indexOf("--output");
const outputPath =
  outputFlagIndex >= 0 ? process.argv[outputFlagIndex + 1] : "docs/submission/demo-transcript.generated.md";

if (!outputPath) {
  throw new Error("--output requires a path");
}

const transcriptDataMode = process.env.DATA_MODE === "live" ? "live" : "fixture";
const services = await createAppServices(
  loadConfig({
    ...process.env,
    DATA_MODE: transcriptDataMode,
    CONFIRMATION_SECRET: process.env.CONFIRMATION_SECRET ?? "demo-transcript-secret"
  })
);
const server = buildMcpServer(services);
const client = new Client({ name: "demo-transcript", version: "0.1.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const primaryQueries = transcriptDataMode === "live" ? ["로바콜", "더마졸"] : ["타이레놀", "게보린"];
  const secondaryQueries = transcriptDataMode === "live" ? ["타이레놀", "게보린"] : ["와파린", "아스피린"];
  const caregiverResolve = await client.callTool({
    name: "resolve_medications",
    arguments: { queries: primaryQueries }
  });
  const caregiverStructured = caregiverResolve.structuredContent as {
    resolved: Array<{
      status: string;
      itemSeq: string | null;
      ingrCode: string | null;
      matchedName: string | null;
      confirmationToken: string | null;
      candidates: Array<{
        itemSeq: string | null;
        ingrCode: string | null;
        matchedName: string;
        confirmationToken: string | null;
      }>;
    }>;
  };
  const primaryCheck = await client.callTool({
    name: "check_medication_safety",
    arguments: {
      medications: caregiverStructured.resolved.map((item) => ({
        itemSeq: item.status === "AMBIGUOUS" ? item.candidates[0]?.itemSeq : item.itemSeq,
        ingrCode: item.status === "AMBIGUOUS" ? item.candidates[0]?.ingrCode : item.ingrCode,
        status: "CONFIRMED",
        displayName: item.status === "AMBIGUOUS" ? item.candidates[0]?.matchedName : item.matchedName,
        confirmationToken:
          item.status === "AMBIGUOUS" ? item.candidates[0]?.confirmationToken : item.confirmationToken
      })),
      context: { subjectIsUser: false, ageGroup: "elderly", pregnancy: "no" }
    }
  });

  const riskResolve = await client.callTool({
    name: "resolve_medications",
    arguments: { queries: secondaryQueries }
  });
  const riskStructured = riskResolve.structuredContent as typeof caregiverStructured;
  const secondaryCheck = await client.callTool({
    name: "check_medication_safety",
    arguments: {
      medications: riskStructured.resolved.map((item) => ({
        itemSeq: item.itemSeq,
        ingrCode: item.ingrCode,
        status: item.status,
        displayName: item.matchedName,
        confirmationToken: item.confirmationToken
      })),
      context: { subjectIsUser: false, ageGroup: "adult", pregnancy: "no" }
    }
  });

  const emergency = await client.callTool({
    name: "resolve_medications",
    arguments: { queries: ["약 먹고 호흡곤란이 있어요"] }
  });
  const outOfScope = await client.callTool({
    name: "resolve_medications",
    arguments: { queries: ["자몽"] }
  });

  const markdown = [
    "# Demo Transcript",
    "",
    transcriptDataMode === "live"
      ? "Generated from the local MCP server with live public-data mode."
      : "Generated from the local MCP server with fixture data. Use live public-data evidence before final submission.",
    "",
    transcriptDataMode === "live" ? "## 1. Live red-case 입력과 확인" : "## 1. 보호자 입력과 되묻기",
    "",
    `User: 엄마가 ${primaryQueries[0]}하고 ${primaryQueries[1]} 같이 먹어도 돼?`,
    "",
    "Tool: `resolve_medications`",
    "",
    "```text",
    textOf(caregiverResolve),
    "```",
    "",
    "Structured summary:",
    "",
    "```json",
    JSON.stringify(redactTokens(caregiverResolve.structuredContent), null, 2),
    "```",
    "",
    transcriptDataMode === "live" ? "## 2. 실제 DUR 병용금기" : "## 2. 중복 성분 주의",
    "",
    "Tool: `check_medication_safety`",
    "",
    "```text",
    textOf(primaryCheck),
    "```",
    "",
    transcriptDataMode === "live" ? "## 3. 데이터 부족 fail-closed 데모" : "## 3. 병용금기 빨간색 데모",
    "",
    "Tool: `resolve_medications` then `check_medication_safety`",
    "",
    "```text",
    textOf(secondaryCheck),
    "```",
    "",
    "## 4. 응급 우선",
    "",
    "```text",
    textOf(emergency),
    "```",
    "",
    "## 5. 범위 밖 입력",
    "",
    "```text",
    textOf(outOfScope),
    "```",
    ""
  ].join("\n");

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, markdown, "utf8");
  console.log(`demo transcript written: ${outputPath}`);
} finally {
  await client.close();
  await server.close();
  services.repository.close();
}

function textOf(result: unknown): string {
  const rawContent =
    result && typeof result === "object" && "content" in result
      ? ((result as { content?: unknown }).content ?? [])
      : [];
  const content: TextContent[] = Array.isArray(rawContent) ? (rawContent as TextContent[]) : [];
  return content.map((item) => item.text ?? "").join("\n").trim();
}

function redactTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactTokens(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        key === "confirmationToken" && typeof nested === "string" ? "v1.[redacted]" : redactTokens(nested)
      ])
    );
  }
  return value;
}
