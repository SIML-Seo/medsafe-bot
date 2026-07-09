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
    assert.equal(ingredient?.ingrCode, "INGR-APAP");
    assert.ok(ingredient?.candidates.some((candidate) => candidate.itemSeq === "DEMO-TYLENOL-500"));

    assert.equal(missing?.status, "NOT_FOUND");
  } finally {
    services.repository.close();
  }
});

test("food and supplement-like inputs are explicit out-of-scope results", async () => {
  const services = await createAppServices(loadConfig({ ...process.env, DATA_MODE: "fixture" }));
  try {
    const [redGinseng, grapefruit] = services.resolver.resolveMany(["홍삼", "자몽"]);
    assert.equal(redGinseng?.status, "OUT_OF_SCOPE");
    assert.equal(redGinseng?.inputKind, "FOOD_OR_SUPPLEMENT");
    assert.equal(grapefruit?.status, "OUT_OF_SCOPE");
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
