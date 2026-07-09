import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { TextDecoder } from "node:util";
import type { AliasEntry, MasterProductInput } from "../src/types.js";

interface Args {
  atc: string;
  ingredients: string;
  output: string;
  aliases: string;
  envFile: string;
}

interface PublicDataBody {
  header: { resultCode?: string; resultMsg?: string } | null;
  totalCount: number;
  items: Record<string, unknown>[];
}

interface LiveSeedFile {
  metadata: Record<string, string>;
  products: MasterProductInput[];
}

const DUR_USJNT_URL =
  "https://apis.data.go.kr/1471000/DURPrdlstInfoService03/getUsjntTabooInfoList03";
const EASY_DRUG_URL =
  "https://apis.data.go.kr/1471000/DrbEasyDrugInfoService/getDrbEasyDrugList";

function parseArgs(argv: string[]): Args {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || !value) continue;
    args.set(key.slice(2), value);
  }

  return {
    atc: args.get("atc") ?? "data/source/atc_mapping.csv",
    ingredients: args.get("ingredients") ?? "data/source/ingredient_master.csv",
    output: args.get("output") ?? "data/master.live.seed.json",
    aliases: args.get("aliases") ?? "data/aliases.live.json",
    envFile: args.get("env-file") ?? ".secrets/mfds.env"
  };
}

function parseEnvFile(path: string): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(path, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, "")];
        })
        .filter(([key]) => key)
    );
  } catch {
    return {};
  }
}

function readSourceText(path: string): string {
  const buffer = readFileSync(path);
  const utf8 = buffer.toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;

  try {
    return new TextDecoder("euc-kr").decode(buffer);
  } catch {
    return utf8;
  }
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

  const headers = rows.shift()?.map((header) => header.replace(/^\uFEFF/, "").trim()) ?? [];
  return rows.map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? ""]))
  );
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function publicDataBody(json: Record<string, unknown>): PublicDataBody {
  const response = (json.response ?? json) as Record<string, unknown>;
  const header = (response.header ?? null) as Record<string, unknown> | null;
  const body = (response.body ?? {}) as Record<string, unknown>;
  const itemsWrapper = (body.items ?? {}) as Record<string, unknown> | Record<string, unknown>[];
  const rawItems = Array.isArray(itemsWrapper)
    ? itemsWrapper
    : ((itemsWrapper as Record<string, unknown>).item ?? []);
  const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];
  return {
    header: header
      ? {
          resultCode: asString(header.resultCode),
          resultMsg: asString(header.resultMsg)
        }
      : null,
    totalCount: Number(body.totalCount ?? 0),
    items: items as Record<string, unknown>[]
  };
}

async function fetchPublicData(
  url: string,
  serviceKey: string,
  params: Record<string, string>
): Promise<PublicDataBody> {
  const endpoint = new URL(url);
  endpoint.search = new URLSearchParams({
    serviceKey,
    type: "json",
    ...params
  }).toString();

  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(`public data request failed: HTTP ${response.status}`);
  }
  const json = (await response.json()) as Record<string, unknown>;
  const body = publicDataBody(json);
  if (body.header?.resultCode && body.header.resultCode !== "00") {
    throw new Error(`${body.header.resultCode}: ${body.header.resultMsg ?? "public data error"}`);
  }
  return body;
}

function upsertProduct(
  products: Map<string, MasterProductInput>,
  product: MasterProductInput
): void {
  const itemSeq = product.itemSeq?.trim();
  const name = product.name?.trim();
  if (!itemSeq || !name) return;

  const existing = products.get(itemSeq);
  products.set(itemSeq, {
    itemSeq,
    productCode: product.productCode?.trim() || existing?.productCode || itemSeq,
    name,
    manufacturer: product.manufacturer?.trim() || existing?.manufacturer || "",
    ingredientCode: product.ingredientCode?.trim() || existing?.ingredientCode || "",
    ingredientName: product.ingredientName?.trim() || existing?.ingredientName || "",
    atcCode: product.atcCode?.trim() || existing?.atcCode || "",
    atcName: product.atcName?.trim() || existing?.atcName || "",
    source: product.source?.trim() || existing?.source || "PUBLIC_DATA"
  });
}

function addAlias(aliases: AliasEntry[], alias: AliasEntry): void {
  const key = `${alias.alias}|${alias.kind}|${alias.targetItemSeq ?? ""}|${alias.targetIngredientCode ?? ""}`;
  if (
    aliases.some(
      (existing) =>
        `${existing.alias}|${existing.kind}|${existing.targetItemSeq ?? ""}|${existing.targetIngredientCode ?? ""}` === key
    )
  ) {
    return;
  }
  aliases.push(alias);
}

function findProduct(products: Iterable<MasterProductInput>, terms: readonly string[]): MasterProductInput | null {
  const normalizedTerms = terms.map((term) => term.replace(/\s/g, ""));
  const matches: MasterProductInput[] = [];
  for (const product of products) {
    const name = product.name.replace(/\s/g, "");
    if (normalizedTerms.every((term) => name.includes(term))) matches.push(product);
  }
  return matches.sort((a, b) => sourcePriority(a.source) - sourcePriority(b.source))[0] ?? null;
}

function findProductByAlternatives(
  products: Iterable<MasterProductInput>,
  alternatives: readonly (readonly string[])[]
): MasterProductInput | null {
  for (const terms of alternatives) {
    const product = findProduct(products, terms);
    if (product) return product;
  }
  return null;
}

function sourceAlias(productName: string): string {
  return productName
    .replace(/\([^)]*\)/g, "")
    .replace(/_.*/, "")
    .replace(/정|캡슐|시럽|액|주사|밀리그람|mg|그램|g/gi, "")
    .trim();
}

function sourcePriority(source: string | undefined): number {
  if (source === "MFDS_EASY_DRUG_API") return 0;
  if (source === "MFDS_DUR_USJNT_TABOO_API") return 1;
  if (source === "HIRA_ATC_MAPPING") return 2;
  return 3;
}

async function findRedCase(serviceKey: string): Promise<{ row: Record<string, unknown>; totalCount: number }> {
  const configuredItemSeq = process.env.LIVE_SELF_TEST_ITEM_SEQ?.trim();
  if (configuredItemSeq) {
    const body = await fetchPublicData(DUR_USJNT_URL, serviceKey, {
      pageNo: "1",
      numOfRows: "100",
      itemSeq: configuredItemSeq
    });
    const row = body.items.find((item) => asString(item.ITEM_SEQ) && asString(item.MIXTURE_ITEM_SEQ));
    if (!row) throw new Error(`No DUR red-case row returned for ${configuredItemSeq}`);
    return { row, totalCount: body.totalCount };
  }

  const samplePages = [2000, 500, 1000, 1, 4000, 6000, 8000];
  const seen = new Set<string>();
  let best: { row: Record<string, unknown>; totalCount: number } | null = null;

  for (const pageNo of samplePages) {
    const body = await fetchPublicData(DUR_USJNT_URL, serviceKey, {
      pageNo: String(pageNo),
      numOfRows: "20"
    });
    const candidates = body.items.filter((row) => asString(row.ITEM_SEQ) && asString(row.MIXTURE_ITEM_SEQ));

    for (const row of candidates) {
      const itemSeq = asString(row.ITEM_SEQ);
      if (seen.has(itemSeq)) continue;
      seen.add(itemSeq);

      const check = await fetchPublicData(DUR_USJNT_URL, serviceKey, {
        pageNo: "1",
        numOfRows: "1",
        itemSeq
      });
      const candidate = { row, totalCount: check.totalCount };
      if (!best || candidate.totalCount < best.totalCount) best = candidate;
      if (candidate.totalCount > 0 && candidate.totalCount <= 100) return candidate;
    }
  }

  if (!best) throw new Error("No DUR red-case row returned");
  return best;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const fileEnv = parseEnvFile(args.envFile);
  const serviceKey =
    process.env.MFDS_SERVICE_KEY ||
    process.env.DUR_SERVICE_KEY ||
    process.env.EASY_DRUG_SERVICE_KEY ||
    fileEnv.MFDS_SERVICE_KEY ||
    fileEnv.DUR_SERVICE_KEY ||
    fileEnv.EASY_DRUG_SERVICE_KEY;
  if (!serviceKey) {
    throw new Error("MFDS_SERVICE_KEY is required in env or .secrets/mfds.env");
  }

  const ingredientRows = parseCsv(readSourceText(args.ingredients));
  const ingredientNameByCode = new Map<string, string>();
  for (const row of ingredientRows) {
    const code = row["일반명코드"];
    const name = row["일반명"];
    if (code && name) ingredientNameByCode.set(code, name);
  }

  const products = new Map<string, MasterProductInput>();
  const atcRows = parseCsv(readSourceText(args.atc));
  for (const row of atcRows) {
    const productCode = row["제품코드"];
    upsertProduct(products, {
      itemSeq: productCode,
      productCode,
      name: row["제품명"],
      manufacturer: row["업체명"],
      ingredientCode: row["주성분코드"],
      ingredientName: ingredientNameByCode.get(row["주성분코드"]) ?? "",
      atcCode: row["ATC코드"],
      atcName: row["ATC코드 명칭"] ?? row["ATC코드명칭"] ?? "",
      source: "HIRA_ATC_MAPPING"
    });
  }

  const easyNumOfRows = 100;
  let easyPageNo = 1;
  let easyTotalCount = Number.POSITIVE_INFINITY;
  while ((easyPageNo - 1) * easyNumOfRows < easyTotalCount) {
    const body = await fetchPublicData(EASY_DRUG_URL, serviceKey, {
      pageNo: String(easyPageNo),
      numOfRows: String(easyNumOfRows)
    });
    easyTotalCount = body.totalCount;
    for (const row of body.items) {
      upsertProduct(products, {
        itemSeq: asString(row.itemSeq),
        productCode: asString(row.itemSeq),
        name: asString(row.itemName),
        manufacturer: asString(row.entpName),
        source: "MFDS_EASY_DRUG_API"
      });
    }
    easyPageNo += 1;
  }

  const redCaseResult = await findRedCase(serviceKey);
  const redCase = redCaseResult.row;

  upsertProduct(products, {
    itemSeq: asString(redCase.ITEM_SEQ),
    productCode: asString(redCase.ITEM_SEQ),
    name: asString(redCase.ITEM_NAME),
    manufacturer: asString(redCase.ENTP_NAME),
    ingredientCode: asString(redCase.INGR_CODE),
    ingredientName: asString(redCase.INGR_KOR_NAME),
    source: "MFDS_DUR_USJNT_TABOO_API"
  });
  upsertProduct(products, {
    itemSeq: asString(redCase.MIXTURE_ITEM_SEQ),
    productCode: asString(redCase.MIXTURE_ITEM_SEQ),
    name: asString(redCase.MIXTURE_ITEM_NAME),
    manufacturer: asString(redCase.MIXTURE_ENTP_NAME),
    ingredientCode: asString(redCase.MIXTURE_INGR_CODE),
    ingredientName: asString(redCase.MIXTURE_INGR_KOR_NAME),
    source: "MFDS_DUR_USJNT_TABOO_API"
  });

  const aliases: AliasEntry[] = [];
  for (const [alias, alternatives] of [
    ["타이레놀", [["타이레놀정500"], ["타이레놀정"]]],
    ["게보린", [["게보린정"], ["게보린"]]],
    ["게보린브이", [["게보린브이"]]],
    ["부루펜", [["부루펜정200"], ["부루펜"]]],
    ["어린이부루펜", [["어린이부루펜시럽"], ["부루펜시럽"]]],
    ["아스피린", [["아스피린프로텍트"], ["아스피린"]]],
    ["와파린", [["와파린"]]],
    ["낙센", [["낙센정"], ["낙센"]]],
    ["판콜", [["판콜에이"], ["판콜"]]],
    ["판피린", [["판피린큐"], ["판피린"]]]
  ] as const) {
    const product = findProductByAlternatives(products.values(), alternatives);
    if (product?.itemSeq) {
      addAlias(aliases, {
        alias,
        kind: "PRODUCT",
        targetItemSeq: product.itemSeq,
        label: product.name
      });
    }
  }

  const redSource = products.get(asString(redCase.ITEM_SEQ));
  const redTarget = products.get(asString(redCase.MIXTURE_ITEM_SEQ));
  if (redSource?.itemSeq) {
    addAlias(aliases, {
      alias: sourceAlias(redSource.name) || redSource.name,
      kind: "PRODUCT",
      targetItemSeq: redSource.itemSeq,
      label: redSource.name
    });
  }
  if (redTarget?.itemSeq) {
    addAlias(aliases, {
      alias: sourceAlias(redTarget.name) || redTarget.name,
      kind: "PRODUCT",
      targetItemSeq: redTarget.itemSeq,
      label: redTarget.name
    });
  }
  if (redSource?.ingredientCode && redSource.ingredientName) {
    addAlias(aliases, {
      alias: redSource.ingredientName,
      kind: "INGREDIENT",
      targetIngredientCode: redSource.ingredientCode,
      label: redSource.ingredientName
    });
  }
  if (redTarget?.ingredientCode && redTarget.ingredientName) {
    addAlias(aliases, {
      alias: redTarget.ingredientName,
      kind: "INGREDIENT",
      targetIngredientCode: redTarget.ingredientCode,
      label: redTarget.ingredientName
    });
  }

  const seed: LiveSeedFile = {
    metadata: {
      source: "PUBLIC_DATA_LIVE",
      atcSource: args.atc,
      ingredientSource: args.ingredients,
      easyDrugSource: EASY_DRUG_URL,
      durSource: DUR_USJNT_URL,
      liveSelfTestItemSeq: asString(redCase.ITEM_SEQ),
      liveSelfTestMixtureItemSeq: asString(redCase.MIXTURE_ITEM_SEQ),
      liveSelfTestTotalCount: String(redCaseResult.totalCount),
      liveSelfTestReason: asString(redCase.PROHBT_CONTENT)
    },
    products: Array.from(products.values()).sort((a, b) => (a.itemSeq ?? "").localeCompare(b.itemSeq ?? ""))
  };

  mkdirSync(dirname(resolve(args.output)), { recursive: true });
  mkdirSync(dirname(resolve(args.aliases)), { recursive: true });
  writeFileSync(resolve(args.output), `${JSON.stringify(seed, null, 2)}\n`);
  writeFileSync(resolve(args.aliases), `${JSON.stringify(aliases, null, 2)}\n`);

  console.log(`live seed written: ${args.output}`);
  console.log(`live aliases written: ${args.aliases}`);
  console.log(`products=${seed.products.length} aliases=${aliases.length}`);
  console.log(`liveSelfTestItemSeq=${seed.metadata.liveSelfTestItemSeq}`);
  console.log(`liveSelfTestMixtureItemSeq=${seed.metadata.liveSelfTestMixtureItemSeq}`);
}

await main();
