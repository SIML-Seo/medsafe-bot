import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import initSqlJs, { type Database } from "sql.js";
import type { AliasEntry, InputKind, MasterProduct } from "../types.js";

interface AliasRow {
  alias: string;
  normalizedAlias: string;
  kind: Exclude<InputKind, "UNKNOWN">;
  targetItemSeq: string | null;
  targetIngredientCode: string | null;
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
    source: asString(row.source)
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
    label: row.label == null ? null : asString(row.label)
  };
}

export class MasterRepository {
  private constructor(private readonly db: Database) {}

  static async open(dbPath: string): Promise<MasterRepository> {
    if (!existsSync(dbPath)) {
      throw new Error(`master DB not found: ${dbPath}. Run npm run build:master first.`);
    }

    const SQL = await initSqlJs({
      locateFile: (file) => join(process.cwd(), "node_modules/sql.js/dist", file)
    });
    const db = new SQL.Database(readFileSync(dbPath));
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
    const stmt = this.db.prepare("SELECT * FROM master_products WHERE ingredient_code = ?");
    const products: MasterProduct[] = [];
    try {
      stmt.bind([ingredientCode]);
      while (stmt.step()) products.push(productFromRow(stmt.getAsObject()));
      return products;
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
}
