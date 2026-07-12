import { performance } from "node:perf_hooks";
import { setMaxListeners } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { computeBuildId, computeVerificationId } from "../src/version.js";
import { omitConfirmationTokens } from "../src/utils/redact.js";
import { SUBMISSION_MCP_ENDPOINT } from "../src/config/schemaMap.js";
import { timestampWithinPastWindow } from "../src/utils/time.js";
import { MasterRepository } from "../src/repositories/masterRepository.js";
import { MedicationResolver } from "../src/services/medicationResolver.js";
import {
  CRITICAL_DUPLICATE_INGREDIENT_PROBES,
  CRITICAL_DUR_RED_PROBES,
  CRITICAL_EMERGENCY_TEXT_PROBES,
  CRITICAL_NON_EMERGENCY_TEXT_PROBES,
  CRITICAL_POTENTIAL_OVERDOSE_TEXT_PROBES,
  CRITICAL_RELEASE_SAFETY_PROBE_COUNT,
  selectReleaseProbeProducts
} from "../src/utils/releaseProbes.js";

const BUILD_ID = computeBuildId();
const VERIFICATION_ID = computeVerificationId();

const endpoint = new URL(
  process.env.REMOTE_ENDPOINT?.trim() || SUBMISSION_MCP_ENDPOINT
);
const performanceProfile = remotePerformanceProfile(process.env.REMOTE_PERFORMANCE_PROFILE);
const averageLimitMs = 100;
const p99LimitMs = 3000;
const performanceSamples = Math.max(100, numberEnv("REMOTE_PERF_SAMPLES", 100));
const concurrentSamples = Math.max(8, numberEnv("REMOTE_CONCURRENT_SAMPLES", 8));
const coldConnectionSamples = Math.max(3, numberEnv("REMOTE_COLD_SAMPLES", 5));
const evidencePath = resolve(
  process.env.REMOTE_EVIDENCE_PATH?.trim() ||
    "docs/submission/remote-verification.generated.json"
);
// The SDK reuses one transport AbortSignal across this bounded verification run.
setMaxListeners(0);

const health = await getJson(new URL("/healthz", endpoint));
assert(health.response.ok && health.json.ok === true, "remote /healthz is not ready");
const ready = await getJson(new URL("/readyz", endpoint));
assert(ready.response.ok && ready.json.ok === true, "remote /readyz is not ready");
assert(ready.json.dataMode === "live", "remote readiness is not DATA_MODE=live");
assert(ready.json.dataSource === "PUBLIC_DATA_LIVE", "remote data source is not PUBLIC_DATA_LIVE");
assert(ready.json.dataModelVersion === "3", "remote data model is not version 3");
assert(ready.json.buildId === BUILD_ID, "remote build ID does not match the local source");
const localDataPath = process.env.MASTER_DB_PATH ?? "data/master.sqlite";
const localDataSha256 = createHash("sha256")
  .update(readFileSync(localDataPath))
  .digest("hex");
assert(ready.json.dataSha256 === localDataSha256, "remote master DB hash does not match local data");
assert(typeof ready.json.generationId === "string" && ready.json.generationId.length > 0, "remote generation ID is missing");
const remoteFetchedAt = Date.parse(String(ready.json.fetchedAt ?? ""));
assert(Number.isFinite(remoteFetchedAt), "remote fetchedAt is invalid");
assert(
  timestampWithinPastWindow(String(ready.json.fetchedAt ?? ""), 30 * 24 * 60 * 60 * 1000),
  "remote data snapshot is invalid, future, or older than 30 days"
);
const remoteCoverage = ready.json.coverage as
  | {
      durSnapshots?: { covered?: number; total?: number; ratio?: number; scope?: string };
      curatedDur?: { ratio?: number };
      ingredientDur?: { ratio?: number; scope?: string };
      catalogIdentityMapping?: { ratio?: number; scope?: string };
      activeCatalogIdentityMapping?: { ratio?: number; scope?: string };
    }
  | undefined;
assert(remoteCoverage?.curatedDur?.ratio === 1, "remote curated DUR snapshot coverage is incomplete");
assert(
  typeof remoteCoverage?.durSnapshots?.scope === "string" &&
    remoteCoverage.durSnapshots.scope.includes("curated"),
  "remote DUR coverage scope is not disclosed"
);
assert(
  (remoteCoverage?.ingredientDur?.ratio ?? 0) >= 0.8,
  "remote DUR ingredient coverage is below 80%"
);
assert(
  remoteCoverage?.ingredientDur?.scope?.includes("fully parsed") === true,
  "remote DUR ingredient coverage scope is not disclosed"
);
assert(
  remoteCoverage?.activeCatalogIdentityMapping?.ratio === 1,
  "remote active-product DUR identity mapping is incomplete"
);
assert(
  remoteCoverage?.activeCatalogIdentityMapping?.scope?.includes("active product") === true,
  "remote active-product DUR identity mapping scope is not disclosed"
);
const remoteCriticalSafety = ready.json.criticalSafety as
  | { checked?: number; ok?: boolean }
  | undefined;
assert(
  remoteCriticalSafety?.ok === true &&
    remoteCriticalSafety.checked === CRITICAL_RELEASE_SAFETY_PROBE_COUNT,
  `remote critical safety probes are incomplete: ${String(remoteCriticalSafety?.checked)}/${CRITICAL_RELEASE_SAFETY_PROBE_COUNT}`
);
const representativeRepository = await MasterRepository.open(localDataPath);
const representativeResolver = new MedicationResolver(representativeRepository);
const expectedPotentialReferences = new Map(
  CRITICAL_POTENTIAL_OVERDOSE_TEXT_PROBES.map((notes) => [
    notes,
    representativeResolver.medicationReferencesInText(notes)
  ])
);
const representativeProducts = selectReleaseProbeProducts(representativeRepository);
const conservativeFormProducts = ["200400910", "201200677"].map((itemSeq) =>
  representativeRepository.getProduct(itemSeq)
);
const criticalMappingPairs = CRITICAL_DUR_RED_PROBES.map((pair) => ({
  ...pair,
  products: pair.itemSeqs.map((itemSeq) => representativeRepository.getProduct(itemSeq))
}));
const criticalDuplicatePairs = CRITICAL_DUPLICATE_INGREDIENT_PROBES.map((pair) => ({
  ...pair,
  products: pair.itemSeqs.map((itemSeq) => representativeRepository.getProduct(itemSeq))
}));
assert(
  conservativeFormProducts.every(Boolean),
  "local release DB is missing the conservative-form RED products"
);
assert(
  conservativeFormProducts.every(
    (product) => representativeRepository.getDurSnapshot(product!.itemSeq) === null
  ),
  "conservative-form RED products must not depend on item snapshots"
);
for (const pair of criticalMappingPairs) {
  assert(pair.products.every(Boolean), `${pair.flow} products are missing from the release DB`);
}
for (const pair of criticalDuplicatePairs) {
  assert(pair.products.every(Boolean), `${pair.flow} products are missing from the release DB`);
}
representativeRepository.close();
assert(representativeProducts.catalogCovered, "local release DB has no unique catalog-covered product without an item snapshot");
assert(representativeProducts.catalogRedPair, "local release DB has no ingredient-only RED pair without item snapshots");
assert(representativeProducts.ingredientMissing, "local release DB has no unique ingredient-missing product without an item snapshot");

const client = new Client({ name: "medsafe-remote-verifier", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(endpoint);
let verificationStage = "connect";
try {
  await client.connect(transport);
  verificationStage = "tools/list";
  const listed = await client.listTools();
  const expectedTools = ["resolve_medications", "check_medication_safety", "explain_medication"];
  assert(
    expectedTools.every((name) => listed.tools.some((tool) => tool.name === name)),
    "remote tools/list does not expose all three required tools"
  );
  assert(listed.tools.length === 3, `remote exposes unexpected tool count: ${listed.tools.length}`);
  for (const tool of listed.tools) {
    const annotations = tool.annotations;
    assert(Boolean(annotations?.title), `${tool.name} annotations.title is missing`);
    assert(annotations?.readOnlyHint === true, `${tool.name} readOnlyHint must be true`);
    assert(annotations?.destructiveHint === false, `${tool.name} destructiveHint must be false`);
    assert(typeof annotations?.openWorldHint === "boolean", `${tool.name} openWorldHint is missing`);
    assert(typeof annotations?.idempotentHint === "boolean", `${tool.name} idempotentHint is missing`);
  }

  verificationStage = "representative resolve";
  const resolved = structured<{
    resolved: Array<{
      query: string;
      status: string;
      itemSeq: string | null;
      ingrCode: string | null;
      matchedName: string | null;
      confirmationToken?: string | null;
    }>;
  }>(
    await client.callTool({
      name: "resolve_medications",
      arguments: {
        queries: [
          "타이레놀정 500mg",
          "게보린정",
          "아스피린프로텍트정 100mg",
          "유한메토트렉세이트정"
        ]
      }
    })
  ).resolved;
  assert(resolved.length === 4, "resolve flow returned an unexpected item count");
  assert(resolved.every((item) => item.status === "CONFIRMED"), "representative products were not confirmed");
  assert(resolved.every((item) => item.confirmationToken), "confirmed products did not receive tokens");
  assert(resolved[0]?.itemSeq === "202106092", "타이레놀 500mg resolved to the wrong strength");
  assert(resolved[1]?.itemSeq === "197900277", "게보린정 resolved to the wrong itemSeq");
  assert(resolved[2]?.itemSeq === "200108429", "아스피린프로텍트 resolved to the wrong itemSeq");
  assert(resolved[3]?.itemSeq === "197900145", "유한메토트렉세이트 resolved to the wrong itemSeq");

  verificationStage = "representative duplicate";
  const duplicateResponse = await client.callTool({
    name: "check_medication_safety",
    arguments: {
      medications: resolved.slice(0, 2).map(checkInput),
      context: { ageGroup: "adult", pregnancy: "no" }
    }
  });
  const duplicate = structured<{
    verdict: string;
    findings: Array<{ type: string }>;
    failedTypes: string[];
  }>(duplicateResponse);
  assert(duplicateResponse.isError !== true, "duplicate-ingredient check returned a tool error");
  assert(
    duplicate.findings.some((finding) => finding.type === "DUP_INGREDIENT"),
    "타이레놀+게보린 did not detect duplicate acetaminophen"
  );
  assert(!duplicate.failedTypes.includes("DUP_INGREDIENT"), "duplicate ingredient was marked failed");

  verificationStage = "representative RED";
  const redResponse = await client.callTool({
    name: "check_medication_safety",
    arguments: {
      medications: resolved.slice(2, 4).map(checkInput),
      context: { ageGroup: "adult", pregnancy: "no" }
    }
  });
  const red = structured<{
    verdict: string;
    findings: Array<{ type: string; level: string }>;
    failedTypes: string[];
  }>(redResponse);
  assert(redResponse.isError !== true, "red-case check returned a tool error");
  assert(red.verdict === "WARN", `red-case verdict was ${red.verdict}`);
  assert(
    red.findings.some((finding) => finding.type === "USJNT_TABOO" && finding.level === "RED"),
    "red-case did not return a RED USJNT_TABOO finding"
  );
  assert(!red.failedTypes.includes("USJNT_TABOO"), "red-case DUR category was marked failed");

  verificationStage = "explanation";
  const explanationResponse = await client.callTool({
    name: "explain_medication",
    arguments: { itemSeq: "202106092" }
  });
  const explanation = structured<{ found: boolean; status: string; info: { itemSeq?: string } | null }>(
    explanationResponse
  );
  assert(explanationResponse.isError !== true, "explain_medication returned a tool error");
  assert(explanation.found && explanation.status === "FOUND", "타이레놀 explanation was not found");
  assert(explanation.info?.itemSeq === "202106092", "explanation returned the wrong itemSeq");

  verificationStage = "ingredient catalog coverage";
  const ingredientCatalogCovered = structured<{
    resolved: Array<{
      status: string;
      itemSeq: string | null;
      ingrCode: string | null;
      matchedName: string | null;
      confirmationToken?: string | null;
    }>;
  }>(
    await client.callTool({
      name: "resolve_medications",
      arguments: {
        queries: [representativeProducts.catalogCovered.name]
      }
    })
  ).resolved[0];
  assert(ingredientCatalogCovered?.status === "CONFIRMED", "catalog-covered product was not resolved");
  assert(
    ingredientCatalogCovered.itemSeq === representativeProducts.catalogCovered.itemSeq,
    "catalog-covered product resolved to the wrong itemSeq"
  );
  const ingredientCatalogCheck = structured<{
    verdict: string;
    checkedTypes: string[];
    failedTypes: string[];
  }>(
    await client.callTool({
      name: "check_medication_safety",
      arguments: {
        medications: [checkInput(ingredientCatalogCovered!)],
        context: { ageGroup: "adult", pregnancy: "no" }
      }
    })
  );
  assert(
    ingredientCatalogCheck.checkedTypes.includes("USJNT_TABOO"),
    "ingredient catalog did not cover a product without an item snapshot"
  );
  assert(
    !ingredientCatalogCheck.failedTypes.includes("USJNT_TABOO"),
    "ingredient-catalog-covered product was incorrectly marked as a DUR failure"
  );

  verificationStage = "ingredient catalog RED";
  const ingredientCatalogRedResolved = structured<{
    resolved: Array<{
      status: string;
      itemSeq: string | null;
      ingrCode: string | null;
      matchedName: string | null;
      confirmationToken?: string | null;
    }>;
  }>(
    await client.callTool({
      name: "resolve_medications",
      arguments: {
        queries: [
          representativeProducts.catalogRedPair.source.name,
          representativeProducts.catalogRedPair.target.name
        ]
      }
    })
  ).resolved;
  assert(
    ingredientCatalogRedResolved.length === 2 &&
      ingredientCatalogRedResolved.every((item) => item.status === "CONFIRMED"),
    "ingredient-only RED pair was not confirmed"
  );
  assert(
    ingredientCatalogRedResolved[0]?.itemSeq ===
      representativeProducts.catalogRedPair.source.itemSeq &&
      ingredientCatalogRedResolved[1]?.itemSeq ===
        representativeProducts.catalogRedPair.target.itemSeq,
    "ingredient-only RED pair resolved to the wrong products"
  );
  const ingredientCatalogRedResponse = await client.callTool({
    name: "check_medication_safety",
    arguments: {
      medications: ingredientCatalogRedResolved.map(checkInput),
      context: { ageGroup: "adult", pregnancy: "no" }
    }
  });
  const ingredientCatalogRed = structured<{
    verdict: string;
    findings: Array<{ type: string; level: string }>;
    failedTypes: string[];
  }>(ingredientCatalogRedResponse);
  assert(
    ingredientCatalogRedResponse.isError !== true,
    "ingredient-only RED pair returned a tool error"
  );
  assert(ingredientCatalogRed.verdict === "WARN", "ingredient-only RED pair did not return WARN");
  assert(
    ingredientCatalogRed.findings.some(
      (finding) => finding.type === "USJNT_TABOO" && finding.level === "RED"
    ),
    "ingredient-only RED pair did not return a RED USJNT_TABOO finding"
  );
  assert(
    !ingredientCatalogRed.failedTypes.includes("USJNT_TABOO"),
    "ingredient-only RED pair was marked as a DUR failure"
  );

  verificationStage = "conservative form RED";
  const conservativeFormResolved = structured<{
    resolved: Array<{
      status: string;
      itemSeq: string | null;
      ingrCode: string | null;
      matchedName: string | null;
      confirmationToken?: string | null;
    }>;
  }>(
    await client.callTool({
      name: "resolve_medications",
      arguments: { queries: conservativeFormProducts.map((product) => product!.name) }
    })
  ).resolved;
  assert(
    conservativeFormResolved.length === 2 &&
      conservativeFormResolved.every((item) => item.status === "CONFIRMED"),
    "conservative-form RED pair was not confirmed"
  );
  assert(
    conservativeFormResolved[0]?.itemSeq === "200400910" &&
      conservativeFormResolved[1]?.itemSeq === "201200677",
    "conservative-form RED pair resolved to the wrong products"
  );
  const conservativeFormResponse = await client.callTool({
    name: "check_medication_safety",
    arguments: {
      medications: conservativeFormResolved.map(checkInput),
      context: { ageGroup: "adult", pregnancy: "no" }
    }
  });
  const conservativeFormRed = structured<{
    verdict: string;
    findings: Array<{ type: string; level: string; origin: string }>;
    failedTypes: string[];
  }>(conservativeFormResponse);
  assert(conservativeFormResponse.isError !== true, "conservative-form RED pair returned a tool error");
  assert(conservativeFormRed.verdict === "WARN", "conservative-form RED pair did not return WARN");
  assert(
    conservativeFormRed.findings.some(
      (finding) =>
        finding.type === "USJNT_TABOO" &&
        finding.level === "RED" &&
        finding.origin === "DUR_INGREDIENT_SNAPSHOT"
    ),
    "conservative-form RED pair did not return an ingredient-catalog RED finding"
  );
  assert(
    !conservativeFormRed.failedTypes.includes("USJNT_TABOO"),
    "conservative-form RED pair was marked as a DUR failure"
  );

  const criticalMappingEvidence: Record<string, unknown> = {};
  verificationStage = "critical RED mappings";
  for (const pair of criticalMappingPairs) {
    verificationStage = `critical RED mapping: ${pair.flow}`;
    const resolvedPair = structured<{
      resolved: Array<{
        status: string;
        itemSeq: string | null;
        ingrCode: string | null;
        matchedName: string | null;
        confirmationToken?: string | null;
      }>;
    }>(
      await client.callTool({
        name: "resolve_medications",
        arguments: { queries: pair.products.map((product) => product!.name) }
      })
    ).resolved;
    assert(
      resolvedPair.length === 2 && resolvedPair.every((item) => item.status === "CONFIRMED"),
      `${pair.flow} products were not confirmed`
    );
    assert(
      resolvedPair.every((item, index) => item.itemSeq === pair.itemSeqs[index]),
      `${pair.flow} resolved to the wrong products`
    );
    const response = await client.callTool({
      name: "check_medication_safety",
      arguments: {
        medications: resolvedPair.map(checkInput),
        context: { ageGroup: "adult", pregnancy: "no" }
      }
    });
    const result = structured<{
      verdict: string;
      findings: Array<{ type: string; level: string; origin: string }>;
      failedTypes: string[];
    }>(response);
    assert(response.isError !== true, `${pair.flow} returned a tool error`);
    assert(
      result.verdict !== "NO_KNOWN_FINDINGS",
      `${pair.flow} returned a false-green verdict`
    );
    assert(result.verdict === "WARN", `${pair.flow} did not return WARN`);
    assert(
      result.findings.some(
        (finding) =>
          finding.type === "USJNT_TABOO" &&
          finding.level === "RED" &&
          (finding.origin === "DUR_INGREDIENT_SNAPSHOT" ||
            finding.origin === "DUR_SNAPSHOT")
      ),
      `${pair.flow} did not return a verified RED finding`
    );
    assert(
      !result.failedTypes.includes("USJNT_TABOO"),
      `${pair.flow} was marked as a DUR failure`
    );
    criticalMappingEvidence[pair.flow] = result;
  }

  const criticalDuplicateEvidence: Record<string, unknown> = {};
  verificationStage = "critical duplicate mappings";
  for (const pair of criticalDuplicatePairs) {
    verificationStage = `critical duplicate mapping: ${pair.flow}`;
    const resolvedPair = structured<{
      resolved: Array<{
        status: string;
        itemSeq: string | null;
        ingrCode: string | null;
        matchedName: string | null;
        confirmationToken?: string | null;
      }>;
    }>(
      await client.callTool({
        name: "resolve_medications",
        arguments: { queries: pair.products.map((product) => product!.name) }
      })
    ).resolved;
    assert(
      resolvedPair.length === 2 && resolvedPair.every((item) => item.status === "CONFIRMED"),
      `${pair.flow} products were not confirmed`
    );
    assert(
      resolvedPair.every((item, index) => item.itemSeq === pair.itemSeqs[index]),
      `${pair.flow} resolved to the wrong products`
    );
    const response = await client.callTool({
      name: "check_medication_safety",
      arguments: {
        medications: resolvedPair.map(checkInput),
        context: { ageGroup: "adult", pregnancy: "no" }
      }
    });
    const result = structured<{
      verdict: string;
      findings: Array<{ type: string; reason: string }>;
      failedTypes: string[];
    }>(response);
    assert(response.isError !== true, `${pair.flow} returned a tool error`);
    assert(
      result.verdict !== "NO_KNOWN_FINDINGS",
      `${pair.flow} returned a false-green verdict`
    );
    assert(
      result.findings.some(
        (finding) =>
          finding.type === "DUP_INGREDIENT" &&
          (!("ingredientNeedle" in pair) ||
            finding.reason.includes(pair.ingredientNeedle))
      ),
      `${pair.flow} did not return a duplicate ingredient finding`
    );
    const duplicateFailed = result.failedTypes.includes("DUP_INGREDIENT");
    const requireFailedType =
      "requireFailedType" in pair && pair.requireFailedType === true;
    assert(
      requireFailedType ? duplicateFailed : !duplicateFailed,
      requireFailedType
        ? `${pair.flow} did not expose the expected duplicate-ingredient hold`
        : `${pair.flow} was marked as a duplicate-ingredient failure`
    );
    criticalDuplicateEvidence[pair.flow] = result;
  }

  const brandEmergencyCases: unknown[] = [];
  verificationStage = "brand emergency probes";
  for (const notes of CRITICAL_EMERGENCY_TEXT_PROBES) {
    verificationStage = `brand emergency probe: ${notes}`;
    const resolveResponse = await client.callTool({
      name: "resolve_medications",
      arguments: { queries: [notes] }
    });
    const resolveResult = structured<{ emergency?: boolean }>(resolveResponse);
    assert(
      resolveResponse.isError !== true && resolveResult.emergency === true,
      `resolve path missed brand emergency: ${notes}`
    );
    const response = await client.callTool({
      name: "check_medication_safety",
      arguments: {
        medications: [checkInput(resolved[0]!)],
        context: { notes }
      }
    });
    const result = structured<{
      verdict: string;
      findings: Array<{ type: string }>;
      failedTypes: string[];
    }>(response);
    assert(response.isError !== true, `brand emergency returned a tool error: ${notes}`);
    assert(result.verdict === "WARN", `brand emergency did not return WARN: ${notes}`);
    assert(
      result.findings.some((finding) => finding.type === "EMERGENCY"),
      `brand emergency did not return EMERGENCY: ${notes}`
    );
    brandEmergencyCases.push({ notes, resolveEmergency: true, ...result });
  }
  const brandNonEmergencyCases: unknown[] = [];
  verificationStage = "brand non-emergency probes";
  for (const notes of CRITICAL_NON_EMERGENCY_TEXT_PROBES) {
    verificationStage = `brand non-emergency probe: ${notes}`;
    const resolveResponse = await client.callTool({
      name: "resolve_medications",
      arguments: { queries: [notes] }
    });
    const resolveResult = structured<{ emergency?: boolean }>(resolveResponse);
    assert(
      resolveResponse.isError !== true && resolveResult.emergency !== true,
      `resolve path returned a false emergency: ${notes}`
    );
    const response = await client.callTool({
      name: "check_medication_safety",
      arguments: {
        medications: [checkInput(resolved[0]!)],
        context: { ageGroup: "adult", pregnancy: "no", notes }
      }
    });
    const result = structured<{
      verdict: string;
      findings: Array<{ type: string }>;
      failedTypes: string[];
    }>(response);
    assert(response.isError !== true, `brand non-emergency returned a tool error: ${notes}`);
    assert(
      !result.findings.some((finding) => finding.type === "EMERGENCY"),
      `brand non-emergency returned EMERGENCY: ${notes}`
    );
    assert(
      !result.failedTypes.includes("EMERGENCY_TRIAGE"),
      `brand non-emergency returned an unexpected triage hold: ${notes}`
    );
    brandNonEmergencyCases.push({ notes, resolveEmergency: false, ...result });
  }

  const potentialOverdoseCases: unknown[] = [];
  verificationStage = "potential overdose hold probes";
  for (const notes of CRITICAL_POTENTIAL_OVERDOSE_TEXT_PROBES) {
    verificationStage = `potential overdose hold probe: ${notes}`;
    const resolveResponse = await client.callTool({
      name: "resolve_medications",
      arguments: { queries: [notes] }
    });
    const resolveResult = structured<{
      emergency?: boolean;
      triageStatus?: string;
      resolved?: Array<{
        status?: string;
        itemSeq?: string | null;
        confirmationToken?: string | null;
        candidates?: Array<{ confirmationToken?: string | null }>;
      }>;
    }>(resolveResponse);
    const expectedReferenceCount = expectedPotentialReferences.get(notes)?.length ?? 0;
    const remoteResolved = resolveResult.resolved ?? [];
    const holdResolutionPreserved =
      expectedReferenceCount === 0
        ? remoteResolved.length === 0
        : remoteResolved.length === expectedReferenceCount &&
          remoteResolved.every(
            (item) =>
              item.status === "AMBIGUOUS" &&
              !item.confirmationToken &&
              (item.candidates?.length ?? 0) > 1 &&
              item.candidates?.every((candidate) => !candidate.confirmationToken) === true
          );
    assert(
      resolveResponse.isError !== true &&
        resolveResult.emergency !== true &&
        resolveResult.triageStatus === "UNCERTAIN" &&
        holdResolutionPreserved,
      `potential overdose probe did not expose a resolve hold: ${notes}`
    );
    const response = await client.callTool({
      name: "check_medication_safety",
      arguments: {
        medications: [checkInput(resolved[0]!)],
        context: { ageGroup: "adult", pregnancy: "no", notes }
      }
    });
    const result = structured<{
      verdict: string;
      findings: Array<{ type: string }>;
      failedTypes: string[];
    }>(response);
    assert(response.isError !== true, `potential overdose probe returned a tool error: ${notes}`);
    assert(result.verdict === "UNCERTAIN", `potential overdose probe was not held: ${notes}`);
    assert(
      result.findings.some((finding) => finding.type === "CONTEXT_UNKNOWN") &&
        !result.findings.some((finding) => finding.type === "EMERGENCY") &&
        result.failedTypes.includes("EMERGENCY_TRIAGE"),
      `potential overdose probe did not expose a transparent hold: ${notes}`
    );
    potentialOverdoseCases.push({
      notes,
      resolveEmergency: false,
      resolveTriageStatus: resolveResult.triageStatus,
      resolveHoldPreserved: holdResolutionPreserved,
      ...result
    });
  }

  verificationStage = "ingredient-missing fail-closed";
  const noIngredient = structured<{
    resolved: Array<{
      status: string;
      itemSeq: string | null;
      ingrCode: string | null;
      matchedName: string | null;
      confirmationToken?: string | null;
    }>;
  }>(
    await client.callTool({
      name: "resolve_medications",
      arguments: { queries: [representativeProducts.ingredientMissing.name] }
    })
  ).resolved[0];
  assert(noIngredient?.status === "CONFIRMED", "known ingredient-missing product was not resolved");
  assert(
    noIngredient.itemSeq === representativeProducts.ingredientMissing.itemSeq,
    "ingredient-missing product resolved to the wrong itemSeq"
  );
  const noIngredientCheck = structured<{ verdict: string; failedTypes: string[] }>(
    await client.callTool({
      name: "check_medication_safety",
      arguments: {
        medications: [checkInput(noIngredient!)],
        context: { ageGroup: "adult", pregnancy: "no" }
      }
    })
  );
  assert(noIngredientCheck.verdict === "UNCERTAIN", "ingredient-missing product did not fail closed");
  assert(
    noIngredientCheck.failedTypes.includes("USJNT_TABOO"),
    "ingredient-missing product was not disclosed in failedTypes"
  );

  const performanceOperations = [
    {
      name: "resolve_medications",
      run: () =>
      client.callTool({
        name: "resolve_medications",
        arguments: { queries: ["게보린정"] }
      })
    },
    {
      name: "check_duplicate_ingredient",
      run: () =>
      client.callTool({
        name: "check_medication_safety",
        arguments: {
          medications: resolved.slice(0, 2).map(checkInput),
          context: { ageGroup: "adult", pregnancy: "no" }
        }
      })
    },
    {
      name: "check_red_case",
      run: () =>
      client.callTool({
        name: "check_medication_safety",
        arguments: {
          medications: resolved.slice(2, 4).map(checkInput),
          context: { ageGroup: "adult", pregnancy: "no" }
        }
      })
    },
    {
      name: "explain_medication",
      run: () =>
      client.callTool({
        name: "explain_medication",
        arguments: { itemSeq: "202106092" }
      })
    }
  ];
  verificationStage = "performance warm-up";
  for (const operation of performanceOperations) await timedOperation(operation.run);
  const timings: number[] = [];
  const timingsByOperation = new Map<string, number[]>(
    performanceOperations.map((operation) => [operation.name, []])
  );
  verificationStage = "performance sequential samples";
  for (let index = 0; index < performanceSamples; index += 1) {
    const operation = performanceOperations[index % performanceOperations.length]!;
    const elapsed = await timedOperation(operation.run);
    timings.push(elapsed);
    timingsByOperation.get(operation.name)!.push(elapsed);
  }
  const summary = timingSummary(timings);
  const byOperation = Object.fromEntries(
    Array.from(timingsByOperation, ([name, values]) => [name, timingSummary(values)])
  );
  for (const [name, values] of Object.entries(byOperation)) {
    if (performanceProfile === "strict") {
      assert(values.averageMs <= averageLimitMs, `${name} average ${values.averageMs.toFixed(1)}ms exceeds ${averageLimitMs}ms`);
    }
    assert(values.p99Ms <= p99LimitMs, `${name} p99 ${values.p99Ms.toFixed(1)}ms exceeds ${p99LimitMs}ms`);
  }
  verificationStage = "performance concurrent samples";
  const concurrentTimings = await Promise.all(
    Array.from({ length: concurrentSamples }, (_, index) =>
      timedOperation(performanceOperations[index % performanceOperations.length]!.run)
    )
  );
  const concurrent = timingSummary(concurrentTimings);
  verificationStage = "performance cold connections";
  const coldTimings: number[] = [];
  for (let index = 0; index < coldConnectionSamples; index += 1) {
    coldTimings.push(await timedColdConnection(endpoint));
  }
  const coldConnections = timingSummary(coldTimings);
  const average = summary.averageMs;
  const p99 = summary.p99Ms;
  if (performanceProfile === "strict") {
    assert(average <= averageLimitMs, `remote average ${average.toFixed(1)}ms exceeds ${averageLimitMs}ms`);
  }
  assert(p99 <= p99LimitMs, `remote p99 ${p99.toFixed(1)}ms exceeds ${p99LimitMs}ms`);
  assert(concurrent.p99Ms <= p99LimitMs, `concurrent p99 ${concurrent.p99Ms.toFixed(1)}ms exceeds ${p99LimitMs}ms`);
  assert(coldConnections.p99Ms <= p99LimitMs, `cold connection p99 ${coldConnections.p99Ms.toFixed(1)}ms exceeds ${p99LimitMs}ms`);

  const evidence = {
    schemaVersion: 1,
    endpoint: endpoint.toString(),
    checkedAt: new Date().toISOString(),
    buildId: BUILD_ID,
    verificationId: VERIFICATION_ID,
    dataSha256: localDataSha256,
    readiness: ready.json,
    tools: expectedTools,
    flows: {
      resolved: omitConfirmationTokens(resolved),
      duplicateIngredient: duplicate,
      redCase: red,
      explanation: {
        found: explanation.found,
        status: explanation.status,
        itemSeq: explanation.info?.itemSeq ?? null
      },
      ingredientCatalogCoverage: ingredientCatalogCheck,
      ingredientCatalogRedCase: ingredientCatalogRed,
      conservativeFormRedCase: conservativeFormRed,
      ...criticalMappingEvidence,
      ...criticalDuplicateEvidence,
      brandEmergencyCases,
      brandNonEmergencyCases,
      potentialOverdoseCases,
      ingredientMissingFailClosed: noIngredientCheck
    },
    performance: {
      profile: performanceProfile,
      averageRequirementCertified: performanceProfile === "strict",
      samples: timings.length,
      averageMs: average,
      p99Ms: p99,
      averageLimitMs,
      p99LimitMs,
      byOperation,
      concurrent,
      coldConnections
    }
  };
  writeJsonAtomic(evidencePath, evidence);

  console.log(`ok endpoint: ${endpoint.origin}${endpoint.pathname}`);
  console.log(`ok readiness: source=${ready.json.dataSource} model=${ready.json.dataModelVersion} build=${ready.json.buildId}`);
  console.log(`ok data identity: sha256=${localDataSha256}`);
  console.log(`ok tools: ${expectedTools.join(", ")}`);
  console.log("ok representative flows: duplicate ingredient, live red-case, exact explanation, ingredient catalog coverage, ingredient-only RED, conservative-form RED, critical mapping/duplicate/emergency regressions, ingredient-missing fail-closed");
  console.log(
    `${performanceProfile === "strict" ? "ok" : "observed"} performance (${performanceProfile}): n=${timings.length} avg=${average.toFixed(1)}ms p99=${p99.toFixed(1)}ms`
  );
  console.log(`ok concurrent: n=${concurrent.samples} avg=${concurrent.averageMs.toFixed(1)}ms p99=${concurrent.p99Ms.toFixed(1)}ms`);
  console.log(`ok cold connections: n=${coldConnections.samples} avg=${coldConnections.averageMs.toFixed(1)}ms p99=${coldConnections.p99Ms.toFixed(1)}ms`);
  console.log(`ok evidence: ${evidencePath}`);
} catch (error) {
  throw new Error(`Remote verification failed during ${verificationStage}`, { cause: error });
} finally {
  await client.close().catch(() => undefined);
}

function checkInput(item: {
  itemSeq: string | null;
  ingrCode: string | null;
  status: string;
  matchedName: string | null;
  confirmationToken?: string | null;
}): Record<string, unknown> {
  return {
    itemSeq: item.itemSeq,
    ingrCode: item.ingrCode,
    status: item.status,
    displayName: item.matchedName,
    confirmationToken: item.confirmationToken
  };
}

async function timedOperation(operation: () => Promise<unknown>): Promise<number> {
  const startedAt = performance.now();
  const response = (await operation()) as { isError?: boolean };
  assert(response.isError !== true, "performance probe returned a tool error");
  return performance.now() - startedAt;
}

async function timedColdConnection(url: URL): Promise<number> {
  const client = new Client({ name: "medsafe-cold-verifier", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(url);
  const startedAt = performance.now();
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert(tools.tools.length === 3, "cold connection tools/list returned unexpected tools");
    return performance.now() - startedAt;
  } finally {
    await client.close().catch(() => undefined);
  }
}

function timingSummary(values: number[]): {
  samples: number;
  averageMs: number;
  p99Ms: number;
} {
  const ordered = [...values].sort((left, right) => left - right);
  const average = ordered.reduce((sum, value) => sum + value, 0) / ordered.length;
  const p99 = ordered[Math.ceil(ordered.length * 0.99) - 1] ?? Number.POSITIVE_INFINITY;
  return {
    samples: ordered.length,
    averageMs: Number(average.toFixed(3)),
    p99Ms: Number(p99.toFixed(3))
  };
}

async function getJson(url: URL): Promise<{
  response: Response;
  json: Record<string, unknown>;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const json = (await response.json()) as Record<string, unknown>;
    return { response, json };
  } finally {
    clearTimeout(timer);
  }
}

function structured<T>(response: unknown): T {
  const value = response as { structuredContent?: unknown };
  assert(value.structuredContent && typeof value.structuredContent === "object", "tool response has no structuredContent");
  return value.structuredContent as T;
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function remotePerformanceProfile(value: string | undefined): "strict" | "cross-region-observe" {
  const normalized = value?.trim() || "strict";
  if (normalized === "strict" || normalized === "cross-region-observe") return normalized;
  throw new Error(`REMOTE_PERFORMANCE_PROFILE must be strict or cross-region-observe: ${normalized}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporaryPath, path);
}
