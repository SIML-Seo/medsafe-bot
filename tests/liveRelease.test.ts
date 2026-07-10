import test from "node:test";
import assert from "node:assert/strict";
import { createAppServices } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import {
  CRITICAL_RELEASE_SAFETY_PROBE_COUNT,
  criticalReleaseSafetyFailures
} from "../src/utils/releaseProbes.js";

const liveConfig = loadConfig({
  ...process.env,
  NODE_ENV: "development",
  DATA_MODE: "live",
  MASTER_DB_PATH: "data/master.sqlite",
  CONFIRMATION_SECRET: "test-release-confirmation-secret-at-least-32-characters",
  LIVE_SELF_TEST_ITEM_SEQ: "200108429",
  LIVE_SELF_TEST_TARGET_ITEM_SEQ: "197900145",
  LIVE_SELF_TEST_EXPECT_CONTRAINDICATION: "true"
});

test("release DB detects the previously false-green salt and compound pairs", async () => {
  const services = await createAppServices(liveConfig);
  try {
    for (const [sourceItemSeq, targetItemSeq] of [
      ["202302166", "201900814"],
      ["201707240", "198000054"],
      ["201707240", "201206793"],
      ["199500043", "199100038"],
      ["199101243", "199700049"],
      ["202302166", "201401455"],
      ["199806459", "201309347"]
    ] as const) {
      const result = await services.safety.check([
        { itemSeq: sourceItemSeq, status: "CONFIRMED" },
        { itemSeq: targetItemSeq, status: "CONFIRMED" }
      ]);
      assert.equal(result.verdict, "WARN", `${sourceItemSeq}+${targetItemSeq}`);
      assert.ok(
        result.findings.some(
          (finding) =>
            finding.type === "USJNT_TABOO" &&
            finding.level === "RED"
        ),
        `${sourceItemSeq}+${targetItemSeq}`
      );
      assert.equal(result.failedTypes.includes("USJNT_TABOO"), false);
    }
  } finally {
    services.repository.close();
  }
});

test("release DB retains DUR mapping provenance and D-code aliases", async () => {
  const services = await createAppServices(liveConfig);
  try {
    const salmeterol = services.repository
      .getProductIngredients("201900814")
      .find((ingredient) => ingredient.durIngredientKeys.includes("살메테롤"));
    assert.ok(
      salmeterol?.durIngredientMappings?.some(
        (mapping) =>
          mapping.key === "살메테롤" &&
          mapping.codes.includes("D001781") &&
          mapping.basis === "CONSERVATIVE_FORM"
      )
    );

    const ethambutol = services.repository
      .getProductIngredients("201206793")
      .find((ingredient) => ingredient.ingredientName.includes("에탐부톨"));
    assert.ok(
      ethambutol?.durIngredientMappings?.some(
        (mapping) => mapping.key === "에탐뷰톨" && mapping.codes.includes("D001151")
      )
    );

    for (const [itemSeq, alias, catalogKey] of [
      ["199100038", "니메수리드", "니메술리드"],
      ["199700049", "이소니아짓", "이소니아지드"],
      ["201401455", "클리피도그렐", "클로피도그렐"],
      ["200103360", "아미노카프로산", "아미노카프론산"],
      ["200500369", "에데트산칼슘디나트륨", "에데트산칼슘나트륨"],
      ["200501505", "트라넥사민산", "트라넥삼산"],
      ["199806459", "자일로메타졸린", "키실로메타졸린"]
    ] as const) {
      const ingredient = services.repository
        .getProductIngredients(itemSeq)
        .find((item) => item.ingredientName.includes(alias));
      assert.ok(
        ingredient?.durIngredientMappings?.some(
          (mapping) =>
            mapping.key === catalogKey && mapping.basis === "CURATED_SPELLING"
        ),
        `${alias} -> ${catalogKey}`
      );
    }
  } finally {
    services.repository.close();
  }
});

test("release DB detects sodium caffeine benzoate and caffeine as duplicate ingredients", async () => {
  const services = await createAppServices(liveConfig);
  try {
    const result = await services.safety.check(
      [
        { itemSeq: "195700015", status: "CONFIRMED" },
        { itemSeq: "196500051", status: "CONFIRMED" }
      ],
      { ageGroup: "adult", pregnancy: "no" }
    );
    assert.ok(result.findings.some((finding) => finding.type === "DUP_INGREDIENT"));
    assert.equal(result.failedTypes.includes("DUP_INGREDIENT"), false);
    assert.notEqual(result.verdict, "NO_KNOWN_FINDINGS");
  } finally {
    services.repository.close();
  }
});

test("release DB detects lysine acetate and lysine as duplicate ingredients", async () => {
  const services = await createAppServices(liveConfig);
  try {
    const result = await services.safety.check(
      [
        { itemSeq: "200811793", status: "CONFIRMED" },
        { itemSeq: "197400262", status: "CONFIRMED" }
      ],
      { ageGroup: "adult", pregnancy: "no" }
    );
    assert.ok(
      result.findings.some(
        (finding) =>
          finding.type === "DUP_INGREDIENT" && finding.reason.includes("리신")
      )
    );
    assert.equal(result.failedTypes.includes("DUP_INGREDIENT"), true);
    assert.notEqual(result.verdict, "NO_KNOWN_FINDINGS");
  } finally {
    services.repository.close();
  }
});

test("release DB passes fixed false-green safety probes independently of metadata", async () => {
  const services = await createAppServices(liveConfig);
  try {
    const failures = await criticalReleaseSafetyFailures(
      services.repository,
      services.safety,
      services.resolver
    );
    assert.deepEqual(failures, []);
    assert.equal(CRITICAL_RELEASE_SAFETY_PROBE_COUNT, 216);
  } finally {
    services.repository.close();
  }
});

test("release DB fails risky fallback ingredient mappings closed", async () => {
  const services = await createAppServices(liveConfig);
  try {
    const product = services.repository.getProduct("196000011");
    assert.equal(product?.ingredientsComplete, false);
    assert.ok(
      services.repository
        .getProductIngredients("196000011")
        .some((ingredient) =>
          ingredient.durIngredientMappings?.some((mapping) => mapping.basis === "FALLBACK")
        )
    );
    const result = await services.safety.check([
      { itemSeq: "196000011", status: "CONFIRMED" }
    ]);
    assert.equal(result.verdict, "UNCERTAIN");
    assert.ok(result.failedTypes.includes("USJNT_TABOO"));
  } finally {
    services.repository.close();
  }
});
