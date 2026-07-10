import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import initSqlJs from "sql.js";
import { loadConfig } from "../src/config/env.js";
import { createAppServices } from "../src/app.js";
import { MasterRepository } from "../src/repositories/masterRepository.js";

test("master DB preserves compound ingredients and local public-data snapshots", async () => {
  const services = await createAppServices(loadConfig({ ...process.env, DATA_MODE: "fixture" }));
  try {
    const ingredients = services.repository.getProductIngredients("DEMO-GEVORIN");
    assert.deepEqual(
      ingredients.map((ingredient) => ingredient.ingredientName).sort(),
      ["아세트아미노펜", "이소프로필안티피린", "카페인무수물"].sort()
    );
    assert.deepEqual(
      ingredients.find((ingredient) => ingredient.ingredientName === "아세트아미노펜")
        ?.durIngredientKeys,
      ["아세트아미노펜"]
    );
    assert.deepEqual(
      ingredients.find((ingredient) => ingredient.ingredientName === "카페인무수물")
        ?.durIngredientKeys.slice().sort(),
      ["카페인무수물", "카페인"].sort()
    );

    const easyDrug = services.repository.getEasyDrugInfo("DEMO-TYLENOL-500");
    assert.equal(easyDrug?.itemName, "타이레놀정500밀리그람");

    const dur = services.repository.getDurSnapshot("DEMO-WARFARIN");
    assert.equal(dur?.complete, true);
    assert.equal(dur?.contraindications[0]?.targetItemSeq, "DEMO-ASPIRIN");
    assert.equal(dur?.contraindications[0]?.targetIngredientKey, "아스피린");
    assert.equal(
      services.repository.getDurIngredientContraindications(["와파린"])[0]
        ?.targetIngredientKey,
      "아스피린"
    );
  } finally {
    services.repository.close();
  }
});

test("live app reads DUR from the local snapshot without an MFDS runtime key", async () => {
  const services = await createAppServices(
    loadConfig({
      ...process.env,
      DATA_MODE: "live",
      MFDS_SERVICE_KEY: "",
      LIVE_SELF_TEST_ITEM_SEQ: "DEMO-WARFARIN",
      LIVE_SELF_TEST_EXPECT_CONTRAINDICATION: "true"
    })
  );
  try {
    const selfTest = await services.durClient.selfTest();
    assert.equal(selfTest.ok, true);
    const result = await services.durClient.checkUsjntTaboo("DEMO-WARFARIN");
    assert.equal(result.ok, true);
    assert.equal(result.contraindications[0]?.targetItemSeq, "DEMO-ASPIRIN");
  } finally {
    services.repository.close();
  }
});

test("repository recomputes DUR ingredient coverage from actual catalog identities", async () => {
  const repository = await MasterRepository.open("data/master.test.sqlite");
  try {
    const coverage = repository.getDurIngredientCoverage();
    assert.equal(coverage.totalProducts, 16);
    assert.equal(coverage.catalogIdentityCount, 2);
    assert.equal(coverage.coveredProducts, 14);
    assert.equal(coverage.mappedCatalogIdentityCount, 2);
    assert.equal(coverage.unmappedCatalogIdentityCount, 0);
    assert.equal(coverage.ratio, 14 / 16);
    assert.equal(coverage.catalogMappingRatio, 1);
  } finally {
    repository.close();
  }
});

test("repository reports table counts independently from metadata", async () => {
  const repository = await MasterRepository.open("data/master.test.sqlite");
  try {
    const counts = repository.getStoredCounts();
    assert.equal(counts.productCount, 16);
    assert.equal(counts.ingredientCount, 18);
    assert.equal(counts.productIngredientDurKeyCount, 19);
    assert.equal(counts.durIngredientFindingCount, 1);
    for (const [key, actual] of Object.entries(counts)) {
      assert.equal(Number(repository.metadata(key)), actual, key);
    }
  } finally {
    repository.close();
  }
});

test("repository rejects a database with foreign-key violations", async () => {
  const directory = mkdtempSync(join(tmpdir(), "medsafe-fk-"));
  const output = join(directory, "broken.sqlite");
  try {
    const SQL = await initSqlJs();
    const database = new SQL.Database(readFileSync("data/master.test.sqlite"));
    database.run("PRAGMA foreign_keys = OFF");
    database.run(`
      INSERT INTO product_ingredient_dur_keys
        (item_seq, ingredient_key, dur_ingredient_key, dur_ingredient_codes, mapping_basis)
      VALUES ('MISSING', 'missing', 'missing', '', 'FALLBACK')
    `);
    writeFileSync(output, Buffer.from(database.export()));
    database.close();
    await assert.rejects(
      MasterRepository.open(output),
      /foreign-key integrity check failed/
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
