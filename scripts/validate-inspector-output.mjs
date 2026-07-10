import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { computeBuildId, computeVerificationId } from "../dist/src/version.js";

const inputPath = process.argv[2] ?? "docs/submission/inspector-tools.generated.json";
const outputPath = process.argv[3] ?? inputPath;
const endpointFlag = process.argv.indexOf("--endpoint");
const endpointValue =
  (endpointFlag >= 0 ? process.argv[endpointFlag + 1] : undefined) ??
  process.env.INSPECTOR_ENDPOINT;
if (!endpointValue) throw new Error("Inspector evidence requires --endpoint or INSPECTOR_ENDPOINT");

const endpoint = new URL(endpointValue);
if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
  throw new Error("Inspector endpoint must use HTTP or HTTPS");
}
const raw = readFileSync(inputPath, "utf8");
const start = raw.indexOf("{");
const end = raw.lastIndexOf("}");
if (start < 0 || end < start) throw new Error("Inspector output has no JSON object");
const value = JSON.parse(raw.slice(start, end + 1));
const tools = Array.isArray(value.tools) ? value.tools : [];
const expected = ["resolve_medications", "check_medication_safety", "explain_medication"];
const contracts = {
  resolve_medications: {
    inputRequired: ["queries"],
    outputRequired: ["resolved", "dataAsOf"]
  },
  check_medication_safety: {
    inputRequired: ["medications"],
    outputRequired: [
      "verdict",
      "dataAsOf",
      "findings",
      "unresolved",
      "checkedTypes",
      "failedTypes",
      "disclaimer"
    ]
  },
  explain_medication: {
    inputRequired: ["itemSeq"],
    outputRequired: ["info", "found", "status", "error", "dataAsOf"]
  }
};
if (tools.length !== expected.length || !expected.every((name) => tools.some((tool) => tool.name === name))) {
  throw new Error(`Inspector returned unexpected tools: ${tools.map((tool) => tool.name).join(", ")}`);
}
for (const tool of tools) {
  const annotations = tool.annotations ?? {};
  if (
    !annotations.title ||
    annotations.readOnlyHint !== true ||
    annotations.destructiveHint !== false ||
    typeof annotations.openWorldHint !== "boolean" ||
    typeof annotations.idempotentHint !== "boolean"
  ) {
    throw new Error(`Inspector annotations are incomplete for ${tool.name}`);
  }
  const contract = contracts[tool.name];
  if (!contract) throw new Error(`Inspector contract is missing for ${tool.name}`);
  assertObjectSchema(tool.inputSchema, contract.inputRequired, `${tool.name} input`);
  assertObjectSchema(tool.outputSchema, contract.outputRequired, `${tool.name} output`);
  if (tool.name === "resolve_medications") {
    const queries = tool.inputSchema.properties.queries;
    if (
      queries?.type !== "array" ||
      queries.minItems !== 1 ||
      queries.maxItems !== 8 ||
      queries.items?.type !== "string"
    ) {
      throw new Error("resolve_medications queries schema is invalid");
    }
  }
  if (tool.name === "check_medication_safety") {
    const medications = tool.inputSchema.properties.medications;
    if (
      medications?.type !== "array" ||
      medications.minItems !== 1 ||
      medications.maxItems !== 12 ||
      medications.items?.type !== "object"
    ) {
      throw new Error("check_medication_safety medications schema is invalid");
    }
  }
  if (tool.name === "explain_medication") {
    const itemSeq = tool.inputSchema.properties.itemSeq;
    if (itemSeq?.type !== "string" || typeof itemSeq.pattern !== "string") {
      throw new Error("explain_medication itemSeq schema is invalid");
    }
  }
}

const readinessUrl = new URL("/readyz", endpoint);
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 10_000);
let readiness;
try {
  const response = await fetch(readinessUrl, { signal: controller.signal });
  readiness = await response.json();
  if (!response.ok || readiness?.ok !== true) {
    throw new Error(`Inspector endpoint readiness failed: HTTP ${response.status}`);
  }
} finally {
  clearTimeout(timer);
}

const buildId = computeBuildId();
const verificationId = computeVerificationId();
const dataPath = process.env.MASTER_DB_PATH ?? "data/master.sqlite";
const dataSha256 = createHash("sha256").update(readFileSync(dataPath)).digest("hex");
if (readiness.buildId !== buildId) throw new Error("Inspector endpoint build ID is stale");
if (readiness.dataSha256 !== dataSha256) throw new Error("Inspector endpoint DB SHA is stale");
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const inspectorVersion = packageJson.devDependencies?.["@modelcontextprotocol/inspector"];
if (!inspectorVersion) throw new Error("Inspector dependency version is missing");

const evidence = {
  schemaVersion: 1,
  endpoint: endpoint.toString(),
  checkedAt: new Date().toISOString(),
  buildId,
  verificationId,
  dataSha256,
  inspectorVersion,
  tools
};
writeJsonAtomic(resolve(outputPath), evidence);
console.log(`ok Inspector tools/list: ${expected.join(", ")}`);
console.log(`ok Inspector provenance: ${endpoint.toString()} build=${buildId}`);

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporaryPath, path);
}

function assertObjectSchema(schema, requiredProperties, label) {
  if (!schema || schema.type !== "object" || !schema.properties) {
    throw new Error(`${label} schema is not an object`);
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  for (const property of requiredProperties) {
    if (!required.has(property) || !schema.properties[property]) {
      throw new Error(`${label} schema is missing required property ${property}`);
    }
  }
}
