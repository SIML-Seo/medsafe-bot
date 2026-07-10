import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, extname, resolve } from "node:path";
import initSqlJs from "sql.js";
import type {
  AliasEntry,
  DurIngredientContraindication,
  DurSnapshotInput,
  EasyDrugInfo,
  MasterProductInput,
  ProductIngredientInput
} from "../src/types.js";
import {
  canonicalIngredientIdentity,
  normalizeIngredientName,
  normalizeMedicationText
} from "../src/utils/text.js";

interface Args {
  input: string;
  aliases: string;
  output: string;
}

interface SeedFile {
  metadata?: Record<string, string>;
  products: MasterProductInput[];
  easyDrugInfo?: EasyDrugInfo[];
  durSnapshots?: DurSnapshotInput[];
  durIngredientContraindications?: DurIngredientContraindication[];
}

interface AliasFile {
  metadata?: Record<string, string>;
  aliases: AliasEntry[];
}

function parseArgs(argv: string[]): Args {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || !value) continue;
    args.set(key.slice(2), value);
  }

  return {
    input: args.get("input") ?? "data/master.seed.json",
    aliases: args.get("aliases") ?? "data/aliases.json",
    output: args.get("output") ?? "data/master.sqlite"
  };
}

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && inQuotes && next === '"') {
      field += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(field);
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const headers = rows.shift()?.map((header) => header.trim()) ?? [];
  return rows.map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? ""]))
  );
}

function firstValue(row: Record<string, string>, keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (value && value.trim()) return value.trim();
  }
  return "";
}

function loadProducts(inputPath: string): SeedFile {
  const text = readFileSync(inputPath, "utf8");
  const ext = extname(inputPath).toLowerCase();
  const joinMode = process.env.MASTER_JOIN_MODE ?? "explicitItemSeq";

  if (ext === ".json") {
    const parsed = JSON.parse(text) as SeedFile;
    return {
      metadata: parsed.metadata ?? {},
      products: parsed.products,
      easyDrugInfo: parsed.easyDrugInfo ?? [],
      durSnapshots: parsed.durSnapshots ?? [],
      durIngredientContraindications: parsed.durIngredientContraindications ?? []
    };
  }

  const rows = parseCsv(text);
  const products = rows.map((row) => {
    const productCode = firstValue(row, ["제품코드", "productCode", "PRODUCT_CODE"]);
    const itemSeq =
      firstValue(row, ["품목기준코드", "itemSeq", "ITEM_SEQ"]) ||
      (joinMode === "productCodeEqualsItemSeq" ? productCode : "");

    return {
      itemSeq,
      productCode,
      name: firstValue(row, ["제품명", "품목명", "itemName", "ITEM_NAME"]),
      manufacturer: firstValue(row, ["업체명", "제조사", "entpName", "ENTP_NAME"]),
      ingredientCode: firstValue(row, ["주성분코드", "ingrCode", "INGR_CODE"]),
      ingredientName: firstValue(row, ["주성분명", "성분명", "ingrName", "INGR_NAME"]),
      atcCode: firstValue(row, ["ATC코드", "atcCode", "ATC_CODE"]),
      atcName: firstValue(row, ["ATC코드명칭", "ATC명칭", "atcName", "ATC_NAME"]),
      source: "CSV_IMPORT"
    };
  });

  return {
    metadata: {
      source: inputPath,
      joinMode
    },
    products,
    easyDrugInfo: [],
    durSnapshots: [],
    durIngredientContraindications: []
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = resolve(args.input);
  const aliasPath = resolve(args.aliases);
  const outputPath = resolve(args.output);
  const {
    metadata = {},
    products,
    easyDrugInfo = [],
    durSnapshots = [],
    durIngredientContraindications = []
  } = loadProducts(inputPath);
  const aliasInput = JSON.parse(readFileSync(aliasPath, "utf8")) as AliasEntry[] | AliasFile;
  const aliases = Array.isArray(aliasInput) ? aliasInput : aliasInput.aliases;
  const aliasMetadata = Array.isArray(aliasInput) ? {} : aliasInput.metadata ?? {};
  const generationId = metadata.generationId;
  if (generationId && aliasMetadata.generationId !== generationId) {
    throw new Error(
      `seed/alias generation mismatch: ${generationId} != ${aliasMetadata.generationId ?? "missing"}`
    );
  }

  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run("PRAGMA foreign_keys = ON");

  db.run(`
    CREATE TABLE master_products (
      item_seq TEXT PRIMARY KEY,
      product_code TEXT NOT NULL,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      manufacturer TEXT NOT NULL,
      ingredient_code TEXT NOT NULL,
      ingredient_name TEXT NOT NULL,
      atc_code TEXT NOT NULL,
      atc_name TEXT NOT NULL,
      source TEXT NOT NULL,
      ingredients_complete INTEGER NOT NULL
    );
    CREATE INDEX idx_master_products_normalized_name ON master_products(normalized_name);
    CREATE INDEX idx_master_products_ingredient_code ON master_products(ingredient_code);
    CREATE INDEX idx_master_products_atc_code ON master_products(atc_code);

    CREATE TABLE product_ingredients (
      item_seq TEXT NOT NULL,
      ingredient_key TEXT NOT NULL,
      ingredient_name TEXT NOT NULL,
      ingredient_code TEXT NOT NULL,
      PRIMARY KEY (item_seq, ingredient_key),
      FOREIGN KEY (item_seq) REFERENCES master_products(item_seq)
    );
    CREATE INDEX idx_product_ingredients_key ON product_ingredients(ingredient_key);
    CREATE INDEX idx_product_ingredients_code ON product_ingredients(ingredient_code);

    CREATE TABLE product_ingredient_dur_keys (
      item_seq TEXT NOT NULL,
      ingredient_key TEXT NOT NULL,
      dur_ingredient_key TEXT NOT NULL,
      dur_ingredient_codes TEXT NOT NULL,
      mapping_basis TEXT NOT NULL,
      PRIMARY KEY (item_seq, ingredient_key, dur_ingredient_key),
      FOREIGN KEY (item_seq, ingredient_key)
        REFERENCES product_ingredients(item_seq, ingredient_key)
    );
    CREATE INDEX idx_product_ingredient_dur_keys_key
      ON product_ingredient_dur_keys(dur_ingredient_key);

    CREATE TABLE easy_drug_info (
      item_seq TEXT PRIMARY KEY,
      item_name TEXT NOT NULL,
      entp_name TEXT NOT NULL,
      efcy_qesitm TEXT NOT NULL,
      use_method_qesitm TEXT NOT NULL,
      atpn_warn_qesitm TEXT NOT NULL,
      atpn_qesitm TEXT NOT NULL,
      intrc_qesitm TEXT NOT NULL,
      se_qesitm TEXT NOT NULL,
      deposit_method_qesitm TEXT NOT NULL,
      FOREIGN KEY (item_seq) REFERENCES master_products(item_seq)
    );

    CREATE TABLE dur_snapshot_status (
      item_seq TEXT PRIMARY KEY,
      complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
      fetched_at TEXT NOT NULL,
      source TEXT NOT NULL,
      FOREIGN KEY (item_seq) REFERENCES master_products(item_seq)
    );

    CREATE TABLE dur_contraindications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_item_seq TEXT NOT NULL,
      target_item_seq TEXT,
      target_ingredient_code TEXT,
      target_ingredient_name TEXT,
      target_ingredient_key TEXT,
      reason TEXT NOT NULL,
      base_date TEXT NOT NULL,
      date_basis TEXT NOT NULL,
      source TEXT NOT NULL,
      FOREIGN KEY (source_item_seq) REFERENCES master_products(item_seq)
    );
    CREATE INDEX idx_dur_contraindications_source ON dur_contraindications(source_item_seq);

    CREATE TABLE dur_ingredient_contraindications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_ingredient_code TEXT,
      source_ingredient_name TEXT NOT NULL,
      source_ingredient_key TEXT NOT NULL,
      target_ingredient_code TEXT,
      target_ingredient_name TEXT NOT NULL,
      target_ingredient_key TEXT NOT NULL,
      source_mix_type TEXT NOT NULL,
      source_mixture TEXT NOT NULL,
      source_relation TEXT NOT NULL,
      target_mix_type TEXT NOT NULL,
      target_mixture TEXT NOT NULL,
      target_relation TEXT NOT NULL,
      reason TEXT NOT NULL,
      base_date TEXT NOT NULL,
      date_basis TEXT NOT NULL,
      source TEXT NOT NULL
    );
    CREATE INDEX idx_dur_ingredient_source_key
      ON dur_ingredient_contraindications(source_ingredient_key);
    CREATE INDEX idx_dur_ingredient_target_key
      ON dur_ingredient_contraindications(target_ingredient_key);

    CREATE TABLE aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alias TEXT NOT NULL,
      normalized_alias TEXT NOT NULL,
      kind TEXT NOT NULL,
      target_item_seq TEXT,
      target_ingredient_code TEXT,
      target_ingredient_key TEXT,
      label TEXT,
      FOREIGN KEY (target_item_seq) REFERENCES master_products(item_seq)
    );
    CREATE INDEX idx_aliases_normalized_alias ON aliases(normalized_alias);

    CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const insertProduct = db.prepare(`
    INSERT INTO master_products
      (item_seq, product_code, name, normalized_name, manufacturer, ingredient_code, ingredient_name, atc_code, atc_name, source, ingredients_complete)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertIngredient = db.prepare(`
    INSERT INTO product_ingredients
      (item_seq, ingredient_key, ingredient_name, ingredient_code)
    VALUES (?, ?, ?, ?)
  `);
  const insertIngredientDurKey = db.prepare(`
    INSERT INTO product_ingredient_dur_keys
      (item_seq, ingredient_key, dur_ingredient_key, dur_ingredient_codes, mapping_basis)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (const product of products) {
    const itemSeq = product.itemSeq?.trim();
    const name = product.name?.trim();
    if (!itemSeq || !name) continue;
    const ingredients = productIngredients(product);
    const ingredientsComplete =
      product.ingredientsComplete ?? ingredients.length > 0;
    insertProduct.run([
      itemSeq,
      product.productCode?.trim() || itemSeq,
      name,
      normalizeMedicationText(name),
      product.manufacturer?.trim() ?? "",
      product.ingredientCode?.trim() ?? "",
      product.ingredientName?.trim() ?? "",
      product.atcCode?.trim() ?? "",
      product.atcName?.trim() ?? "",
      product.source?.trim() ?? "UNKNOWN",
      ingredientsComplete ? 1 : 0
    ]);

    for (const ingredient of ingredients) {
      const ingredientName = ingredient.ingredientName.trim();
      const ingredientKey =
        ingredient.ingredientKey?.trim() || normalizeIngredientName(ingredientName);
      const fallbackKeys = Array.from(
        new Set(
          (ingredient.durIngredientKeys?.length
            ? ingredient.durIngredientKeys
            : [canonicalIngredientIdentity(ingredientName)]
          )
            .map((key) => key.trim())
            .filter(Boolean)
        )
      );
      const mappings = ingredient.durIngredientMappings?.length
        ? ingredient.durIngredientMappings
        : fallbackKeys.map((key) => ({ key, codes: [], basis: "FIXTURE" as const }));
      const mappingsByKey = new Map(
        mappings
          .map((mapping) => ({
            key: mapping.key.trim(),
            codes: Array.from(
              new Set(mapping.codes.map((code) => code.trim().toUpperCase()).filter(Boolean))
            ).sort(),
            basis: mapping.basis
          }))
          .filter((mapping) => mapping.key)
          .map((mapping) => [mapping.key, mapping] as const)
      );
      if (!ingredientName || !ingredientKey || mappingsByKey.size === 0) continue;
      insertIngredient.run([
        itemSeq,
        ingredientKey,
        ingredientName,
        ingredient.ingredientCode?.trim() ?? ""
      ]);
      for (const mapping of mappingsByKey.values()) {
        insertIngredientDurKey.run([
          itemSeq,
          ingredientKey,
          mapping.key,
          mapping.codes.join("\u001d"),
          mapping.basis
        ]);
      }
    }
  }
  insertProduct.free();
  insertIngredient.free();
  insertIngredientDurKey.free();

  const insertAlias = db.prepare(`
    INSERT INTO aliases
      (alias, normalized_alias, kind, target_item_seq, target_ingredient_code, target_ingredient_key, label)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let insertedAliases = 0;
  for (const alias of aliases) {
    insertAlias.run([
      alias.alias,
      normalizeMedicationText(alias.alias),
      alias.kind,
      alias.targetItemSeq ?? null,
      alias.targetIngredientCode ?? null,
      alias.targetIngredientKey ?? null,
      alias.label ?? null
    ]);
    insertedAliases += 1;
  }
  insertAlias.free();

  const insertEasyDrug = db.prepare(`
    INSERT INTO easy_drug_info
      (item_seq, item_name, entp_name, efcy_qesitm, use_method_qesitm, atpn_warn_qesitm,
       atpn_qesitm, intrc_qesitm, se_qesitm, deposit_method_qesitm)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const info of easyDrugInfo) {
    if (!info.itemSeq.trim() || !info.itemName.trim()) continue;
    insertEasyDrug.run([
      info.itemSeq,
      info.itemName,
      info.entpName,
      info.efcyQesitm ?? "",
      info.useMethodQesitm ?? "",
      info.atpnWarnQesitm ?? "",
      info.atpnQesitm ?? "",
      info.intrcQesitm ?? "",
      info.seQesitm ?? "",
      info.depositMethodQesitm ?? ""
    ]);
  }
  insertEasyDrug.free();

  const insertDurStatus = db.prepare(`
    INSERT INTO dur_snapshot_status (item_seq, complete, fetched_at, source)
    VALUES (?, ?, ?, ?)
  `);
  const insertDurFinding = db.prepare(`
    INSERT INTO dur_contraindications
      (source_item_seq, target_item_seq, target_ingredient_code, target_ingredient_name,
       target_ingredient_key, reason, base_date, date_basis, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const snapshot of durSnapshots) {
    const itemSeq = snapshot.itemSeq.trim();
    if (!itemSeq) continue;
    insertDurStatus.run([itemSeq, snapshot.complete ? 1 : 0, snapshot.fetchedAt, snapshot.source]);
    for (const finding of snapshot.contraindications) {
      insertDurFinding.run([
        itemSeq,
        finding.targetItemSeq ?? null,
        finding.targetIngredientCode ?? null,
        finding.targetIngredientName ?? null,
        finding.targetIngredientKey ??
          (finding.targetIngredientName
            ? normalizeIngredientName(finding.targetIngredientName)
            : null),
        finding.reason,
        finding.baseDate,
        finding.dateBasis ?? inferDateBasis(finding.source),
        finding.source
      ]);
    }
  }
  insertDurStatus.free();
  insertDurFinding.free();

  const insertDurIngredientFinding = db.prepare(`
    INSERT INTO dur_ingredient_contraindications
      (source_ingredient_code, source_ingredient_name, source_ingredient_key,
       target_ingredient_code, target_ingredient_name, target_ingredient_key,
       source_mix_type, source_mixture, source_relation,
       target_mix_type, target_mixture, target_relation,
       reason, base_date, date_basis, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const finding of durIngredientContraindications) {
    const sourceName = finding.sourceIngredientName.trim();
    const targetName = finding.targetIngredientName.trim();
    const sourceKey =
      finding.sourceIngredientKey?.trim() || canonicalIngredientIdentity(sourceName);
    const targetKey =
      finding.targetIngredientKey?.trim() || canonicalIngredientIdentity(targetName);
    if (!sourceName || !targetName || !sourceKey || !targetKey || !finding.reason.trim()) continue;
    insertDurIngredientFinding.run([
      finding.sourceIngredientCode?.trim() || null,
      sourceName,
      sourceKey,
      finding.targetIngredientCode?.trim() || null,
      targetName,
      targetKey,
      finding.sourceMixType?.trim() ?? "",
      finding.sourceMixture?.trim() ?? "",
      finding.sourceRelation?.trim() ?? "",
      finding.targetMixType?.trim() ?? "",
      finding.targetMixture?.trim() ?? "",
      finding.targetRelation?.trim() ?? "",
      finding.reason,
      finding.baseDate,
      finding.dateBasis ?? inferDateBasis(finding.source),
      finding.source
    ]);
  }
  insertDurIngredientFinding.free();

  const insertMetadata = db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(metadata)) {
    insertMetadata.run([key, String(value)]);
  }
  const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
  const generatedAt = sourceDateEpoch
    ? new Date(Number(sourceDateEpoch) * 1000).toISOString()
    : new Date().toISOString();
  insertMetadata.run(["generatedAt", generatedAt]);
  const actualProductCount = databaseCount(db, "master_products");
  const actualIngredientCount = databaseCount(db, "product_ingredients");
  const actualIngredientDurKeyCount = databaseCount(db, "product_ingredient_dur_keys");
  const actualEasyDrugCount = databaseCount(db, "easy_drug_info");
  const actualDurSnapshotCount = databaseCount(db, "dur_snapshot_status");
  const actualDurFindingCount = databaseCount(db, "dur_contraindications");
  const actualDurIngredientFindingCount = databaseCount(db, "dur_ingredient_contraindications");
  insertMetadata.run(["productCount", String(actualProductCount)]);
  insertMetadata.run(["aliasCount", String(insertedAliases)]);
  insertMetadata.run(["ingredientCount", String(actualIngredientCount)]);
  insertMetadata.run(["productIngredientDurKeyCount", String(actualIngredientDurKeyCount)]);
  insertMetadata.run(["easyDrugInfoCount", String(actualEasyDrugCount)]);
  insertMetadata.run(["durSnapshotCount", String(actualDurSnapshotCount)]);
  insertMetadata.run(["durFindingCount", String(actualDurFindingCount)]);
  insertMetadata.run(["durIngredientFindingCount", String(actualDurIngredientFindingCount)]);
  insertMetadata.free();

  mkdirSync(dirname(outputPath), { recursive: true });
  const output = Buffer.from(db.export());
  db.close();
  writeAtomic(outputPath, output);

  console.log(`master DB written: ${outputPath}`);
  console.log(
    `products=${actualProductCount} aliases=${insertedAliases} ingredients=${actualIngredientCount} ingredientDurKeys=${actualIngredientDurKeyCount} easyDrug=${actualEasyDrugCount} durSnapshots=${actualDurSnapshotCount} durFindings=${actualDurFindingCount} durIngredientFindings=${actualDurIngredientFindingCount}`
  );
}

function writeAtomic(path: string, content: Buffer): void {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, "wx");
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporaryPath, path);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The file may already have been renamed.
    }
    throw error;
  }
}

function databaseCount(db: import("sql.js").Database, table: string): number {
  const result = db.exec(`SELECT COUNT(*) FROM ${table}`);
  return Number(result[0]?.values[0]?.[0] ?? 0);
}

function inferDateBasis(source: string): "SOURCE_DATE" | "SNAPSHOT_FETCHED_AT" | "FIXTURE_DATE" {
  if (source.includes("DEMO_FIXTURE")) return "FIXTURE_DATE";
  return "SOURCE_DATE";
}

function productIngredients(product: MasterProductInput): ProductIngredientInput[] {
  if (product.ingredients && product.ingredients.length > 0) return product.ingredients;
  if (!product.ingredientName?.trim()) return [];
  return [
    {
      ingredientName: product.ingredientName,
      ingredientCode: product.ingredientCode
    }
  ];
}

await main();
