import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAppServices } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { buildMcpServer } from "../src/mcpServer.js";
import { MasterRepository } from "../src/repositories/masterRepository.js";
import { redactConfirmationTokensInText } from "../src/utils/redact.js";
import { computeBuildId } from "../src/version.js";

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

const transcriptDataMode = await inferDataMode();
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

  const ambiguity = await client.callTool({
    name: "resolve_medications",
    arguments: { queries: [transcriptDataMode === "live" ? "아스피린" : "타이레놀"] }
  });

  const primaryQueries = transcriptDataMode === "live"
    ? ["아스피린프로텍트정 100mg", "유한메토트렉세이트정"]
    : ["와파린", "아스피린"];
  const secondaryQueries = ["타이레놀정 500mg", "게보린정"];
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
      queries: caregiverStructured.resolved.map((item) => item.matchedName),
      context: { ageGroup: "adult", pregnancy: "no" }
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
      queries: riskStructured.resolved.map((item) => item.matchedName),
      context: { ageGroup: "adult", pregnancy: "no" }
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
  const explanation = await client.callTool({
    name: "explain_medication",
    arguments: {
      itemSeq: transcriptDataMode === "live" ? "202106092" : "DEMO-TYLENOL-500"
    }
  });

  const markdown = [
    "# Demo Transcript",
    "",
    transcriptDataMode === "live"
      ? "Generated from the local MCP server with a verified live public-data snapshot."
      : "Generated from the local MCP server with fixture data. Use live public-data evidence before final submission.",
    "",
    `Build ID: \`${computeBuildId()}\``,
    `Data SHA-256: \`${services.dataSha256}\``,
    "",
    "## 1. 모호한 약 이름은 후보 확인",
    "",
    `User: ${transcriptDataMode === "live" ? "아스피린" : "타이레놀"} 먹고 있어요.`,
    "",
    "Tool: `resolve_medications`",
    "",
    "```text",
    textOf(ambiguity),
    "```",
    "",
    transcriptDataMode === "live" ? "## 2. 정확한 품목으로 Live red-case 확인" : "## 2. 정확한 품목 확인",
    "",
    `User: 성인 남성인 아버지가 ${primaryQueries[0]}하고 ${primaryQueries[1]} 같이 먹어도 돼?`,
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
    transcriptDataMode === "live" ? "## 3. 실제 DUR 병용금기" : "## 3. 중복 성분 주의",
    "",
    "Tool: `check_medication_safety`",
    "",
    "```text",
    textOf(primaryCheck),
    "```",
    "",
    "## 4. 실제 복합성분 중복 점검",
    "",
    "User: 성인 남성인 제가 타이레놀정 500mg하고 게보린정을 같이 먹어도 돼?",
    "",
    "Tool: `resolve_medications` then `check_medication_safety`",
    "",
    "```text",
    textOf(secondaryCheck),
    "```",
    "",
    "## 5. e약은요 설명",
    "",
    "Tool: `explain_medication`",
    "",
    "```text",
    textOf(explanation),
    "```",
    "",
    "## 6. 응급 우선",
    "",
    "```text",
    textOf(emergency),
    "```",
    "",
    "## 7. 범위 밖 입력",
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
  return redactConfirmationTokensInText(
    content.map((item) => item.text ?? "").join("\n").trim()
  );
}

function redactTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactTokens(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        key === "confirmationToken" && typeof nested === "string" ? "v2.[redacted]" : redactTokens(nested)
      ])
    );
  }
  return value;
}

async function inferDataMode(): Promise<"fixture" | "live"> {
  if (process.env.DATA_MODE) return process.env.DATA_MODE === "live" ? "live" : "fixture";
  const repository = await MasterRepository.open(process.env.MASTER_DB_PATH ?? "data/master.sqlite");
  try {
    if (repository.metadata("source") !== "PUBLIC_DATA_LIVE") return "fixture";
    if (
      repository.metadata("dataModelVersion") !== "3" ||
      !repository.hasCompleteDurIngredientCatalog()
    ) {
      throw new Error(
        "Refusing to generate a live transcript from a pre-v3 or incomplete DUR catalog."
      );
    }
    return "live";
  } finally {
    repository.close();
  }
}
