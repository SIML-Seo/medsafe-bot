import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "../src/config/env.js";
import { DUR_BASE_URLS } from "../src/config/schemaMap.js";
import { createAppServices } from "../src/app.js";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  severity: "error" | "warn";
}

const strictLive = process.argv.includes("--strict-live");
const config = loadConfig(process.env);
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts?: Record<string, string>;
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
  fileCheck("widget mapping", "docs/submission/widget-mapping.md", "error"),
  fileCheck("widget preview", "docs/submission/widget-preview.html", "error"),
  fileCheck("live data checklist", "docs/submission/live-data-checklist.md", "error"),
  fileCheck("live evidence", "docs/submission/live-evidence-2026-07-07.md", "warn"),
  {
    name: "DUR HTTPS only",
    ok: DUR_BASE_URLS.every((url) => url.startsWith("https://")),
    detail: DUR_BASE_URLS.join(", "),
    severity: "error"
  },
  {
    name: "cross-platform test script",
    ok: packageJson.scripts?.test === "node scripts/run-tests.mjs",
    detail: packageJson.scripts?.test ?? "missing",
    severity: "error"
  },
  {
    name: "demo transcript script configured",
    ok: Boolean(packageJson.scripts?.["demo:transcript"]),
    detail: packageJson.scripts?.["demo:transcript"] ?? "missing",
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
    ok: config.dataMode !== "live" || Boolean(config.confirmationSecret),
    detail:
      config.dataMode === "live"
        ? config.confirmationSecret
          ? "configured"
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
    name: "MFDS service key",
    ok: Boolean(config.mfdsServiceKey),
    detail: config.mfdsServiceKey ? "configured" : "missing",
    severity: strictLive ? "error" : "warn"
  },
  {
    name: "live self-test itemSeq",
    ok: Boolean(config.liveSelfTestItemSeq),
    detail: config.liveSelfTestItemSeq ? "configured" : "missing",
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

for (const check of checks) {
  const prefix = check.ok ? "ok" : check.severity === "error" ? "ERROR" : "WARN";
  console.log(`${prefix} ${check.name}: ${check.detail}`);
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

async function addDatabaseAndLiveChecks(checksToUpdate: Check[]): Promise<void> {
  const services = await createAppServices(config);
  try {
    const source = services.repository.metadata("source");
    checksToUpdate.push({
      name: "master DB source is submission-grade",
      ok: strictLive ? source === "PUBLIC_DATA_LIVE" : source !== "DEMO_FIXTURE",
      detail: source ?? "unknown",
      severity: strictLive ? "error" : "warn"
    });
    const productCount = Number(services.repository.metadata("productCount") ?? "0");
    checksToUpdate.push({
      name: "master DB product count",
      ok: strictLive ? productCount >= 10000 : productCount > 0,
      detail: String(productCount),
      severity: strictLive ? "error" : "warn"
    });

    if (!strictLive) return;
    if (
      config.dataMode !== "live" ||
      !config.mfdsServiceKey ||
      !config.liveSelfTestItemSeq ||
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
