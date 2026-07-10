import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config/env.js";
import { createAppServices } from "../src/app.js";

test("resolve_medications classifies exact, alias, ingredient, and ambiguous inputs", async () => {
  const services = await createAppServices(loadConfig({ ...process.env, DATA_MODE: "fixture" }));
  try {
    const [gevOrin, tylenol, ingredient, missing] = services.resolver.resolveMany([
      "게보린",
      "타이레놀",
      "아세트아미노펜",
      "없는약이름"
    ]);

    assert.equal(gevOrin?.status, "CONFIRMED");
    assert.equal(gevOrin?.inputKind, "PRODUCT");
    assert.equal(gevOrin?.itemSeq, "DEMO-GEVORIN");

    assert.equal(tylenol?.status, "AMBIGUOUS");
    assert.equal(tylenol?.candidates.length, 2);

    assert.equal(ingredient?.status, "AMBIGUOUS");
    assert.equal(ingredient?.inputKind, "INGREDIENT");
    assert.equal(ingredient?.ingrCode, null);
    assert.ok(ingredient?.candidates.some((candidate) => candidate.itemSeq === "DEMO-TYLENOL-500"));
    assert.ok(ingredient?.candidates.some((candidate) => candidate.itemSeq === "DEMO-GEVORIN"));

    assert.equal(missing?.status, "NOT_FOUND");
  } finally {
    services.repository.close();
  }
});

test("food and supplement-like inputs are explicit out-of-scope results", async () => {
  const services = await createAppServices(loadConfig({ ...process.env, DATA_MODE: "fixture" }));
  try {
    const [redGinseng, grapefruit, omegaCapsule] = services.resolver.resolveMany([
      "홍삼정",
      "자몽",
      "오메가3 캡슐"
    ]);
    assert.equal(redGinseng?.status, "OUT_OF_SCOPE");
    assert.equal(redGinseng?.inputKind, "FOOD_OR_SUPPLEMENT");
    assert.equal(grapefruit?.status, "OUT_OF_SCOPE");
    assert.equal(omegaCapsule?.status, "OUT_OF_SCOPE");
  } finally {
    services.repository.close();
  }
});

test("an exact MFDS medicine name is not rejected because it contains a supplement term", async () => {
  const services = await createAppServices(loadConfig({ ...process.env, DATA_MODE: "fixture" }));
  try {
    const result = services.resolver.resolveOne(
      "로수맥콤비젤연질캡슐10/1000밀리그램(로수바스타틴,오메가3산에틸에스테르90)"
    );
    assert.equal(result.status, "CONFIRMED");
    assert.equal(result.itemSeq, "DEMO-OMEGA-RX");
  } finally {
    services.repository.close();
  }
});

test("hangul fuzzy matching returns ambiguous rather than choosing low-confidence typo", async () => {
  const services = await createAppServices(loadConfig({ ...process.env, DATA_MODE: "fixture" }));
  try {
    const [result] = services.resolver.resolveMany(["타이래놀"]);
    assert.equal(result?.status, "AMBIGUOUS");
    assert.ok(result?.candidates.some((candidate) => candidate.itemSeq === "DEMO-TYLENOL-500"));
  } finally {
    services.repository.close();
  }
});

test("resolver preserves dosage and never confirms a different strength", async () => {
  const services = await createAppServices(loadConfig({ ...process.env, DATA_MODE: "fixture" }));
  try {
    const [tylenol650, tylenol500, brufen400, aspirin500] = services.resolver.resolveMany([
      "타이레놀 650mg",
      "타이레놀정 500밀리그램",
      "부루펜 400mg",
      "아스피린 500mg"
    ]);

    assert.equal(tylenol650?.status, "CONFIRMED");
    assert.equal(tylenol650?.itemSeq, "DEMO-TYLENOL-ER650");
    assert.equal(tylenol500?.status, "CONFIRMED");
    assert.equal(tylenol500?.itemSeq, "DEMO-TYLENOL-500");
    assert.notEqual(brufen400?.itemSeq, "DEMO-BRUFEN");
    assert.notEqual(aspirin500?.itemSeq, "DEMO-ASPIRIN");
  } finally {
    services.repository.close();
  }
});

test("resolver bounds fuzzy work for repeated unknown inputs", async () => {
  const services = await createAppServices(loadConfig({ ...process.env, DATA_MODE: "fixture" }));
  try {
    const startedAt = performance.now();
    const results = services.resolver.resolveMany([
      "숨이안쉬어져요",
      "정신을잃었어요",
      "경련을해요",
      "입술이파래졌어요",
      "전혀없는약가나다",
      "전혀없는약라마바",
      "전혀없는약사아자",
      "전혀없는약차카타"
    ]);
    assert.ok(results.every((result) => result.status === "NOT_FOUND"));
    assert.ok(performance.now() - startedAt < 500);
  } finally {
    services.repository.close();
  }
});

test("resolver searches every ingredient in a compound product", async () => {
  const services = await createAppServices(loadConfig({ ...process.env, DATA_MODE: "fixture" }));
  try {
    const [result] = services.resolver.resolveMany(["카페인무수물"]);
    assert.equal(result?.status, "AMBIGUOUS");
    assert.equal(result?.inputKind, "INGREDIENT");
    assert.equal(result?.matchedName, "카페인무수물");
    assert.equal(
      result?.candidates.find((candidate) => candidate.itemSeq === "DEMO-GEVORIN")?.ingrCode,
      "INGR-CAFFEINE"
    );
    assert.ok(result?.candidates.some((candidate) => candidate.itemSeq === "DEMO-GEVORIN"));
  } finally {
    services.repository.close();
  }
});
