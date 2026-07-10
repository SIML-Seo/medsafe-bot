import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import initSqlJs, { type Database } from "sql.js";
import type {
  DurContraindication,
  DurIngredientContraindication,
  DurIngredientMapping,
  DurIngredientMappingBasis,
  DurSnapshot,
  EasyDrugInfo,
  InputKind,
  MasterProduct,
  ProductIngredient
} from "../types.js";
import { canonicalIngredientIdentity } from "../utils/text.js";

export interface DurIngredientCoverage {
  coveredProducts: number;
  totalProducts: number;
  productsWithIngredients: number;
  catalogIdentityCount: number;
  mappedCatalogIdentityCount: number;
  unmappedCatalogIdentityCount: number;
  ratio: number;
  catalogMappingRatio: number;
}

interface AliasRow {
  alias: string;
  normalizedAlias: string;
  kind: Exclude<InputKind, "UNKNOWN">;
  targetItemSeq: string | null;
  targetIngredientCode: string | null;
  targetIngredientKey: string | null;
  label: string | null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function productFromRow(row: Record<string, unknown>): MasterProduct {
  return {
    itemSeq: asString(row.item_seq),
    productCode: asString(row.product_code),
    name: asString(row.name),
    normalizedName: asString(row.normalized_name),
    manufacturer: asString(row.manufacturer),
    ingredientCode: asString(row.ingredient_code),
    ingredientName: asString(row.ingredient_name),
    atcCode: asString(row.atc_code),
    atcName: asString(row.atc_name),
    source: asString(row.source),
    ingredientsComplete: Number(row.ingredients_complete) === 1
  };
}

function aliasFromRow(row: Record<string, unknown>): AliasRow {
  return {
    alias: asString(row.alias),
    normalizedAlias: asString(row.normalized_alias),
    kind: asString(row.kind) as Exclude<InputKind, "UNKNOWN">,
    targetItemSeq: row.target_item_seq == null ? null : asString(row.target_item_seq),
    targetIngredientCode:
      row.target_ingredient_code == null ? null : asString(row.target_ingredient_code),
    targetIngredientKey:
      row.target_ingredient_key == null ? null : asString(row.target_ingredient_key),
    label: row.label == null ? null : asString(row.label)
  };
}

function ingredientFromRow(row: Record<string, unknown>): ProductIngredient {
  const durIngredientMappings = asString(row.dur_ingredient_mappings)
    .split("\u001f")
    .filter(Boolean)
    .map((value): DurIngredientMapping => {
      const [key = "", rawCodes = "", rawBasis = "FALLBACK"] = value.split("\u001e");
      return {
        key,
        codes: rawCodes.split("\u001d").filter(Boolean),
        basis: rawBasis as DurIngredientMappingBasis
      };
    });
  const durIngredientKeys = durIngredientMappings.map((mapping) => mapping.key).filter(Boolean);
  return {
    itemSeq: asString(row.item_seq),
    ingredientKey: asString(row.ingredient_key),
    durIngredientKeys,
    durIngredientMappings,
    ingredientName: asString(row.ingredient_name),
    ingredientCode: asString(row.ingredient_code)
  };
}

export class MasterRepository {
  private durIngredientCoverageCache: DurIngredientCoverage | null = null;

  private constructor(private readonly db: Database) {}

  static async open(dbPath: string): Promise<MasterRepository> {
    if (!existsSync(dbPath)) {
      throw new Error(`master DB not found: ${dbPath}. Run npm run build:master first.`);
    }

    const SQL = await initSqlJs({
      locateFile: (file) => join(process.cwd(), "node_modules/sql.js/dist", file)
    });
    const db = new SQL.Database(readFileSync(dbPath));
    const quickCheck = db.exec("PRAGMA quick_check");
    if (asString(quickCheck[0]?.values[0]?.[0]).toLowerCase() !== "ok") {
      db.close();
      throw new Error(`master DB integrity check failed: ${dbPath}`);
    }
    const foreignKeyViolations = db.exec("PRAGMA foreign_key_check");
    if ((foreignKeyViolations[0]?.values.length ?? 0) > 0) {
      db.close();
      throw new Error(`master DB foreign-key integrity check failed: ${dbPath}`);
    }
    return new MasterRepository(db);
  }

  close(): void {
    this.db.close();
  }

  getProduct(itemSeq: string): MasterProduct | null {
    const stmt = this.db.prepare("SELECT * FROM master_products WHERE item_seq = ?");
    try {
      stmt.bind([itemSeq]);
      if (!stmt.step()) return null;
      return productFromRow(stmt.getAsObject());
    } finally {
      stmt.free();
    }
  }

  getProducts(itemSeqs: string[]): MasterProduct[] {
    return itemSeqs
      .map((itemSeq) => this.getProduct(itemSeq))
      .filter((product): product is MasterProduct => product !== null);
  }

  getProductsByIngredient(ingredientCode: string): MasterProduct[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT product.*
      FROM master_products product
      JOIN product_ingredients ingredient ON ingredient.item_seq = product.item_seq
      WHERE ingredient.ingredient_code = ?
    `);
    const products: MasterProduct[] = [];
    try {
      stmt.bind([ingredientCode]);
      while (stmt.step()) products.push(productFromRow(stmt.getAsObject()));
      return products;
    } finally {
      stmt.free();
    }
  }

  getProductsByIngredientKey(ingredientKey: string): MasterProduct[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT product.*
      FROM master_products product
      JOIN product_ingredients ingredient ON ingredient.item_seq = product.item_seq
      WHERE ingredient.ingredient_key = ?
      ORDER BY product.name, product.item_seq
    `);
    const products: MasterProduct[] = [];
    try {
      stmt.bind([ingredientKey]);
      while (stmt.step()) products.push(productFromRow(stmt.getAsObject()));
      return products;
    } finally {
      stmt.free();
    }
  }

  getProductIngredients(itemSeq: string): ProductIngredient[] {
    const stmt = this.db.prepare(`
      SELECT ingredient.*,
             GROUP_CONCAT(
               dur_key.dur_ingredient_key || CHAR(30) ||
               dur_key.dur_ingredient_codes || CHAR(30) ||
               dur_key.mapping_basis,
               CHAR(31)
             ) AS dur_ingredient_mappings
      FROM product_ingredients ingredient
      JOIN product_ingredient_dur_keys dur_key
        ON dur_key.item_seq = ingredient.item_seq
       AND dur_key.ingredient_key = ingredient.ingredient_key
      WHERE ingredient.item_seq = ?
      GROUP BY ingredient.item_seq, ingredient.ingredient_key
      ORDER BY ingredient.ingredient_key
    `);
    const ingredients: ProductIngredient[] = [];
    try {
      stmt.bind([itemSeq]);
      while (stmt.step()) ingredients.push(ingredientFromRow(stmt.getAsObject()));
      return ingredients;
    } finally {
      stmt.free();
    }
  }

  allProductIngredients(): ProductIngredient[] {
    const result = this.db.exec(`
      SELECT ingredient.*,
             GROUP_CONCAT(
               dur_key.dur_ingredient_key || CHAR(30) ||
               dur_key.dur_ingredient_codes || CHAR(30) ||
               dur_key.mapping_basis,
               CHAR(31)
             ) AS dur_ingredient_mappings
      FROM product_ingredients ingredient
      JOIN product_ingredient_dur_keys dur_key
        ON dur_key.item_seq = ingredient.item_seq
       AND dur_key.ingredient_key = ingredient.ingredient_key
      GROUP BY ingredient.item_seq, ingredient.ingredient_key
      ORDER BY ingredient.item_seq, ingredient.ingredient_key
    `);
    const table = result[0];
    if (!table) return [];
    return table.values.map((values) => {
      const row = Object.fromEntries(
        table.columns.map((column, index) => [column, values[index]])
      );
      return ingredientFromRow(row);
    });
  }

  getEasyDrugInfo(itemSeq: string): EasyDrugInfo | null {
    const stmt = this.db.prepare("SELECT * FROM easy_drug_info WHERE item_seq = ?");
    try {
      stmt.bind([itemSeq]);
      if (!stmt.step()) return null;
      const row = stmt.getAsObject();
      return {
        itemSeq: asString(row.item_seq),
        itemName: asString(row.item_name),
        entpName: asString(row.entp_name),
        efcyQesitm: optionalString(row.efcy_qesitm),
        useMethodQesitm: optionalString(row.use_method_qesitm),
        atpnWarnQesitm: optionalString(row.atpn_warn_qesitm),
        atpnQesitm: optionalString(row.atpn_qesitm),
        intrcQesitm: optionalString(row.intrc_qesitm),
        seQesitm: optionalString(row.se_qesitm),
        depositMethodQesitm: optionalString(row.deposit_method_qesitm)
      };
    } finally {
      stmt.free();
    }
  }

  getDurSnapshot(itemSeq: string): DurSnapshot | null {
    const status = this.db.prepare("SELECT * FROM dur_snapshot_status WHERE item_seq = ?");
    try {
      status.bind([itemSeq]);
      if (!status.step()) return null;
      const row = status.getAsObject();
      return {
        itemSeq,
        complete: Number(row.complete) === 1,
        fetchedAt: asString(row.fetched_at),
        source: asString(row.source),
        contraindications: this.getDurContraindications(itemSeq)
      };
    } finally {
      status.free();
    }
  }

  hasCompleteDurIngredientCatalog(): boolean {
    return this.metadata("durIngredientCatalogComplete") === "true";
  }

  getKnownDurIngredientKeys(ingredientKeys: string[]): Set<string> {
    const keys = Array.from(new Set(ingredientKeys.filter(Boolean)));
    if (keys.length === 0) return new Set();
    const placeholders = keys.map(() => "?").join(",");
    const stmt = this.db.prepare(`
      SELECT source_ingredient_key AS ingredient_key
      FROM dur_ingredient_contraindications
      WHERE source_ingredient_key IN (${placeholders})
      UNION
      SELECT target_ingredient_key AS ingredient_key
      FROM dur_ingredient_contraindications
      WHERE target_ingredient_key IN (${placeholders})
    `);
    try {
      stmt.bind([...keys, ...keys]);
      const found = new Set<string>();
      while (stmt.step()) found.add(asString(stmt.getAsObject().ingredient_key));
      return found;
    } finally {
      stmt.free();
    }
  }

  getDurIngredientCoverage(): DurIngredientCoverage {
    if (this.durIngredientCoverageCache) return { ...this.durIngredientCoverageCache };
    const totalProducts = this.scalarCount("SELECT COUNT(*) AS count FROM master_products");
    const catalogRows = this.db.exec(`
      SELECT source_ingredient_key AS ingredient_key FROM dur_ingredient_contraindications
      UNION
      SELECT target_ingredient_key AS ingredient_key FROM dur_ingredient_contraindications
    `);
    const catalogKeys = new Set<string>();
    const catalogTable = catalogRows[0];
    if (catalogTable) {
      for (const row of catalogTable.values) {
        const key = asString(row[0]);
        if (key) catalogKeys.add(key);
      }
    }

    const keysByProduct = new Map<string, string[]>();
    const incompleteProducts = new Set(
      this.allProducts()
        .filter((product) => !product.ingredientsComplete)
        .map((product) => product.itemSeq)
    );
    const productIdentityKeys = new Set<string>();
    for (const ingredient of this.allProductIngredients()) {
      const keys = keysByProduct.get(ingredient.itemSeq) ?? [];
      keys.push(...ingredient.durIngredientKeys);
      keysByProduct.set(ingredient.itemSeq, keys);
      for (const key of ingredient.durIngredientKeys) {
        if (key) productIdentityKeys.add(key);
      }
    }
    const coveredProducts = Array.from(keysByProduct.entries()).filter(
      ([itemSeq, keys]) =>
        !incompleteProducts.has(itemSeq) && keys.length > 0 && keys.every(Boolean)
    ).length;
    const mappedCatalogIdentityCount = Array.from(catalogKeys).filter((key) =>
      productIdentityKeys.has(key)
    ).length;
    this.durIngredientCoverageCache = {
      coveredProducts,
      totalProducts,
      productsWithIngredients: keysByProduct.size,
      catalogIdentityCount: catalogKeys.size,
      mappedCatalogIdentityCount,
      unmappedCatalogIdentityCount: catalogKeys.size - mappedCatalogIdentityCount,
      ratio: totalProducts > 0 ? coveredProducts / totalProducts : 0,
      catalogMappingRatio:
        catalogKeys.size > 0 ? mappedCatalogIdentityCount / catalogKeys.size : 0
    };
    return { ...this.durIngredientCoverageCache };
  }

  getDurIngredientContraindications(
    sourceIngredientKeys: string[]
  ): DurIngredientContraindication[] {
    const keys = Array.from(new Set(sourceIngredientKeys.filter(Boolean)));
    if (keys.length === 0) return [];
    const placeholders = keys.map(() => "?").join(",");
    const stmt = this.db.prepare(`
      SELECT *
      FROM dur_ingredient_contraindications
      WHERE source_ingredient_key IN (${placeholders})
      ORDER BY id
    `);
    const findings: DurIngredientContraindication[] = [];
    try {
      stmt.bind(keys);
      while (stmt.step()) {
        const row = stmt.getAsObject();
        findings.push({
          sourceIngredientCode: optionalString(row.source_ingredient_code) ?? null,
          sourceIngredientName: asString(row.source_ingredient_name),
          sourceIngredientKey: asString(row.source_ingredient_key),
          targetIngredientCode: optionalString(row.target_ingredient_code) ?? null,
          targetIngredientName: asString(row.target_ingredient_name),
          targetIngredientKey: asString(row.target_ingredient_key),
          sourceMixType: optionalString(row.source_mix_type),
          sourceMixture: optionalString(row.source_mixture),
          sourceRelation: optionalString(row.source_relation),
          targetMixType: optionalString(row.target_mix_type),
          targetMixture: optionalString(row.target_mixture),
          targetRelation: optionalString(row.target_relation),
          reason: asString(row.reason),
          baseDate: asString(row.base_date),
          dateBasis: asString(row.date_basis) as DurIngredientContraindication["dateBasis"],
          source: asString(row.source)
        });
      }
      return findings;
    } finally {
      stmt.free();
    }
  }

  private getDurContraindications(itemSeq: string): DurContraindication[] {
    const stmt = this.db.prepare(
      "SELECT * FROM dur_contraindications WHERE source_item_seq = ? ORDER BY id"
    );
    const findings: DurContraindication[] = [];
    try {
      stmt.bind([itemSeq]);
      while (stmt.step()) {
        const row = stmt.getAsObject();
        findings.push({
          sourceItemSeq: asString(row.source_item_seq),
          targetItemSeq: optionalString(row.target_item_seq) ?? null,
          targetIngredientCode: optionalString(row.target_ingredient_code) ?? null,
          targetIngredientName: optionalString(row.target_ingredient_name) ?? null,
          targetIngredientKey: optionalString(row.target_ingredient_key) ?? null,
          reason: asString(row.reason),
          baseDate: asString(row.base_date),
          dateBasis: asString(row.date_basis) as DurContraindication["dateBasis"],
          source: asString(row.source)
        });
      }
      return findings;
    } finally {
      stmt.free();
    }
  }

  findAliases(normalizedAlias: string): AliasRow[] {
    const stmt = this.db.prepare("SELECT * FROM aliases WHERE normalized_alias = ?");
    const rows: AliasRow[] = [];
    try {
      stmt.bind([normalizedAlias]);
      while (stmt.step()) rows.push(aliasFromRow(stmt.getAsObject()));
      return rows;
    } finally {
      stmt.free();
    }
  }

  allProducts(): MasterProduct[] {
    const result = this.db.exec("SELECT * FROM master_products");
    const table = result[0];
    if (!table) return [];
    return table.values.map((values) => {
      const row = Object.fromEntries(table.columns.map((column, index) => [column, values[index]]));
      return productFromRow(row);
    });
  }

  metadata(key: string): string | null {
    const stmt = this.db.prepare("SELECT value FROM metadata WHERE key = ?");
    try {
      stmt.bind([key]);
      if (!stmt.step()) return null;
      return asString(stmt.getAsObject().value);
    } finally {
      stmt.free();
    }
  }

  getStoredCounts(): Record<string, number> {
    return {
      productCount: this.scalarCount("SELECT COUNT(*) FROM master_products"),
      aliasCount: this.scalarCount("SELECT COUNT(*) FROM aliases"),
      ingredientCount: this.scalarCount("SELECT COUNT(*) FROM product_ingredients"),
      productIngredientDurKeyCount: this.scalarCount(
        "SELECT COUNT(*) FROM product_ingredient_dur_keys"
      ),
      easyDrugInfoCount: this.scalarCount("SELECT COUNT(*) FROM easy_drug_info"),
      durSnapshotCount: this.scalarCount("SELECT COUNT(*) FROM dur_snapshot_status"),
      durFindingCount: this.scalarCount("SELECT COUNT(*) FROM dur_contraindications"),
      durIngredientFindingCount: this.scalarCount(
        "SELECT COUNT(*) FROM dur_ingredient_contraindications"
      )
    };
  }

  getDurIngredientMappingBasisCounts(): Record<string, number> {
    const result = this.db.exec(`
      SELECT mapping_basis, COUNT(*) AS count
      FROM product_ingredient_dur_keys
      GROUP BY mapping_basis
    `);
    const table = result[0];
    if (!table) return {};
    return Object.fromEntries(
      table.values.map((row) => [asString(row[0]), Number(row[1] ?? 0)])
    );
  }

  private scalarCount(sql: string): number {
    const result = this.db.exec(sql);
    return Number(result[0]?.values[0]?.[0] ?? 0);
  }
}

function optionalString(value: unknown): string | undefined {
  const text = asString(value).trim();
  return text || undefined;
}
