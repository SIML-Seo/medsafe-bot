import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import initSqlJs from "sql.js";
import type { AliasEntry, MasterProductInput } from "../src/types.js";
import { normalizeMedicationText } from "../src/utils/text.js";

interface Args {
  input: string;
  aliases: string;
  output: string;
}

interface SeedFile {
  metadata?: Record<string, string>;
  products: MasterProductInput[];
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

function loadProducts(inputPath: string): { metadata: Record<string, string>; products: MasterProductInput[] } {
  const text = readFileSync(inputPath, "utf8");
  const ext = extname(inputPath).toLowerCase();
  const joinMode = process.env.MASTER_JOIN_MODE ?? "explicitItemSeq";

  if (ext === ".json") {
    const parsed = JSON.parse(text) as SeedFile;
    return { metadata: parsed.metadata ?? {}, products: parsed.products };
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
    products
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = resolve(args.input);
  const aliasPath = resolve(args.aliases);
  const outputPath = resolve(args.output);
  const { metadata, products } = loadProducts(inputPath);
  const aliases = JSON.parse(readFileSync(aliasPath, "utf8")) as AliasEntry[];

  const SQL = await initSqlJs();
  const db = new SQL.Database();

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
      source TEXT NOT NULL
    );
    CREATE INDEX idx_master_products_normalized_name ON master_products(normalized_name);
    CREATE INDEX idx_master_products_ingredient_code ON master_products(ingredient_code);
    CREATE INDEX idx_master_products_atc_code ON master_products(atc_code);

    CREATE TABLE aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alias TEXT NOT NULL,
      normalized_alias TEXT NOT NULL,
      kind TEXT NOT NULL,
      target_item_seq TEXT,
      target_ingredient_code TEXT,
      label TEXT
    );
    CREATE INDEX idx_aliases_normalized_alias ON aliases(normalized_alias);

    CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const insertProduct = db.prepare(`
    INSERT OR REPLACE INTO master_products
      (item_seq, product_code, name, normalized_name, manufacturer, ingredient_code, ingredient_name, atc_code, atc_name, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let insertedProducts = 0;
  for (const product of products) {
    const itemSeq = product.itemSeq?.trim();
    const name = product.name?.trim();
    if (!itemSeq || !name) continue;
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
      product.source?.trim() ?? "UNKNOWN"
    ]);
    insertedProducts += 1;
  }
  insertProduct.free();

  const insertAlias = db.prepare(`
    INSERT INTO aliases
      (alias, normalized_alias, kind, target_item_seq, target_ingredient_code, label)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let insertedAliases = 0;
  for (const alias of aliases) {
    insertAlias.run([
      alias.alias,
      normalizeMedicationText(alias.alias),
      alias.kind,
      alias.targetItemSeq ?? null,
      alias.targetIngredientCode ?? null,
      alias.label ?? null
    ]);
    insertedAliases += 1;
  }
  insertAlias.free();

  const insertMetadata = db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(metadata)) {
    insertMetadata.run([key, String(value)]);
  }
  const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
  const generatedAt = sourceDateEpoch
    ? new Date(Number(sourceDateEpoch) * 1000).toISOString()
    : new Date().toISOString();
  insertMetadata.run(["generatedAt", generatedAt]);
  insertMetadata.run(["productCount", String(insertedProducts)]);
  insertMetadata.run(["aliasCount", String(insertedAliases)]);
  insertMetadata.free();

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, Buffer.from(db.export()));
  db.close();

  console.log(`master DB written: ${outputPath}`);
  console.log(`products=${insertedProducts} aliases=${insertedAliases}`);
}

await main();
