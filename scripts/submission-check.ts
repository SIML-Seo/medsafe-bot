import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "../src/config/env.js";
import { DUR_BASE_URLS, SUBMISSION_MCP_ENDPOINT } from "../src/config/schemaMap.js";
import { createAppServices } from "../src/app.js";
import { computeBuildId, computeVerificationId } from "../src/version.js";
import {
  isLocalHost,
  isLocalOrigin,
  secureConfiguredOrigin,
  validConfiguredHost,
  validConfiguredIpNetwork,
  validConfiguredOrigin
} from "../src/utils/networkPolicy.js";
import { timestampWithinPastWindow } from "../src/utils/time.js";
import {
  CRITICAL_EMERGENCY_TEXT_PROBES,
  CRITICAL_NON_EMERGENCY_TEXT_PROBES,
  CRITICAL_POTENTIAL_OVERDOSE_TEXT_PROBES,
  CRITICAL_RELEASE_SAFETY_PROBE_COUNT,
  FIXED_RELEASE_PROBE_ITEM_SEQS,
  criticalReleaseSafetyFailures,
  selectReleaseProbeProducts
} from "../src/utils/releaseProbes.js";

const BUILD_ID = computeBuildId();
const VERIFICATION_ID = computeVerificationId();

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  severity: "error" | "warn";
}

const strictLive = process.argv.includes("--strict-live");
const requireRemote = process.argv.includes("--require-remote");
const remoteEvidencePath = "docs/submission/remote-verification.generated.json";
const inspectorEvidencePath = "docs/submission/inspector-tools.generated.json";
const config = loadConfig(strictLive ? { ...process.env, DATA_MODE: "live" } : process.env);
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const checks: Check[] = [
  fileCheck("handoff prompt preserved", "handoff-prompt.md", "error"),
  hashCheck(
    "handoff prompt SHA-256",
    "handoff-prompt.md",
    "d2d90b1fbc3502d6a63472886e0428197e94cb3089c29484c3c181fa091078bb",
    "error"
  ),
  fileCheck("demo script", "docs/submission/demo-script.md", "error"),
  fileCheck("generated demo transcript", "docs/submission/demo-transcript.generated.md", "error"),
  liveTranscriptCheck(strictLive ? "error" : "warn"),
  fileCheck("widget mapping", "docs/submission/widget-mapping.md", "error"),
  fileCheck("widget preview", "docs/submission/widget-preview.html", "error"),
  fileCheck("live data checklist", "docs/submission/live-data-checklist.md", "error"),
  fileCheck("CI workflow", ".github/workflows/ci.yml", "error"),
  fileCheck("remote release workflow", ".github/workflows/remote-release.yml", "error"),
  documentValueCheck(
    "remote workflow uses cross-region observation profile",
    ".github/workflows/remote-release.yml",
    "REMOTE_PERFORMANCE_PROFILE: cross-region-observe",
    "error"
  ),
  documentValueCheck(
    "remote workflow separates cross-region evidence",
    ".github/workflows/remote-release.yml",
    "REMOTE_EVIDENCE_PATH: docs/submission/remote-verification.cross-region.generated.json",
    "error"
  ),
  fileCheck("live evidence", "docs/submission/live-evidence-2026-07-10.md", "warn"),
  documentValueCheck(
    "live evidence build ID matches local release",
    "docs/submission/live-evidence-2026-07-10.md",
    BUILD_ID,
    strictLive ? "error" : "warn"
  ),
  fileCheck(
    "generated remote verification evidence",
    remoteEvidencePath,
    requireRemote ? "error" : "warn"
  ),
  fileCheck(
    "generated Inspector tools evidence",
    inspectorEvidencePath,
    requireRemote ? "error" : "warn"
  ),
  {
    name: "DUR HTTPS only",
    ok: DUR_BASE_URLS.every((url) => url.startsWith("https://")),
    detail: DUR_BASE_URLS.join(", "),
    severity: "error"
  },
  {
    name: "cross-platform clean build script",
    ok: packageJson.scripts?.build === "node scripts/build.mjs",
    detail: packageJson.scripts?.build ?? "missing",
    severity: "error"
  },
  {
    name: "cross-platform test script",
    ok: packageJson.scripts?.test === "node scripts/run-tests.mjs",
    detail: packageJson.scripts?.test ?? "missing",
    severity: "error"
  },
  {
    name: "repository secret content scan configured",
    ok: packageJson.scripts?.["scan:secrets"] === "node scripts/scan-secrets.mjs",
    detail: packageJson.scripts?.["scan:secrets"] ?? "missing",
    severity: "error"
  },
  {
    name: "demo transcript script configured",
    ok: Boolean(packageJson.scripts?.["demo:transcript"]),
    detail: packageJson.scripts?.["demo:transcript"] ?? "missing",
    severity: "error"
  },
  {
    name: "submission check preserves current master DB",
    ok:
      Boolean(packageJson.scripts?.["submission:check"]) &&
      !packageJson.scripts?.["submission:check"]?.includes("build:master"),
    detail: packageJson.scripts?.["submission:check"] ?? "missing",
    severity: "error"
  },
  {
    name: "strict live check preserves current master DB",
    ok:
      Boolean(packageJson.scripts?.["submission:check:live"]) &&
      !packageJson.scripts?.["submission:check:live"]?.includes("build:master"),
    detail: packageJson.scripts?.["submission:check:live"] ?? "missing",
    severity: "error"
  },
  {
    name: "confirmation secret configured for live",
    ok: config.dataMode !== "live" || (config.confirmationSecret?.length ?? 0) >= 32,
    detail:
      config.dataMode === "live"
        ? config.confirmationSecret
          ? config.confirmationSecret.length >= 32
            ? "configured (32+ characters)"
            : "shorter than 32 characters"
          : "missing"
        : "not required in fixture mode",
    severity: strictLive ? "error" : "warn"
  },
  {
    name: "live data mode",
    ok: config.dataMode === "live",
    detail: `DATA_MODE=${config.dataMode}`,
    severity: strictLive ? "error" : "warn"
  },
  {
    name: "MFDS service key available for source refresh",
    ok: Boolean(config.mfdsServiceKey),
    detail: config.mfdsServiceKey ? "configured" : "missing",
    severity: "warn"
  },
  {
    name: "production node environment",
    ok: !strictLive || config.nodeEnv === "production",
    detail: `NODE_ENV=${config.nodeEnv}`,
    severity: strictLive ? "error" : "warn"
  },
  {
    name: "explicit production host allowlist",
    ok:
      !strictLive ||
      (config.allowedHosts.length > 0 &&
        !config.allowedHosts.includes("*") &&
        config.allowedHosts.every(validConfiguredHost) &&
        config.allowedHosts.some((host) => !isLocalHost(host))),
    detail: config.allowedHosts.join(","),
    severity: strictLive ? "error" : "warn"
  },
  {
    name: "explicit production origin allowlist",
    ok:
      !strictLive ||
      (config.allowedOrigins.length > 0 &&
        !config.allowedOrigins.includes("*") &&
        config.allowedOrigins.every(validConfiguredOrigin) &&
        config.allowedOrigins.every(secureConfiguredOrigin) &&
        config.allowedOrigins.some((origin) => !isLocalOrigin(origin))),
    detail: config.allowedOrigins.join(","),
    severity: strictLive ? "error" : "warn"
  },
  {
    name: "production resource limits enabled",
    ok:
      !strictLive ||
      (config.rateLimitWindowMs > 0 &&
        config.rateLimitMax > 0 &&
        config.rateLimitIngressMax > 0 &&
        config.mcpBodyLimitBytes >= 1024 &&
        config.mcpBodyLimitBytes <= 1024 * 1024 &&
        config.mcpMaxBatchItems >= 1 &&
        config.mcpMaxBatchItems <= 16 &&
        config.mcpRequestTimeoutMs >= 1000 &&
        config.mcpRequestTimeoutMs <= 120000 &&
        config.mcpPostMaxInflight > 0 &&
        config.mcpPostMaxPerClient > 0 &&
        config.mcpPostMaxPerClient <= config.mcpPostMaxInflight &&
        config.mcpPostMaxPerIngress > 0 &&
        config.mcpPostMaxPerIngress <= config.mcpPostMaxInflight &&
        (!config.trustProxy ||
          (config.trustProxyHops > 0 &&
            config.trustProxyCidrs.length > 0 &&
            config.trustProxyCidrs.every(validConfiguredIpNetwork))) &&
        config.httpMaxConnections > 0 &&
        config.httpHeadersTimeoutMs >= 1000 &&
        config.httpHeadersTimeoutMs <= 120000 &&
        config.httpMaxRequestsPerSocket > 0),
    detail: `rate=${config.rateLimitMax}/${config.rateLimitIngressMax} per ${config.rateLimitWindowMs}ms, body=${config.mcpBodyLimitBytes}, batch=${config.mcpMaxBatchItems}, timeout=${config.mcpRequestTimeoutMs}, post=${config.mcpPostMaxInflight}/${config.mcpPostMaxPerClient}/${config.mcpPostMaxPerIngress}, proxy=${config.trustProxy ? `${config.trustProxyHops} hop(s) via ${config.trustProxyCidrs.join("|")}` : "off"}, http=${config.httpMaxConnections}/${config.httpHeadersTimeoutMs}/${config.httpMaxRequestsPerSocket}`,
    severity: strictLive ? "error" : "warn"
  },
  {
    name: "live self-test itemSeq",
    ok: Boolean(config.liveSelfTestItemSeq),
    detail: config.liveSelfTestItemSeq ? "configured" : "missing",
    severity: strictLive ? "error" : "warn"
  },
  {
    name: "live self-test target itemSeq",
    ok: Boolean(config.liveSelfTestTargetItemSeq),
    detail: config.liveSelfTestTargetItemSeq ? "configured" : "missing",
    severity: strictLive ? "error" : "warn"
  },
  {
    name: "live red-case self-test expectation",
    ok: config.liveSelfTestExpectContraindication,
    detail: `LIVE_SELF_TEST_EXPECT_CONTRAINDICATION=${String(config.liveSelfTestExpectContraindication)}`,
    severity: strictLive ? "error" : "warn"
  }
];

await addDatabaseAndLiveChecks(checks);
addRemoteEvidenceChecks(checks);
addInspectorEvidenceChecks(checks);

for (const check of checks) {
  const prefix = check.ok ? "ok" : check.severity === "error" ? "ERROR" : "WARN";
  console.log(`${prefix} ${check.name}: ${check.detail}`);
}

function addRemoteEvidenceChecks(checksToUpdate: Check[]): void {
  if (!existsSync(remoteEvidencePath)) return;
  try {
    const rawEvidence = readFileSync(remoteEvidencePath, "utf8");
    type EvidenceFlow = {
      verdict?: string;
      findings?: Array<{ type?: string; level?: string; reason?: string; origin?: string }>;
      checkedTypes?: string[];
      failedTypes?: string[];
      found?: boolean;
      status?: string;
      itemSeq?: string | null;
      notes?: string;
      resolveEmergency?: boolean;
      resolveTriageStatus?: string;
      resolveHoldPreserved?: boolean;
    };
    const evidence = JSON.parse(rawEvidence) as {
      schemaVersion?: number;
      endpoint?: string;
      checkedAt?: string;
      buildId?: string;
      verificationId?: string;
      dataSha256?: string;
      readiness?: {
        ok?: boolean;
        dataMode?: string;
        dataSource?: string;
        dataModelVersion?: string;
        buildId?: string;
        dataSha256?: string;
        criticalSafety?: { checked?: number; ok?: boolean };
        coverage?: {
          curatedDur?: { ratio?: number };
          ingredientDur?: { ratio?: number };
          catalogIdentityMapping?: { ratio?: number };
          activeCatalogIdentityMapping?: { ratio?: number };
        };
      };
      tools?: string[];
      flows?: {
        resolved?: Array<{ status?: string; itemSeq?: string | null }>;
        duplicateIngredient?: EvidenceFlow;
        redCase?: EvidenceFlow;
        playMcpTextHandoff?: {
          source?: string;
          queryCount?: number;
          serverReresolved?: boolean;
          verdict?: string;
          redFinding?: boolean;
          unresolvedCount?: number;
        };
        explanation?: EvidenceFlow;
        ingredientCatalogCoverage?: EvidenceFlow;
        ingredientCatalogRedCase?: EvidenceFlow;
        conservativeFormRedCase?: EvidenceFlow;
        paxlovidCompoundRedCase?: EvidenceFlow;
        cabozantinibSingleRedCase?: EvidenceFlow;
        cabozantinibMixCodeRedCase?: EvidenceFlow;
        nimesulideSpellingRedCase?: EvidenceFlow;
        isoniazidSpellingRedCase?: EvidenceFlow;
        clopidogrelSpellingRedCase?: EvidenceFlow;
        xylometazolineSpellingRedCase?: EvidenceFlow;
        nimesulideSpellingDuplicate?: EvidenceFlow;
        isoniazidSpellingDuplicate?: EvidenceFlow;
        clopidogrelSpellingDuplicate?: EvidenceFlow;
        caffeineCompoundDuplicate?: EvidenceFlow;
        lysineAcetateDuplicate?: EvidenceFlow;
        brandEmergencyCases?: EvidenceFlow[];
        brandNonEmergencyCases?: EvidenceFlow[];
        potentialOverdoseCases?: EvidenceFlow[];
        ingredientMissingFailClosed?: EvidenceFlow;
      };
      performance?: {
        profile?: string;
        averageRequirementCertified?: boolean;
        samples?: number;
        averageMs?: number;
        p99Ms?: number;
        averageLimitMs?: number;
        p99LimitMs?: number;
        byOperation?: Record<string, { samples?: number; averageMs?: number; p99Ms?: number }>;
        concurrent?: { samples?: number; averageMs?: number; p99Ms?: number };
        coldConnections?: { samples?: number; averageMs?: number; p99Ms?: number };
      };
    };
    const checkedAtMs = Date.parse(evidence.checkedAt ?? "");
    const localSha = existsSync(config.masterDbPath)
      ? createHash("sha256").update(readFileSync(config.masterDbPath)).digest("hex")
      : "missing";
    const endpointOk = evidence.endpoint === SUBMISSION_MCP_ENDPOINT;
    const expectedTools = [
      "resolve_medications",
      "check_medication_safety",
      "explain_medication"
    ];
    const toolsOk =
      Array.isArray(evidence.tools) &&
      evidence.tools.length === expectedTools.length &&
      expectedTools.every((tool) => evidence.tools?.includes(tool));
    const duplicate = evidence.flows?.duplicateIngredient;
    const red = evidence.flows?.redCase;
    const playMcpTextHandoff = evidence.flows?.playMcpTextHandoff;
    const explanation = evidence.flows?.explanation;
    const catalogCoverage = evidence.flows?.ingredientCatalogCoverage;
    const catalogRed = evidence.flows?.ingredientCatalogRedCase;
    const conservativeFormRed = evidence.flows?.conservativeFormRedCase;
    const criticalMappingFlows = [
      evidence.flows?.paxlovidCompoundRedCase,
      evidence.flows?.cabozantinibSingleRedCase,
      evidence.flows?.cabozantinibMixCodeRedCase,
      evidence.flows?.nimesulideSpellingRedCase,
      evidence.flows?.isoniazidSpellingRedCase,
      evidence.flows?.clopidogrelSpellingRedCase,
      evidence.flows?.xylometazolineSpellingRedCase
    ];
    const criticalDuplicateFlows = [
      { flow: evidence.flows?.nimesulideSpellingDuplicate, ingredientNeedle: null },
      { flow: evidence.flows?.isoniazidSpellingDuplicate, ingredientNeedle: null },
      { flow: evidence.flows?.clopidogrelSpellingDuplicate, ingredientNeedle: null },
      { flow: evidence.flows?.caffeineCompoundDuplicate, ingredientNeedle: "카페인" },
      {
        flow: evidence.flows?.lysineAcetateDuplicate,
        ingredientNeedle: "리신",
        requireFailedType: true
      }
    ];
    const brandEmergencyCases = evidence.flows?.brandEmergencyCases;
    const brandNonEmergencyCases = evidence.flows?.brandNonEmergencyCases;
    const potentialOverdoseCases = evidence.flows?.potentialOverdoseCases;
    const missingIngredient = evidence.flows?.ingredientMissingFailClosed;
    const verifiedRedOrigins = new Set(["DUR_SNAPSHOT", "DUR_INGREDIENT_SNAPSHOT"]);
    const flowsOk =
      evidence.flows?.resolved?.length === 4 &&
      evidence.flows.resolved.every((item) => item.status === "CONFIRMED" && item.itemSeq) &&
      duplicate?.findings?.some((finding) => finding.type === "DUP_INGREDIENT") === true &&
      !duplicate.failedTypes?.includes("DUP_INGREDIENT") &&
      red?.verdict === "WARN" &&
      red.findings?.some(
        (finding) =>
          finding.type === "USJNT_TABOO" &&
          finding.level === "RED" &&
          verifiedRedOrigins.has(finding.origin ?? "")
      ) === true &&
      !red.failedTypes?.includes("USJNT_TABOO") &&
      playMcpTextHandoff?.source === "content" &&
      playMcpTextHandoff.queryCount === 2 &&
      playMcpTextHandoff.serverReresolved === true &&
      playMcpTextHandoff.verdict === "WARN" &&
      playMcpTextHandoff.redFinding === true &&
      playMcpTextHandoff.unresolvedCount === 0 &&
      explanation?.found === true &&
      explanation.status === "FOUND" &&
      explanation.itemSeq === "202106092" &&
      catalogCoverage?.checkedTypes?.includes("USJNT_TABOO") === true &&
      !catalogCoverage.failedTypes?.includes("USJNT_TABOO") &&
      catalogRed?.verdict === "WARN" &&
      catalogRed.findings?.some(
        (finding) =>
          finding.type === "USJNT_TABOO" &&
          finding.level === "RED" &&
          finding.origin === "DUR_INGREDIENT_SNAPSHOT"
      ) === true &&
      !catalogRed.failedTypes?.includes("USJNT_TABOO") &&
      conservativeFormRed?.verdict === "WARN" &&
      conservativeFormRed.findings?.some(
        (finding) =>
          finding.type === "USJNT_TABOO" &&
          finding.level === "RED" &&
          finding.origin === "DUR_INGREDIENT_SNAPSHOT"
      ) === true &&
      !conservativeFormRed.failedTypes?.includes("USJNT_TABOO") &&
      criticalMappingFlows.every(
        (flow) =>
          flow?.verdict === "WARN" &&
          flow.findings?.some(
            (finding) =>
              finding.type === "USJNT_TABOO" &&
              finding.level === "RED" &&
              verifiedRedOrigins.has(finding.origin ?? "")
          ) === true &&
          !flow.failedTypes?.includes("USJNT_TABOO")
      ) &&
      criticalDuplicateFlows.every(
        ({ flow, ingredientNeedle, requireFailedType }) => {
          const duplicateFailed = flow?.failedTypes?.includes("DUP_INGREDIENT") === true;
          return (
            ["CAUTION", "UNCERTAIN", "WARN"].includes(flow?.verdict ?? "") &&
            flow?.findings?.some(
              (finding) =>
                finding.type === "DUP_INGREDIENT" &&
                (!ingredientNeedle || finding.reason?.includes(ingredientNeedle))
            ) === true &&
            (requireFailedType === true ? duplicateFailed : !duplicateFailed)
          );
        }
      ) &&
      exactEvidenceNotes(brandEmergencyCases, CRITICAL_EMERGENCY_TEXT_PROBES) &&
      brandEmergencyCases.every(
        (flow) =>
          flow.resolveEmergency === true &&
          flow.verdict === "WARN" &&
          flow.findings?.some((finding) => finding.type === "EMERGENCY") === true
      ) &&
      exactEvidenceNotes(brandNonEmergencyCases, CRITICAL_NON_EMERGENCY_TEXT_PROBES) &&
      brandNonEmergencyCases.every(
        (flow) =>
          flow.resolveEmergency !== true &&
          flow.findings?.some((finding) => finding.type === "EMERGENCY") !== true &&
          flow.failedTypes?.includes("EMERGENCY_TRIAGE") !== true
      ) &&
      exactEvidenceNotes(potentialOverdoseCases, CRITICAL_POTENTIAL_OVERDOSE_TEXT_PROBES) &&
      potentialOverdoseCases.every(
        (flow) =>
          flow.resolveEmergency !== true &&
          flow.resolveTriageStatus === "UNCERTAIN" &&
          flow.resolveHoldPreserved === true &&
          flow.verdict === "UNCERTAIN" &&
          flow.findings?.some((finding) => finding.type === "CONTEXT_UNKNOWN") === true &&
          flow.findings?.some((finding) => finding.type === "EMERGENCY") !== true &&
          flow.failedTypes?.includes("EMERGENCY_TRIAGE") === true
      ) &&
      missingIngredient?.verdict === "UNCERTAIN" &&
      missingIngredient.failedTypes?.includes("USJNT_TABOO") === true;
    const readinessOk =
      evidence.readiness?.ok === true &&
      evidence.readiness.dataMode === "live" &&
      evidence.readiness.dataSource === "PUBLIC_DATA_LIVE" &&
      evidence.readiness.dataModelVersion === "3" &&
      evidence.readiness.buildId === evidence.buildId &&
      evidence.readiness.dataSha256 === evidence.dataSha256 &&
      evidence.readiness.criticalSafety?.ok === true &&
      evidence.readiness.criticalSafety.checked === CRITICAL_RELEASE_SAFETY_PROBE_COUNT &&
      evidence.readiness.coverage?.curatedDur?.ratio === 1 &&
      (evidence.readiness.coverage?.ingredientDur?.ratio ?? 0) >= 0.8 &&
      evidence.readiness.coverage?.activeCatalogIdentityMapping?.ratio === 1;
    const performanceOperations = [
      "resolve_medications",
      "check_duplicate_ingredient",
      "check_red_case",
      "explain_medication"
    ];
    const detailedPerformanceOk =
      performanceOperations.every((name) => {
        const values = evidence.performance?.byOperation?.[name];
        return (
          (values?.samples ?? 0) >= 20 &&
          (values?.averageMs ?? Number.POSITIVE_INFINITY) <= 100 &&
          (values?.p99Ms ?? Number.POSITIVE_INFINITY) <= 3000
        );
      }) &&
      (evidence.performance?.concurrent?.samples ?? 0) >= 8 &&
      (evidence.performance?.concurrent?.p99Ms ?? Number.POSITIVE_INFINITY) <= 3000 &&
      (evidence.performance?.coldConnections?.samples ?? 0) >= 3 &&
      (evidence.performance?.coldConnections?.p99Ms ?? Number.POSITIVE_INFINITY) <= 3000;
    const strictPerformanceEvidenceOk =
      evidence.performance?.profile === "strict" &&
      evidence.performance.averageRequirementCertified === true &&
      evidence.performance.averageLimitMs === 100 &&
      evidence.performance.p99LimitMs === 3000;
    const ok =
      evidence.schemaVersion === 1 &&
      endpointOk &&
      evidence.buildId === BUILD_ID &&
      evidence.verificationId === VERIFICATION_ID &&
      evidence.dataSha256 === localSha &&
      Number.isFinite(checkedAtMs) &&
      timestampWithinPastWindow(evidence.checkedAt, 24 * 60 * 60 * 1000) &&
      readinessOk &&
      toolsOk &&
      flowsOk &&
      !rawEvidence.includes('"confirmationToken"') &&
      strictPerformanceEvidenceOk &&
      (evidence.performance?.samples ?? 0) >= 100 &&
      (evidence.performance?.averageMs ?? Number.POSITIVE_INFINITY) <= 100 &&
      (evidence.performance?.p99Ms ?? Number.POSITIVE_INFINITY) <= 3000 &&
      detailedPerformanceOk;
    checksToUpdate.push({
      name: "remote evidence matches release artifact",
      ok,
      detail: `${evidence.endpoint ?? "missing"} @ ${evidence.checkedAt ?? "missing"}; schema=${String(evidence.schemaVersion)} tools=${toolsOk} flows=${flowsOk} readiness=${readinessOk} performance=${detailedPerformanceOk} profile=${evidence.performance?.profile ?? "missing"} certified=${strictPerformanceEvidenceOk}`,
      severity: requireRemote ? "error" : "warn"
    });
  } catch (error) {
    checksToUpdate.push({
      name: "remote evidence is valid JSON",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      severity: requireRemote ? "error" : "warn"
    });
  }
}

function exactEvidenceNotes<T extends { notes?: string }>(
  flows: T[] | undefined,
  expectedNotes: readonly string[]
): flows is Array<T & { notes: string }> {
  if (!flows || flows.length !== expectedNotes.length) return false;
  const actual = flows.map((flow) => flow.notes).filter((notes): notes is string => Boolean(notes));
  if (actual.length !== expectedNotes.length || new Set(actual).size !== expectedNotes.length) {
    return false;
  }
  const expected = new Set(expectedNotes);
  return actual.every((notes) => expected.has(notes));
}

function addInspectorEvidenceChecks(checksToUpdate: Check[]): void {
  if (!existsSync(inspectorEvidencePath)) return;
  try {
    const evidence = JSON.parse(readFileSync(inspectorEvidencePath, "utf8")) as {
      schemaVersion?: number;
      endpoint?: string;
      checkedAt?: string;
      buildId?: string;
      verificationId?: string;
      dataSha256?: string;
      inspectorVersion?: string;
      tools?: Array<{
        name?: string;
        annotations?: {
          title?: string;
          readOnlyHint?: boolean;
          destructiveHint?: boolean;
          openWorldHint?: boolean;
          idempotentHint?: boolean;
        };
      }>;
    };
    const expected = [
      "resolve_medications",
      "check_medication_safety",
      "explain_medication"
    ];
    const tools = Array.isArray(evidence.tools) ? evidence.tools : [];
    const localDataSha256 = createHash("sha256")
      .update(readFileSync(config.masterDbPath))
      .digest("hex");
    const checkedAt = Date.parse(evidence.checkedAt ?? "");
    const ok =
      evidence.schemaVersion === 1 &&
      evidence.endpoint === new URL(SUBMISSION_MCP_ENDPOINT).toString() &&
      Number.isFinite(checkedAt) &&
      timestampWithinPastWindow(evidence.checkedAt, 24 * 60 * 60 * 1000) &&
      evidence.buildId === BUILD_ID &&
      evidence.verificationId === VERIFICATION_ID &&
      evidence.dataSha256 === localDataSha256 &&
      evidence.inspectorVersion ===
        packageJson.devDependencies?.["@modelcontextprotocol/inspector"] &&
      tools.length === expected.length &&
      expected.every((name) => tools.some((tool) => tool.name === name)) &&
      tools.every(
        (tool) =>
          Boolean(tool.annotations?.title) &&
          tool.annotations?.readOnlyHint === true &&
          tool.annotations.destructiveHint === false &&
          typeof tool.annotations.openWorldHint === "boolean" &&
          typeof tool.annotations.idempotentHint === "boolean"
      );
    checksToUpdate.push({
      name: "Inspector evidence exposes exact read-only tools",
      ok,
      detail: `${evidence.endpoint ?? "missing"} @ ${evidence.checkedAt ?? "missing"}; build=${evidence.buildId ?? "missing"}; tools=${tools.map((tool) => tool.name ?? "missing").join(", ") || "missing"}`,
      severity: requireRemote ? "error" : "warn"
    });
  } catch (error) {
    checksToUpdate.push({
      name: "Inspector evidence is valid JSON",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      severity: requireRemote ? "error" : "warn"
    });
  }
}

const hasErrors = checks.some((check) => !check.ok && check.severity === "error");
if (hasErrors) {
  process.exitCode = 1;
}

function fileCheck(name: string, path: string, severity: Check["severity"]): Check {
  return {
    name,
    ok: existsSync(path),
    detail: path,
    severity
  };
}

function hashCheck(
  name: string,
  path: string,
  expected: string,
  severity: Check["severity"]
): Check {
  if (!existsSync(path)) {
    return { name, ok: false, detail: `${path} missing`, severity };
  }
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  return {
    name,
    ok: actual === expected,
    detail: actual,
    severity
  };
}

function documentValueCheck(
  name: string,
  path: string,
  expected: string,
  severity: Check["severity"]
): Check {
  const content = existsSync(path) ? readFileSync(path, "utf8") : "";
  return {
    name,
    ok: content.includes(expected),
    detail: expected,
    severity
  };
}

function liveTranscriptCheck(severity: Check["severity"]): Check {
  const path = "docs/submission/demo-transcript.generated.md";
  const content = existsSync(path) ? readFileSync(path, "utf8") : "";
  const liveMarker =
    "Generated from the local MCP server with a verified live public-data snapshot.";
  const dataSha256 = createHash("sha256")
    .update(readFileSync(config.masterDbPath))
    .digest("hex");
  const buildMarker = `Build ID: \`${BUILD_ID}\``;
  const dataMarker = `Data SHA-256: \`${dataSha256}\``;
  return {
    name: "demo transcript is generated from the release live DB",
    ok:
      content.includes(liveMarker) &&
      (!strictLive || (content.includes(buildMarker) && content.includes(dataMarker))) &&
      !/DEMO_FIXTURE|\[DEMO\]|with fixture data/i.test(content),
    detail:
      content.includes(liveMarker) && content.includes(buildMarker) && content.includes(dataMarker)
        ? "live marker, build ID, and DB SHA present"
        : "fixture, stale build/data identity, or missing live marker",
    severity
  };
}

async function addDatabaseAndLiveChecks(checksToUpdate: Check[]): Promise<void> {
  const services = await createAppServices(config);
  try {
    const storedCounts = services.repository.getStoredCounts();
    const mappingBasisCounts = services.repository.getDurIngredientMappingBasisCounts();
    const source = services.repository.metadata("source");
    checksToUpdate.push({
      name: "master DB source is submission-grade",
      ok: strictLive ? source === "PUBLIC_DATA_LIVE" : source !== "DEMO_FIXTURE",
      detail: source ?? "unknown",
      severity: strictLive ? "error" : "warn"
    });
    const declaredProductCount = Number(services.repository.metadata("productCount") ?? "0");
    const productCount = storedCounts.productCount ?? 0;
    checksToUpdate.push({
      name: "master DB product count",
      ok:
        (strictLive ? productCount >= 10000 : productCount > 0) &&
        (!strictLive || declaredProductCount === productCount),
      detail: `${productCount} actual, ${declaredProductCount} declared`,
      severity: strictLive ? "error" : "warn"
    });
    for (const [name, key, minimum] of [
      ["master DB ingredient rows", "ingredientCount", 10000],
      ["master DB ingredient DUR identity relations", "productIngredientDurKeyCount", 10000],
      ["master DB e약은요 rows", "easyDrugInfoCount", 1000],
      ["master DB DUR snapshots", "durSnapshotCount", 2],
      ["master DB DUR ingredient rules", "durIngredientFindingCount", 100]
    ] as const) {
      const declaredCount = Number(services.repository.metadata(key) ?? "0");
      const count = storedCounts[key] ?? 0;
      checksToUpdate.push({
        name,
        ok:
          (strictLive ? count >= minimum : count >= 0) &&
          (!strictLive || declaredCount === count),
        detail: `${count} actual, ${declaredCount} declared`,
        severity: strictLive ? "error" : "warn"
      });
    }
    const durSnapshotCount = storedCounts.durSnapshotCount ?? 0;
    const curatedDurProductCount = Number(
      services.repository.metadata("curatedDurProductCount") ?? "0"
    );
    checksToUpdate.push({
      name: "curated DUR snapshot coverage",
      ok:
        !strictLive ||
        (curatedDurProductCount >= 2 && durSnapshotCount === curatedDurProductCount),
      detail: `${durSnapshotCount}/${curatedDurProductCount}`,
      severity: strictLive ? "error" : "warn"
    });
    const productApiTotalCount = Number(
      services.repository.metadata("productApiTotalCount") ?? "-1"
    );
    const mfdsDurProductCount = Number(
      services.repository.metadata("mfdsDurProductCount") ?? "-1"
    );
    const productCancelledRowCount = Number(
      services.repository.metadata("productCancelledRowCount") ?? "-1"
    );
    const productInvalidRowCount = Number(
      services.repository.metadata("productInvalidRowCount") ?? "-1"
    );
    const productDuplicateItemSeqCount = Number(
      services.repository.metadata("productDuplicateItemSeqCount") ?? "-1"
    );
    checksToUpdate.push({
      name: "MFDS product source row reconciliation",
      ok:
        !strictLive ||
        (productApiTotalCount ===
          mfdsDurProductCount +
            productCancelledRowCount +
            productInvalidRowCount +
            productDuplicateItemSeqCount &&
          productDuplicateItemSeqCount === 0),
      detail: `total=${productApiTotalCount}, accepted=${mfdsDurProductCount}, cancelled=${productCancelledRowCount}, invalid=${productInvalidRowCount}, duplicate=${productDuplicateItemSeqCount}`,
      severity: strictLive ? "error" : "warn"
    });
    const easyDrugApiTotalCount = Number(
      services.repository.metadata("easyDrugApiTotalCount") ?? "-1"
    );
    const easyDrugInvalidRowCount = Number(
      services.repository.metadata("easyDrugInvalidRowCount") ?? "-1"
    );
    const easyDrugDuplicateItemSeqCount = Number(
      services.repository.metadata("easyDrugDuplicateItemSeqCount") ?? "-1"
    );
    const easyDrugConflictingItemSeqCount = Number(
      services.repository.metadata("easyDrugConflictingItemSeqCount") ?? "-1"
    );
    checksToUpdate.push({
      name: "e약은요 source row reconciliation",
      ok:
        !strictLive ||
        (easyDrugApiTotalCount ===
          (storedCounts.easyDrugInfoCount ?? 0) +
            easyDrugInvalidRowCount +
            easyDrugDuplicateItemSeqCount &&
          easyDrugConflictingItemSeqCount === 0),
      detail: `total=${easyDrugApiTotalCount}, accepted=${storedCounts.easyDrugInfoCount ?? 0}, invalid=${easyDrugInvalidRowCount}, duplicate=${easyDrugDuplicateItemSeqCount}, conflicting=${easyDrugConflictingItemSeqCount}`,
      severity: strictLive ? "error" : "warn"
    });
    const overallDurCoverage = Number(
      services.repository.metadata("overallDurSnapshotCoverageRatio") ?? "0"
    );
    checksToUpdate.push({
      name: "overall DUR coverage disclosed",
      ok: !strictLive || (overallDurCoverage > 0 && overallDurCoverage <= 1),
      detail: `${(overallDurCoverage * 100).toFixed(3)}% of resolvable products`,
      severity: strictLive ? "error" : "warn"
    });
    const durIngredientCatalogComplete =
      services.repository.metadata("durIngredientCatalogComplete") === "true";
    const declaredDurIngredientCoverage = Number(
      services.repository.metadata("durIngredientProductCoverageRatio") ?? "0"
    );
    const declaredDurIngredientCoverageCount = Number(
      services.repository.metadata("durIngredientProductCoverageCount") ?? "0"
    );
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
    const verifiedDurIngredientCoverage = services.repository.getDurIngredientCoverage();
    checksToUpdate.push({
      name: "complete DUR ingredient catalog",
      ok: !strictLive || durIngredientCatalogComplete,
      detail: String(durIngredientCatalogComplete),
      severity: strictLive ? "error" : "warn"
    });
    checksToUpdate.push({
      name: "DUR catalog identity disclosure",
      ok:
        !strictLive ||
        (declaredCatalogIdentityCount === verifiedDurIngredientCoverage.catalogIdentityCount &&
          declaredMappedCatalogIdentityCount ===
            verifiedDurIngredientCoverage.mappedCatalogIdentityCount &&
          declaredUnmappedCatalogIdentityCount ===
            verifiedDurIngredientCoverage.unmappedCatalogIdentityCount &&
          Math.abs(
            declaredCatalogMappingRatio - verifiedDurIngredientCoverage.catalogMappingRatio
          ) < 0.000001),
      detail: `${(verifiedDurIngredientCoverage.catalogMappingRatio * 100).toFixed(3)}% verified (${verifiedDurIngredientCoverage.mappedCatalogIdentityCount}/${verifiedDurIngredientCoverage.catalogIdentityCount}), declared=${(declaredCatalogMappingRatio * 100).toFixed(3)}%`,
      severity: strictLive ? "error" : "warn"
    });
    checksToUpdate.push({
      name: "active-product DUR identity mapping",
      ok:
        !strictLive ||
        (declaredActiveCatalogIdentityCount >= 100 &&
          declaredActiveMappedCatalogIdentityCount === declaredActiveCatalogIdentityCount &&
          declaredActiveCatalogMappingRatio === 1),
      detail: `${declaredActiveMappedCatalogIdentityCount}/${declaredActiveCatalogIdentityCount} (${(declaredActiveCatalogMappingRatio * 100).toFixed(3)}%)`,
      severity: strictLive ? "error" : "warn"
    });
    const activeOfficialRelationCount = Number(
      services.repository.metadata("durIngredientActiveOfficialRelationCount") ?? "-1"
    );
    const activeOfficialRelationMappedCount = Number(
      services.repository.metadata("durIngredientActiveOfficialRelationMappedCount") ?? "-1"
    );
    checksToUpdate.push({
      name: "active-product official DUR relation mapping",
      ok:
        !strictLive ||
        (activeOfficialRelationCount >= 100 &&
          activeOfficialRelationMappedCount === activeOfficialRelationCount),
      detail: `${activeOfficialRelationMappedCount}/${activeOfficialRelationCount}`,
      severity: strictLive ? "error" : "warn"
    });
    const riskyFallbackCount = Number(
      services.repository.metadata("durIngredientRiskyFallbackMappingCount") ?? "-1"
    );
    const ambiguousFormCount = Number(
      services.repository.metadata("durIngredientAmbiguousFormMappingCount") ?? "-1"
    );
    const curatedSpellingCount = Number(
      services.repository.metadata("durIngredientCuratedSpellingMappingCount") ?? "-1"
    );
    const catalogAbsentCount = Number(
      services.repository.metadata("durIngredientCatalogAbsentMappingCount") ?? "-1"
    );
    checksToUpdate.push({
      name: "DUR mapping provenance matches stored relations",
      ok:
        !strictLive ||
        ((mappingBasisCounts.FALLBACK ?? 0) === riskyFallbackCount &&
          (mappingBasisCounts.AMBIGUOUS_FORM ?? 0) === ambiguousFormCount &&
          (mappingBasisCounts.CURATED_SPELLING ?? 0) === curatedSpellingCount &&
          (mappingBasisCounts.CATALOG_ABSENT ?? 0) === catalogAbsentCount),
      detail: `fallback=${mappingBasisCounts.FALLBACK ?? 0}/${riskyFallbackCount}, ambiguous=${mappingBasisCounts.AMBIGUOUS_FORM ?? 0}/${ambiguousFormCount}, curatedSpelling=${mappingBasisCounts.CURATED_SPELLING ?? 0}/${curatedSpellingCount}, absent=${mappingBasisCounts.CATALOG_ABSENT ?? 0}/${catalogAbsentCount}`,
      severity: strictLive ? "error" : "warn"
    });
    checksToUpdate.push({
      name: "DUR ingredient product coverage",
      ok:
        !strictLive ||
        (verifiedDurIngredientCoverage.ratio >= 0.8 &&
          declaredDurIngredientCoverageCount === verifiedDurIngredientCoverage.coveredProducts &&
          Math.abs(declaredDurIngredientCoverage - verifiedDurIngredientCoverage.ratio) < 0.000001),
      detail: `${(verifiedDurIngredientCoverage.ratio * 100).toFixed(3)}% verified (${verifiedDurIngredientCoverage.coveredProducts}/${verifiedDurIngredientCoverage.totalProducts}), declared=${(declaredDurIngredientCoverage * 100).toFixed(3)}%`,
      severity: strictLive ? "error" : "warn"
    });
    const durIngredientApiTotalCount = Number(
      services.repository.metadata("durIngredientApiTotalCount") ?? "-1"
    );
    const durIngredientActiveRowCount = Number(
      services.repository.metadata("durIngredientActiveRowCount") ?? "-1"
    );
    const durIngredientDeletedRowCount = Number(
      services.repository.metadata("durIngredientDeletedRowCount") ?? "-1"
    );
    const durIngredientDuplicateRuleCount = Number(
      services.repository.metadata("durIngredientDuplicateRuleCount") ?? "-1"
    );
    const durIngredientFindingCount = storedCounts.durIngredientFindingCount ?? -1;
    checksToUpdate.push({
      name: "DUR ingredient source row reconciliation",
      ok:
        !strictLive ||
        (durIngredientApiTotalCount ===
          durIngredientActiveRowCount + durIngredientDeletedRowCount &&
          durIngredientActiveRowCount ===
            durIngredientFindingCount + durIngredientDuplicateRuleCount),
      detail: `total=${durIngredientApiTotalCount}, active=${durIngredientActiveRowCount}, deleted=${durIngredientDeletedRowCount}, unique=${durIngredientFindingCount}, duplicate=${durIngredientDuplicateRuleCount}`,
      severity: strictLive ? "error" : "warn"
    });
    for (const [name, key] of [
      ["invalid ingredient rows", "invalidIngredientRowCount"],
      ["replicated product ingredient codes", "replicatedProductIngredientCodeCount"],
      ["DUR snapshot target ingredient mismatches", "snapshotTargetIngredientMismatchCount"],
      ["unparsed DUR relation fields", "durIngredientUnparsedRelationFieldCount"],
      ["unparsed DUR mixture fields", "durIngredientUnparsedMixtureFieldCount"]
    ] as const) {
      const count = Number(services.repository.metadata(key) ?? "-1");
      checksToUpdate.push({
        name,
        ok: !strictLive || count === 0,
        detail: String(count),
        severity: strictLive ? "error" : "warn"
      });
    }
    const dataModelVersion = services.repository.metadata("dataModelVersion");
    checksToUpdate.push({
      name: "master DB data model version",
      ok: strictLive ? dataModelVersion === "3" : true,
      detail: dataModelVersion ?? "fixture-v1",
      severity: strictLive ? "error" : "warn"
    });
    if (strictLive) {
      const fixedProbeProducts = FIXED_RELEASE_PROBE_ITEM_SEQS.map((itemSeq) =>
        services.repository.getProduct(itemSeq)
      );
      const dynamicProbeProducts = selectReleaseProbeProducts(services.repository);
      const fixedOk = fixedProbeProducts.every(Boolean);
      const dynamicOk = Boolean(
        dynamicProbeProducts.catalogCovered &&
          dynamicProbeProducts.catalogRedPair &&
          dynamicProbeProducts.ingredientMissing
      );
      checksToUpdate.push({
        name: "remote verification representative products",
        ok: fixedOk && dynamicOk,
        detail: `fixed=${fixedProbeProducts.filter(Boolean).length}/${FIXED_RELEASE_PROBE_ITEM_SEQS.length}, catalogCovered=${dynamicProbeProducts.catalogCovered?.itemSeq ?? "missing"}, catalogRedPair=${dynamicProbeProducts.catalogRedPair ? `${dynamicProbeProducts.catalogRedPair.source.itemSeq}+${dynamicProbeProducts.catalogRedPair.target.itemSeq}` : "missing"}, ingredientMissing=${dynamicProbeProducts.ingredientMissing?.itemSeq ?? "missing"}`,
        severity: "error"
      });
      const criticalFailures = await criticalReleaseSafetyFailures(
        services.repository,
        services.safety,
        services.resolver
      );
      checksToUpdate.push({
        name: "critical false-green safety probes",
        ok: criticalFailures.length === 0,
        detail:
          criticalFailures.length === 0
            ? `${CRITICAL_RELEASE_SAFETY_PROBE_COUNT}/${CRITICAL_RELEASE_SAFETY_PROBE_COUNT}`
            : criticalFailures.join("; "),
        severity: "error"
      });
    }
    const generationId = services.repository.metadata("generationId");
    checksToUpdate.push({
      name: "master DB generation ID",
      ok: strictLive ? Boolean(generationId) : true,
      detail: generationId ?? "fixture-v1",
      severity: strictLive ? "error" : "warn"
    });
    const fetchedAt = services.repository.metadata("fetchedAt");
    const fresh = timestampWithinPastWindow(
      fetchedAt,
      config.dataMaxAgeDays * 24 * 60 * 60 * 1000
    );
    checksToUpdate.push({
      name: "master DB source freshness",
      ok: strictLive ? fresh : true,
      detail: fetchedAt ?? "fixture-v1",
      severity: strictLive ? "error" : "warn"
    });

    if (!strictLive) return;
    if (
      config.dataMode !== "live" ||
      !config.liveSelfTestItemSeq ||
      !config.liveSelfTestTargetItemSeq ||
      !config.confirmationSecret ||
      !config.liveSelfTestExpectContraindication
    ) {
      checksToUpdate.push({
        name: "live DUR self-test",
        ok: false,
        detail: "skipped because strict live env is incomplete",
        severity: "error"
      });
      return;
    }

    const selfTest = await services.durClient.selfTest();
    checksToUpdate.push({
      name: "live DUR self-test",
      ok: selfTest.ok,
      detail: selfTest.message,
      severity: "error"
    });
  } finally {
    services.repository.close();
  }
}
