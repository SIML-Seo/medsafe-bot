import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("master DB builder rejects duplicate products without publishing partial output", () => {
  const directory = mkdtempSync(join(tmpdir(), "medsafe-master-"));
  try {
    const seedPath = join(directory, "seed.json");
    const aliasPath = join(directory, "aliases.json");
    const outputPath = join(directory, "master.sqlite");
    const previousOutput = Buffer.from("existing release database");
    writeFileSync(outputPath, previousOutput);
    const product = {
      itemSeq: "123456789",
      productCode: "123456789",
      name: "중복검증정",
      manufacturer: "검증제약",
      ingredientCode: "",
      ingredientName: "",
      atcCode: "",
      atcName: "",
      source: "TEST"
    };
    writeFileSync(
      seedPath,
      JSON.stringify({
        metadata: { source: "TEST", generationId: "duplicate-test" },
        products: [product, product]
      })
    );
    writeFileSync(
      aliasPath,
      JSON.stringify({ metadata: { generationId: "duplicate-test" }, aliases: [] })
    );

    const result = spawnSync(
      process.execPath,
      [
        "dist/scripts/build-master-db.js",
        "--input",
        seedPath,
        "--aliases",
        aliasPath,
        "--output",
        outputPath
      ],
      { cwd: process.cwd(), encoding: "utf8" }
    );
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /UNIQUE constraint failed/);
    assert.deepEqual(readFileSync(outputPath), previousOutput);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
