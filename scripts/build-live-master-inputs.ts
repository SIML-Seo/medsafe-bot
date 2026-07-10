import { createHash, randomUUID } from "node:crypto";
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
import { dirname, resolve } from "node:path";
import { TextDecoder } from "node:util";
import iconv from "iconv-lite";
import type {
  AliasEntry,
  DurContraindication,
  DurIngredientContraindication,
  DurSnapshotInput,
  EasyDrugInfo,
  MasterProductInput
} from "../src/types.js";
import {
  canonicalIngredientIdentity,
  canonicalProductCode,
  compactText,
  normalizeIngredientName
} from "../src/utils/text.js";
import { analyzeMfDSMaterialIngredients } from "../src/utils/materialName.js";
import {
  durIngredientAliasMappingsForSide,
  durIngredientContraindicationFromRow,
  durDeletionState,
  hasPotentialDurIdentityVariant,
  isDeletedDurRow,
  normalizedDurDate,
  parseDurIngredientReferences,
  resolveDurIngredientMaterialKeys
} from "../src/utils/durIngredient.js";
import {
  publicDataItems,
  publicDataPageFingerprint,
  publicDataRowFingerprint
} from "../src/utils/publicDataIntegrity.js";

interface Args {
  atc: string;
  ingredients: string;
  output: string;
  aliases: string;
  envFile: string;
}

interface PublicDataBody {
  totalCount: number;
  items: Record<string, unknown>[];
}

interface LiveSeedFile {
  metadata: Record<string, string>;
  products: MasterProductInput[];
  easyDrugInfo: EasyDrugInfo[];
  durSnapshots: DurSnapshotInput[];
  durIngredientContraindications: DurIngredientContraindication[];
}

interface LiveAliasFile {
  metadata: Record<string, string>;
  aliases: AliasEntry[];
}

interface HiraRow {
  productCode: string;
  ingredientCode: string;
  ingredientName: string;
  atcCode: string;
  atcName: string;
}

const DUR_BASE_URL = "https://apis.data.go.kr/1471000/DURPrdlstInfoService03";
const DUR_PRODUCT_URL = `${DUR_BASE_URL}/getDurPrdlstInfoList03`;
const DUR_USJNT_URL = `${DUR_BASE_URL}/getUsjntTabooInfoList03`;
const DUR_INGREDIENT_USJNT_URL =
  "https://apis.data.go.kr/1471000/DURIrdntInfoService03/getUsjntTabooInfoList02";
const EASY_DRUG_URL =
  "https://apis.data.go.kr/1471000/DrbEasyDrugInfoService/getDrbEasyDrugList";
const DEFAULT_RED_CASE_ITEM_SEQ = "200108429";
const DEFAULT_RED_CASE_TARGET_ITEM_SEQ = "197900145";
const PUBLIC_DATA_TIMEOUT_MS = 15_000;
const PUBLIC_DATA_RETRIES = 2;

class PublicDataHttpError extends Error {
  constructor(readonly status: number) {
    super(`public data request failed: HTTP ${status}`);
  }
}

const BRAND_ALIASES: ReadonlyArray<readonly [string, readonly (readonly string[])[]]> = [
  ["타이레놀", [["타이레놀"]]],
  ["게보린", [["게보린"]]],
  ["게보린브이", [["게보린브이"]]],
  ["부루펜", [["부루펜"]]],
  ["어린이부루펜", [["어린이", "부루펜"]]],
  ["아스피린", [["아스피린"]]],
  ["와파린", [["와파린"]]],
  ["낙센", [["낙센"]]],
  ["판콜", [["판콜"]]],
  ["판피린", [["판피린"]]]
];

const INGREDIENT_ALIASES = [
  "아세트아미노펜",
  "이부프로펜",
  "아스피린",
  "와파린",
  "나프록센",
  "로바스타틴",
  "케토코나졸"
] as const;

function parseArgs(argv: string[]): Args {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key?.startsWith("--") && value) args.set(key.slice(2), value);
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
    const entries: Array<[string, string]> = [];
    for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator <= 0) continue;
      entries.push([
        line.slice(0, separator).trim(),
        line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "")
      ]);
    }
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

function readSourceText(path: string): string {
  const buffer = readFileSync(path);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    const decoded = iconv.decode(buffer, "cp949");
    if (decoded.includes("\uFFFD") || !buffer.equals(iconv.encode(decoded, "cp949"))) {
      throw new Error(`CSV is not losslessly decodable as UTF-8 or CP949: ${path}`);
    }
    return decoded;
  }
}

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      field += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(field);
      if (row.some((cell) => cell.trim())) rows.push(row);
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

function normalizePublicData(json: Record<string, unknown>): PublicDataBody {
  const response = (json.response ?? json) as Record<string, unknown>;
  const header = (response.header ?? {}) as Record<string, unknown>;
  const resultCode = asString(header.resultCode);
  if (resultCode && resultCode !== "00") {
    throw new Error(`${resultCode}: ${asString(header.resultMsg) || "public data error"}`);
  }
  const body = (response.body ?? {}) as Record<string, unknown>;
  const totalCount = Number(body.totalCount);
  if (!Number.isFinite(totalCount) || totalCount < 0) {
    throw new Error("public data totalCount is missing or invalid");
  }
  const items = publicDataItems(body.items);
  return { totalCount, items };
}

async function fetchPublicData(
  endpoint: string,
  serviceKey: string,
  params: Record<string, string>
): Promise<PublicDataBody> {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({ serviceKey, type: "json", ...params }).toString();
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= PUBLIC_DATA_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PUBLIC_DATA_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt < PUBLIC_DATA_RETRIES) {
          await delay(retryDelayMs(response, attempt));
          continue;
        }
        throw new PublicDataHttpError(response.status);
      }
      return normalizePublicData((await response.json()) as Record<string, unknown>);
    } catch (error) {
      lastError = error;
      if (error instanceof PublicDataHttpError && error.status < 500 && error.status !== 429) {
        throw error;
      }
      if (attempt >= PUBLIC_DATA_RETRIES) break;
      await delay(250 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("public data request failed");
}

async function fetchAllPages(
  endpoint: string,
  serviceKey: string,
  numOfRows: number,
  extraParams: Record<string, string> = {},
  maxPages = 1000
): Promise<PublicDataBody> {
  const firstPage = await fetchPublicData(endpoint, serviceKey, {
    pageNo: "1",
    numOfRows: String(numOfRows),
    ...extraParams
  });
  if (firstPage.items.length >= firstPage.totalCount) {
    if (firstPage.items.length !== firstPage.totalCount) {
      throw new Error(`public data row count does not match totalCount for ${endpoint}`);
    }
    if (new Set(firstPage.items.map(publicDataRowFingerprint)).size !== firstPage.items.length) {
      throw new Error(`public data returned duplicate rows for ${endpoint}`);
    }
    return firstPage;
  }
  if (firstPage.items.length === 0) {
    throw new Error(`public data pagination ended early for ${endpoint}`);
  }
  const pageSize = firstPage.items.length;
  const pageCount = Math.ceil(firstPage.totalCount / pageSize);
  if (pageCount > maxPages) {
    throw new Error(`public data pagination exceeded ${maxPages} pages for ${endpoint}`);
  }
  const remainingPageNumbers = Array.from({ length: pageCount - 1 }, (_, index) => index + 2);
  const pageFingerprints = new Set([publicDataPageFingerprint(firstPage.items)]);
  const remainingPages = await mapLimit(remainingPageNumbers, 3, async (pageNo) => {
    const page = await fetchPublicData(endpoint, serviceKey, {
      pageNo: String(pageNo),
      numOfRows: String(numOfRows),
      ...extraParams
    });
    if (page.totalCount !== firstPage.totalCount) {
      throw new Error(`public data totalCount changed during pagination for ${endpoint}`);
    }
    if (page.items.length === 0 && pageNo < pageCount) {
      throw new Error(`public data pagination ended early for ${endpoint}`);
    }
    const fingerprint = publicDataPageFingerprint(page.items);
    if (pageFingerprints.has(fingerprint)) {
      throw new Error(`public data repeated an identical page for ${endpoint}`);
    }
    pageFingerprints.add(fingerprint);
    return page.items;
  });
  const items = [firstPage.items, ...remainingPages].flat();
  if (items.length !== firstPage.totalCount) {
    throw new Error(`public data row count does not match totalCount for ${endpoint}`);
  }
  const distinctRows = new Set(items.map(publicDataRowFingerprint));
  if (distinctRows.size !== items.length) {
    throw new Error(`public data returned duplicate rows across pages for ${endpoint}`);
  }
  return { totalCount: firstPage.totalCount, items };
}

function parseHiraRows(atcPath: string, ingredientPath: string): Map<string, HiraRow[]> {
  const ingredientRows = parseCsv(readSourceText(ingredientPath));
  if (ingredientRows.length < 1000) throw new Error("ingredient master CSV row count is too low");
  const ingredientNameByCode = new Map<string, string>();
  for (const row of ingredientRows) {
    if (row["일반명코드"] && row["일반명"]) {
      ingredientNameByCode.set(row["일반명코드"], row["일반명"]);
    }
  }

  const atcRows = parseCsv(readSourceText(atcPath));
  if (atcRows.length < 1000) throw new Error("ATC mapping CSV row count is too low");
  const byProductCode = new Map<string, HiraRow[]>();
  for (const row of atcRows) {
    const productCode = row["제품코드"];
    if (!productCode) continue;
    const value: HiraRow = {
      productCode,
      ingredientCode: row["주성분코드"] ?? "",
      ingredientName: ingredientNameByCode.get(row["주성분코드"] ?? "") ?? "",
      atcCode: row["ATC코드"] ?? "",
      atcName: row["ATC코드 명칭"] ?? row["ATC코드명칭"] ?? ""
    };
    const productCodeKey = canonicalProductCode(productCode);
    const values = byProductCode.get(productCodeKey) ?? [];
    values.push(value);
    byProductCode.set(productCodeKey, values);
  }
  return byProductCode;
}

function productFromMfDSRow(
  row: Record<string, unknown>,
  hiraByProductCode: Map<string, HiraRow[]>
): MasterProductInput | null {
  const itemSeq = asString(row.ITEM_SEQ);
  const name = asString(row.ITEM_NAME);
  if (!/^\d{9}$/.test(itemSeq) || !name) return null;
  const cancellation = asString(row.CANCEL_NAME);
  if (cancellation && cancellation !== "정상") return null;
  const ediCode = asString(row.EDI_CODE);
  const hiraRows = ediCode
    ? hiraByProductCode.get(canonicalProductCode(ediCode)) ?? []
    : [];
  const material = analyzeMfDSMaterialIngredients(asString(row.MATERIAL_NAME), hiraRows);
  const ingredients = material.ingredients;
  const firstIngredient = ingredients[0];
  const firstHira = hiraRows[0];
  return {
    itemSeq,
    productCode: ediCode || itemSeq,
    name,
    manufacturer: asString(row.ENTP_NAME),
    ingredientCode: firstIngredient?.ingredientCode || "",
    ingredientName: firstIngredient?.ingredientName || "",
    atcCode: firstHira?.atcCode || "",
    atcName: firstHira?.atcName || "",
    source: "MFDS_DUR_PRODUCT_API",
    ingredients,
    ingredientsComplete: material.complete
  };
}

function easyDrugInfoFromRow(row: Record<string, unknown>): EasyDrugInfo | null {
  const itemSeq = asString(row.itemSeq ?? row.ITEM_SEQ);
  const itemName = asString(row.itemName ?? row.ITEM_NAME);
  if (!/^\d{9}$/.test(itemSeq) || !itemName) return null;
  return {
    itemSeq,
    itemName,
    entpName: asString(row.entpName ?? row.ENTP_NAME),
    efcyQesitm: optionalString(row.efcyQesitm ?? row.EFCY_QESITM),
    useMethodQesitm: optionalString(row.useMethodQesitm ?? row.USE_METHOD_QESITM),
    atpnWarnQesitm: optionalString(row.atpnWarnQesitm ?? row.ATPN_WARN_QESITM),
    atpnQesitm: optionalString(row.atpnQesitm ?? row.ATPN_QESITM),
    intrcQesitm: optionalString(row.intrcQesitm ?? row.INTRC_QESITM),
    seQesitm: optionalString(row.seQesitm ?? row.SE_QESITM),
    depositMethodQesitm: optionalString(
      row.depositMethodQesitm ?? row.DEPOSIT_METHOD_QESITM
    )
  };
}

function optionalString(value: unknown): string | undefined {
  const text = asString(value);
  return text || undefined;
}

function addAlias(aliases: AliasEntry[], alias: AliasEntry): void {
  const key = [
    alias.alias,
    alias.kind,
    alias.targetItemSeq ?? "",
    alias.targetIngredientCode ?? "",
    alias.targetIngredientKey ?? ""
  ].join("|");
  const exists = aliases.some(
    (existing) =>
      [
        existing.alias,
        existing.kind,
        existing.targetItemSeq ?? "",
        existing.targetIngredientCode ?? "",
        existing.targetIngredientKey ?? ""
      ].join("|") === key
  );
  if (!exists) aliases.push(alias);
}

function findBrandCandidates(
  products: Iterable<MasterProductInput>,
  alias: string,
  alternatives: readonly (readonly string[])[]
): MasterProductInput[] {
  const matches = new Map<string, MasterProductInput>();
  for (const terms of alternatives) {
    const compactTerms = terms.map(compactText);
    for (const product of products) {
      const name = compactText(product.name);
      if (compactTerms.every((term) => name.includes(term)) && product.itemSeq) {
        matches.set(product.itemSeq, product);
      }
    }
    if (matches.size > 0) break;
  }
  const compactAlias = compactText(alias);
  return Array.from(matches.values())
    .sort((left, right) => {
      const leftName = compactText(left.name);
      const rightName = compactText(right.name);
      const leftRank = leftName === compactAlias ? 0 : leftName.startsWith(compactAlias) ? 1 : 2;
      const rightRank = rightName === compactAlias ? 0 : rightName.startsWith(compactAlias) ? 1 : 2;
      return leftRank - rightRank || leftName.length - rightName.length || leftName.localeCompare(rightName);
    })
    .slice(0, 5);
}

function productsForIngredient(
  products: Iterable<MasterProductInput>,
  ingredientKey: string
): MasterProductInput[] {
  return Array.from(products)
    .filter((product) =>
      product.ingredients?.some((ingredient) => ingredient.ingredientKey === ingredientKey)
    )
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, 5);
}

function sourceAlias(productName: string): string {
  return productName
    .replace(/\([^)]*\)/g, "")
    .replace(/_.*/, "")
    .replace(/(?:서방|장용)?정|캡슐|시럽|액|주사|밀리그람|밀리그램|mg|그램|g/gi, "")
    .trim();
}

async function fetchDurSnapshot(
  serviceKey: string,
  itemSeq: string,
  fetchedAt: string
): Promise<DurSnapshotInput> {
  const body = await fetchAllPages(
    DUR_USJNT_URL,
    serviceKey,
    500,
    { itemSeq },
    100
  );
  const findings = new Map<string, DurContraindication>();
  for (const row of body.items) {
    if (isDeletedDurRow(row)) continue;
    const sourceItemSeq = asString(row.ITEM_SEQ ?? row.itemSeq);
    if (sourceItemSeq !== itemSeq) {
      throw new Error(
        `DUR itemSeq filter mismatch: requested ${itemSeq}, received ${sourceItemSeq || "missing"}`
      );
    }
    const targetItemSeq = asString(row.MIXTURE_ITEM_SEQ ?? row.mixtureItemSeq) || null;
    const targetIngredientCode =
      asString(row.MIXTURE_INGR_CODE ?? row.mixtureIngrCode) || null;
    const targetIngredientName =
      asString(row.MIXTURE_INGR_KOR_NAME ?? row.mixtureIngrKorName) || null;
    const reason = asString(row.PROHBT_CONTENT ?? row.prohbtContent ?? row.REMARK);
    if ((!targetItemSeq && !targetIngredientCode) || !reason) {
      throw new Error(`DUR row has unresolved required fields for ${itemSeq}`);
    }
    const rawSourceBaseDate = asString(
      row.NOTIFICATION_DATE ??
        row.notificationDate ??
        row.BASE_DATE ??
        row.baseDate ??
        row.UPDATE_DATE ??
        row.updateDate
    );
    const sourceBaseDate = normalizedDurDate(rawSourceBaseDate);
    if (rawSourceBaseDate && !sourceBaseDate) {
      throw new Error(`DUR row has invalid notification date for ${itemSeq}`);
    }
    const finding: DurContraindication = {
      sourceItemSeq: itemSeq,
      targetItemSeq,
      targetIngredientCode,
      targetIngredientName,
      targetIngredientKey: targetIngredientName
        ? normalizeIngredientName(targetIngredientName)
        : null,
      reason,
      baseDate: sourceBaseDate || fetchedAt.slice(0, 10),
      dateBasis: sourceBaseDate ? "SOURCE_DATE" : "SNAPSHOT_FETCHED_AT",
      source: DUR_USJNT_URL
    };
    findings.set(
      [targetItemSeq ?? "", targetIngredientCode ?? "", reason.replace(/\s+/g, " ")].join("|"),
      finding
    );
  }
  return {
    itemSeq,
    complete: true,
    fetchedAt,
    source: DUR_USJNT_URL,
    contraindications: Array.from(findings.values())
  };
}

function configuredRedCase(args: Args, fileEnv: Record<string, string>): string[] {
  const candidates = [
    process.env.LIVE_SELF_TEST_ITEM_SEQ,
    fileEnv.LIVE_SELF_TEST_ITEM_SEQ,
    DEFAULT_RED_CASE_ITEM_SEQ,
    existingRedCase(args.output)
  ];
  return Array.from(new Set(candidates.map((value) => value?.trim()).filter(Boolean))) as string[];
}

function existingRedCase(path: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LiveSeedFile;
    return parsed.metadata?.liveSelfTestItemSeq;
  } catch {
    return undefined;
  }
}

async function chooseRedSnapshot(
  serviceKey: string,
  candidates: string[],
  fetchedAt: string
): Promise<DurSnapshotInput> {
  const errors: string[] = [];
  for (const itemSeq of candidates) {
    try {
      const snapshot = await fetchDurSnapshot(serviceKey, itemSeq, fetchedAt);
      if (snapshot.contraindications.some((finding) => finding.targetItemSeq)) return snapshot;
      errors.push(`${itemSeq}: zero target itemSeq rows`);
    } catch (error) {
      errors.push(`${itemSeq}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`No verified red-case DUR snapshot: ${errors.join(" | ")}`);
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(5000, seconds * 1000);
  }
  return 250 * 2 ** attempt;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function mapLimit<T, U>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<U>
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= values.length) return;
        results[index] = await mapper(values[index]!, index);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

async function fetchDurIngredientCatalog(
  serviceKey: string,
  fetchedAt: string
): Promise<{
  response: PublicDataBody;
  rules: Map<string, DurIngredientContraindication>;
  deletedRows: number;
  missingReasonRows: number;
}> {
  let response: PublicDataBody;
  try {
    response = await fetchAllPages(DUR_INGREDIENT_USJNT_URL, serviceKey, 500);
  } catch (error) {
    if (error instanceof PublicDataHttpError && error.status === 403) {
      throw new Error(
        "DUR ingredient API access denied. Apply for data.go.kr dataset 15056780, then reuse the existing decoding service key."
      );
    }
    throw error;
  }
  const rules = new Map<string, DurIngredientContraindication>();
  const invalidRows: number[] = [];
  let deletedRows = 0;
  let missingReasonRows = 0;
  for (const [index, row] of response.items.entries()) {
    const deletionState = durDeletionState(row);
    if (deletionState === "UNKNOWN") {
      invalidRows.push(index);
      continue;
    }
    if (deletionState === "DELETED") {
      deletedRows += 1;
      continue;
    }
    if (!asString(row.PROHBT_CONTENT ?? row.prohbtContent ?? row.REMARK ?? row.remark)) {
      missingReasonRows += 1;
    }
    const finding = durIngredientContraindicationFromRow(
      row,
      fetchedAt,
      DUR_INGREDIENT_USJNT_URL
    );
    if (!finding) {
      invalidRows.push(index);
      continue;
    }
    const key = [
      finding.sourceIngredientKey,
      finding.targetIngredientKey,
      finding.sourceMixType ?? "",
      finding.sourceMixture ?? "",
      finding.sourceRelation ?? "",
      finding.targetMixType ?? "",
      finding.targetMixture ?? "",
      finding.targetRelation ?? "",
      finding.reason.replace(/\s+/g, " ").trim()
    ].join("|");
    const existing = rules.get(key);
    if (!existing || finding.baseDate > existing.baseDate) rules.set(key, finding);
  }
  if (invalidRows.length > 0) {
    throw new Error(
      `DUR ingredient rows have unresolved required fields: ${invalidRows.slice(0, 10).join(", ")}`
    );
  }
  if (rules.size < 100) {
    throw new Error(`DUR ingredient rule count is too low: ${rules.size}`);
  }
  return { response, rules, deletedRows, missingReasonRows };
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
  if (!serviceKey) throw new Error("MFDS_SERVICE_KEY is required in env or .secrets/mfds.env");

  const fetchedAt = new Date().toISOString();
  const generationId = randomUUID();
  const {
    response: ingredientDurResponse,
    rules: ingredientDurRules,
    deletedRows: deletedDurIngredientRows,
    missingReasonRows: missingDurIngredientReasonRows
  } = await fetchDurIngredientCatalog(serviceKey, fetchedAt);
  const hiraByProductCode = parseHiraRows(args.atc, args.ingredients);
  const productResponse = await fetchAllPages(DUR_PRODUCT_URL, serviceKey, 500);
  const products = new Map<string, MasterProductInput>();
  let cancelledProductRows = 0;
  let invalidProductRows = 0;
  let duplicateProductRows = 0;
  for (const row of productResponse.items) {
    const cancellation = asString(row.CANCEL_NAME);
    if (cancellation && cancellation !== "정상") {
      cancelledProductRows += 1;
      continue;
    }
    const product = productFromMfDSRow(row, hiraByProductCode);
    if (!product?.itemSeq) {
      invalidProductRows += 1;
      continue;
    }
    if (products.has(product.itemSeq)) {
      duplicateProductRows += 1;
      continue;
    }
    products.set(product.itemSeq, product);
  }
  if (
    productResponse.totalCount !==
    products.size + cancelledProductRows + invalidProductRows + duplicateProductRows
  ) {
    throw new Error("MFDS product source row reconciliation is invalid");
  }
  if (duplicateProductRows > 0) {
    throw new Error(`MFDS product source has duplicate itemSeq rows: ${duplicateProductRows}`);
  }
  if (products.size < 10_000) {
    throw new Error(`MFDS product count is too low after validation: ${products.size}`);
  }
  const mfdsDurProductCount = products.size;

  const easyResponse = await fetchAllPages(EASY_DRUG_URL, serviceKey, 100);
  const easyDrugInfo = new Map<string, EasyDrugInfo>();
  let invalidEasyDrugRows = 0;
  let duplicateEasyDrugRows = 0;
  let conflictingEasyDrugRows = 0;
  for (const row of easyResponse.items) {
    const info = easyDrugInfoFromRow(row);
    if (!info) {
      invalidEasyDrugRows += 1;
      continue;
    }
    if (easyDrugInfo.has(info.itemSeq)) {
      duplicateEasyDrugRows += 1;
      if (JSON.stringify(easyDrugInfo.get(info.itemSeq)) !== JSON.stringify(info)) {
        conflictingEasyDrugRows += 1;
      }
      continue;
    }
    easyDrugInfo.set(info.itemSeq, info);
    if (!products.has(info.itemSeq)) {
      products.set(info.itemSeq, {
        itemSeq: info.itemSeq,
        productCode: info.itemSeq,
        name: info.itemName,
        manufacturer: info.entpName,
        ingredientCode: "",
        ingredientName: "",
        atcCode: "",
        atcName: "",
        source: "MFDS_EASY_DRUG_API",
        ingredients: [],
        ingredientsComplete: false
      });
    }
  }
  if (easyResponse.totalCount !== easyDrugInfo.size + invalidEasyDrugRows + duplicateEasyDrugRows) {
    throw new Error("e약은요 source row reconciliation is invalid");
  }
  if (conflictingEasyDrugRows > 0) {
    throw new Error(
      `e약은요 source has conflicting duplicate itemSeq rows: ${conflictingEasyDrugRows}`
    );
  }
  if (easyDrugInfo.size < 1000) {
    throw new Error(`e약은요 item count is too low after validation: ${easyDrugInfo.size}`);
  }

  const durIngredientAliasTargets = new Map<string, Set<string>>();
  const declaredDurIngredientRelationKeys = new Set<string>();
  for (const rule of ingredientDurRules.values()) {
    for (const relation of [rule.sourceRelation, rule.targetRelation]) {
      for (const reference of parseDurIngredientReferences(relation ?? "")) {
        declaredDurIngredientRelationKeys.add(reference.key);
      }
    }
    for (const mapping of [
      ...durIngredientAliasMappingsForSide(
        rule.sourceIngredientKey,
        rule.sourceMixture,
        rule.sourceRelation
      ),
      ...durIngredientAliasMappingsForSide(
        rule.targetIngredientKey,
        rule.targetMixture,
        rule.targetRelation
      )
    ]) {
      const targets = durIngredientAliasTargets.get(mapping.aliasKey) ?? new Set<string>();
      targets.add(mapping.catalogKey);
      durIngredientAliasTargets.set(mapping.aliasKey, targets);
    }
  }
  const unmappedDurIngredientRelationKeys = new Set(
    Array.from(declaredDurIngredientRelationKeys).filter(
      (key) => !durIngredientAliasTargets.has(key)
    )
  );
  const durIngredientCatalogKeys = new Set(
    Array.from(ingredientDurRules.values()).flatMap((rule) => [
      rule.sourceIngredientKey,
      rule.targetIngredientKey
    ])
  );
  const durIngredientCatalogCodes = new Map<string, Set<string>>();
  const addDurCatalogCode = (key: string, code: string | null | undefined): void => {
    const normalizedCode = code?.trim().toUpperCase();
    if (!key || !normalizedCode) return;
    const codes = durIngredientCatalogCodes.get(key) ?? new Set<string>();
    codes.add(normalizedCode);
    durIngredientCatalogCodes.set(key, codes);
  };
  for (const rule of ingredientDurRules.values()) {
    addDurCatalogCode(rule.sourceIngredientKey, rule.sourceIngredientCode);
    addDurCatalogCode(rule.targetIngredientKey, rule.targetIngredientCode);
    for (const reference of parseDurIngredientReferences(rule.sourceMixture ?? "")) {
      addDurCatalogCode(reference.key, reference.code);
    }
    for (const reference of parseDurIngredientReferences(rule.targetMixture ?? "")) {
      addDurCatalogCode(reference.key, reference.code);
    }
  }
  const knownDurIdentityKeys = new Set([
    ...durIngredientCatalogKeys,
    ...durIngredientAliasTargets.keys()
  ]);
  const activeDurIngredientRowCount =
    ingredientDurResponse.items.length - deletedDurIngredientRows;
  const duplicateDurIngredientRuleCount =
    activeDurIngredientRowCount - ingredientDurRules.size;
  if (duplicateDurIngredientRuleCount < 0) {
    throw new Error("DUR ingredient row reconciliation is invalid");
  }
  const durIngredientRelationValues = Array.from(ingredientDurRules.values()).flatMap((rule) =>
    [rule.sourceRelation, rule.targetRelation].filter(
      (value): value is string => Boolean(value?.trim())
    )
  );
  const unparsedDurIngredientRelations = durIngredientRelationValues.filter(
    (value) => !allDeclaredDurReferencesParsed(value)
  );
  if (unparsedDurIngredientRelations.length > 0) {
    throw new Error(
      `DUR relation fields could not be parsed: ${unparsedDurIngredientRelations
        .slice(0, 5)
        .join(", ")}`
    );
  }
  const durIngredientMixtureValues = Array.from(ingredientDurRules.values()).flatMap((rule) =>
    [rule.sourceMixture, rule.targetMixture].filter(
      (value): value is string => Boolean(value?.trim())
    )
  );
  const unparsedDurIngredientMixtures = durIngredientMixtureValues.filter(
    (value) => !allDeclaredDurReferencesParsed(value)
  );
  if (unparsedDurIngredientMixtures.length > 0) {
    throw new Error(
      `DUR mixture fields could not be fully parsed: ${unparsedDurIngredientMixtures
        .slice(0, 5)
        .join(", ")}`
    );
  }
  const activeExpectedDurCatalogKeys = new Set<string>();
  const activeMappedDurCatalogKeys = new Set<string>();
  const activeExpectedOfficialRelations = new Set<string>();
  const activeMappedOfficialRelations = new Set<string>();
  const activeUnmappedRelationAliases = new Set<string>();
  const activeUnmappedRelationProducts = new Set<string>();
  let conservativeDurFormMappingCount = 0;
  let curatedDurSpellingMappingCount = 0;
  let ambiguousDurFormMappingCount = 0;
  let riskyFallbackDurMappingCount = 0;
  let catalogAbsentDurMappingCount = 0;
  for (const product of products.values()) {
    for (const ingredient of product.ingredients ?? []) {
      const materialKey = canonicalIngredientIdentity(ingredient.ingredientName);
      const resolution = resolveDurIngredientMaterialKeys(
        ingredient.ingredientName,
        durIngredientAliasTargets,
        durIngredientCatalogKeys
      );
      ingredient.durIngredientKeys = resolution.keys;
      if (resolution.basis === "CONSERVATIVE_FORM") conservativeDurFormMappingCount += 1;
      if (resolution.basis === "CURATED_SPELLING") curatedDurSpellingMappingCount += 1;
      if (resolution.basis === "AMBIGUOUS_FORM") {
        ambiguousDurFormMappingCount += 1;
        product.ingredientsComplete = false;
      }
      const unresolvedOfficialRelation = unmappedDurIngredientRelationKeys.has(materialKey);
      const riskyFallback =
        resolution.basis === "FALLBACK" &&
        (unresolvedOfficialRelation ||
          hasPotentialDurIdentityVariant(ingredient.ingredientName, knownDurIdentityKeys));
      const storedBasis =
        resolution.basis === "FALLBACK" && !riskyFallback
          ? "CATALOG_ABSENT"
          : resolution.basis;
      if (riskyFallback) {
        riskyFallbackDurMappingCount += 1;
        product.ingredientsComplete = false;
      } else if (storedBasis === "CATALOG_ABSENT") {
        catalogAbsentDurMappingCount += 1;
      }
      ingredient.durIngredientMappings = resolution.keys.map((key) => ({
        key,
        codes: Array.from(durIngredientCatalogCodes.get(key) ?? []).sort(),
        basis: storedBasis
      }));
      const expectedOfficialTargets = durIngredientAliasTargets.get(materialKey);
      if (expectedOfficialTargets) {
        for (const target of expectedOfficialTargets) {
          const relationKey = `${materialKey}\u001f${target}`;
          activeExpectedOfficialRelations.add(relationKey);
          activeExpectedDurCatalogKeys.add(target);
          if (resolution.keys.includes(target)) {
            activeMappedOfficialRelations.add(relationKey);
            activeMappedDurCatalogKeys.add(target);
          } else {
            product.ingredientsComplete = false;
          }
        }
      } else if (unmappedDurIngredientRelationKeys.has(materialKey)) {
        activeUnmappedRelationAliases.add(materialKey);
        if (product.itemSeq) activeUnmappedRelationProducts.add(product.itemSeq);
        product.ingredientsComplete = false;
      }
    }
  }
  if (activeMappedOfficialRelations.size !== activeExpectedOfficialRelations.size) {
    throw new Error(
      `active official DUR relation mapping is incomplete: ${activeMappedOfficialRelations.size}/${activeExpectedOfficialRelations.size}`
    );
  }

  const redSnapshot = await chooseRedSnapshot(
    serviceKey,
    configuredRedCase(args, fileEnv),
    fetchedAt
  );
  const redFinding =
    redSnapshot.contraindications.find(
      (finding) => finding.targetItemSeq === DEFAULT_RED_CASE_TARGET_ITEM_SEQ
    ) ?? redSnapshot.contraindications.find((finding) => finding.targetItemSeq);
  if (!redFinding?.targetItemSeq) throw new Error("verified red-case has no target itemSeq");
  const redSource = products.get(redSnapshot.itemSeq);
  const redTarget = products.get(redFinding.targetItemSeq);
  if (!redSource || !redTarget) {
    throw new Error("red-case products are missing from the verified MFDS product master");
  }

  const aliases: AliasEntry[] = [];
  const snapshotItemSeqs = new Set<string>([redSource.itemSeq!, redTarget.itemSeq!]);
  for (const [alias, alternatives] of BRAND_ALIASES) {
    const candidates = findBrandCandidates(products.values(), alias, alternatives);
    for (const product of candidates) {
      addAlias(aliases, {
        alias,
        kind: "PRODUCT",
        targetItemSeq: product.itemSeq,
        label: product.name
      });
      snapshotItemSeqs.add(product.itemSeq!);
    }
  }

  for (const alias of INGREDIENT_ALIASES) {
    const ingredientKey = normalizeIngredientName(alias);
    const candidates = productsForIngredient(products.values(), ingredientKey);
    if (candidates.length === 0) continue;
    addAlias(aliases, {
      alias,
      kind: "INGREDIENT",
      targetIngredientKey: ingredientKey,
      label: alias
    });
    for (const product of candidates) snapshotItemSeqs.add(product.itemSeq!);
  }

  for (const product of [redSource, redTarget]) {
    const alias = sourceAlias(product.name) || product.name;
    addAlias(aliases, {
      alias,
      kind: "PRODUCT",
      targetItemSeq: product.itemSeq,
      label: product.name
    });
    for (const ingredient of product.ingredients ?? []) {
      const ingredientKey = ingredient.ingredientKey || normalizeIngredientName(ingredient.ingredientName);
      if (!ingredientKey) continue;
      addAlias(aliases, {
        alias: ingredient.ingredientName,
        kind: "INGREDIENT",
        targetIngredientKey: ingredientKey,
        label: ingredient.ingredientName
      });
      for (const candidate of productsForIngredient(products.values(), ingredientKey)) {
        snapshotItemSeqs.add(candidate.itemSeq!);
      }
    }
  }

  const orderedSnapshotItems = Array.from(snapshotItemSeqs).sort();
  let completedSnapshots = 0;
  const durSnapshots = await mapLimit(orderedSnapshotItems, 3, async (itemSeq) => {
    const snapshot =
      itemSeq === redSnapshot.itemSeq
        ? redSnapshot
        : await fetchDurSnapshot(serviceKey, itemSeq, fetchedAt);
    completedSnapshots += 1;
    if (completedSnapshots % 10 === 0 || completedSnapshots === orderedSnapshotItems.length) {
      console.log(`DUR snapshots ${completedSnapshots}/${orderedSnapshotItems.length}`);
    }
    return snapshot;
  });

  const snapshotTargetIngredientMismatches: string[] = [];
  let snapshotTargetIngredientUnverifiableCount = 0;
  let snapshotTargetProductMissingCount = 0;
  for (const snapshot of durSnapshots) {
    for (const finding of snapshot.contraindications) {
      if (!finding.targetItemSeq) continue;
      const targetProduct = products.get(finding.targetItemSeq);
      if (!targetProduct) {
        snapshotTargetProductMissingCount += 1;
        continue;
      }
      if (targetProduct.ingredientsComplete !== true) {
        snapshotTargetIngredientUnverifiableCount += 1;
        continue;
      }
      const targetKey = finding.targetIngredientKey
        ? canonicalIngredientIdentity(finding.targetIngredientKey)
        : finding.targetIngredientName
          ? canonicalIngredientIdentity(finding.targetIngredientName)
          : "";
      const targetCode = finding.targetIngredientCode?.trim().toUpperCase() ?? "";
      if (!targetKey && !targetCode) continue;
      const matched = (targetProduct.ingredients ?? []).some((ingredient) => {
        const ingredientKey = canonicalIngredientIdentity(ingredient.ingredientName);
        const durIngredientKeys = ingredient.durIngredientKeys ?? [ingredientKey];
        const ingredientCode = ingredient.ingredientCode?.trim().toUpperCase() ?? "";
        return (targetKey && (ingredientKey === targetKey || durIngredientKeys.includes(targetKey))) ||
          (targetCode && ingredientCode === targetCode);
      });
      if (!matched) {
        snapshotTargetIngredientMismatches.push(
          `${snapshot.itemSeq}->${finding.targetItemSeq}:${targetKey || targetCode}`
        );
      }
    }
  }
  if (snapshotTargetIngredientMismatches.length > 0) {
    throw new Error(
      `DUR snapshot target ingredients do not match the product master: ${snapshotTargetIngredientMismatches
        .slice(0, 10)
        .join(", ")} (total=${snapshotTargetIngredientMismatches.length})`
    );
  }

  const productsWithIngredients = Array.from(products.values()).filter(
    (product) => (product.ingredients?.length ?? 0) > 0
  ).length;
  if (productsWithIngredients < Math.floor(products.size * 0.5)) {
    throw new Error(
      `ingredient coverage is unexpectedly low: ${productsWithIngredients}/${products.size}`
    );
  }
  const invalidIngredientRows = Array.from(products.values()).flatMap((product) =>
    (product.ingredients ?? [])
      .filter((ingredient) =>
        isInvalidIngredientKey(ingredient.ingredientKey ?? ingredient.ingredientName)
      )
      .map((ingredient) => ({ product, ingredient }))
  );
  if (invalidIngredientRows.length > 0) {
    throw new Error(
      `invalid unit-like ingredient rows detected: ${invalidIngredientRows
        .slice(0, 5)
        .map(
          ({ product, ingredient }) =>
            `${product.itemSeq}:${product.name}:${ingredient.ingredientName}`
        )
        .join(", ")}`
    );
  }
  const replicatedCodes = Array.from(products.values()).filter((product) => {
    const keysByCode = new Map<string, Set<string>>();
    for (const ingredient of product.ingredients ?? []) {
      if (!ingredient.ingredientCode) continue;
      const keys = keysByCode.get(ingredient.ingredientCode) ?? new Set<string>();
      keys.add(ingredient.ingredientKey ?? normalizeIngredientName(ingredient.ingredientName));
      keysByCode.set(ingredient.ingredientCode, keys);
    }
    return Array.from(keysByCode.values()).some((keys) => keys.size > 1);
  });
  if (replicatedCodes.length > 0) {
    throw new Error(
      `product-level HIRA codes were replicated across distinct ingredients: ${replicatedCodes
        .slice(0, 5)
        .map((product) => product.itemSeq)
        .join(", ")}`
    );
  }

  const productIngredientIdentityKeys = new Set(
    Array.from(products.values()).flatMap((product) =>
      (product.ingredients ?? [])
        .flatMap((ingredient) =>
          ingredient.durIngredientKeys?.length
            ? ingredient.durIngredientKeys
            : [canonicalIngredientIdentity(ingredient.ingredientName)]
        )
        .filter(Boolean)
    )
  );
  const durIngredientCoveredProducts = Array.from(products.values()).filter(
    (product) =>
      product.ingredientsComplete === true &&
      (product.ingredients?.length ?? 0) > 0 &&
      product.ingredients!.every((ingredient) => {
        const keys = ingredient.durIngredientKeys?.length
          ? ingredient.durIngredientKeys
          : [canonicalIngredientIdentity(ingredient.ingredientName)];
        return keys.every(Boolean);
      })
  );
  const mappedDurCatalogIdentityCount = Array.from(durIngredientCatalogKeys).filter((key) =>
    productIngredientIdentityKeys.has(key)
  ).length;
  const durCatalogIdentityMappingRatio =
    durIngredientCatalogKeys.size > 0
      ? mappedDurCatalogIdentityCount / durIngredientCatalogKeys.size
      : 0;
  const activeMappedDurCatalogIdentityCount = activeMappedDurCatalogKeys.size;
  const activeDurCatalogMappingRatio =
    activeExpectedDurCatalogKeys.size > 0
      ? activeMappedDurCatalogIdentityCount / activeExpectedDurCatalogKeys.size
      : 0;
  if (activeExpectedDurCatalogKeys.size < 100 || activeDurCatalogMappingRatio !== 1) {
    throw new Error(
      `active-product DUR identity mapping is incomplete: ${activeMappedDurCatalogIdentityCount}/${activeExpectedDurCatalogKeys.size}`
    );
  }
  if (durIngredientCoveredProducts.length < products.size * 0.8) {
    throw new Error(
      `DUR ingredient product coverage is below 80%: ${durIngredientCoveredProducts.length}/${products.size}`
    );
  }

  const seed: LiveSeedFile = {
    metadata: {
      source: "PUBLIC_DATA_LIVE",
      dataModelVersion: "3",
      generationId,
      fetchedAt,
      atcSource: args.atc,
      atcSourceSha256: hashFile(args.atc),
      ingredientSource: args.ingredients,
      ingredientSourceSha256: hashFile(args.ingredients),
      productSource: DUR_PRODUCT_URL,
      productApiTotalCount: String(productResponse.totalCount),
      mfdsDurProductCount: String(mfdsDurProductCount),
      productCancelledRowCount: String(cancelledProductRows),
      productInvalidRowCount: String(invalidProductRows),
      productDuplicateItemSeqCount: String(duplicateProductRows),
      activeProductCount: String(products.size),
      productIngredientCoverageCount: String(productsWithIngredients),
      incompleteIngredientProductCount: String(
        Array.from(products.values()).filter((product) => product.ingredientsComplete !== true).length
      ),
      snapshotTargetIngredientMismatchCount: "0",
      snapshotTargetIngredientUnverifiableCount: String(
        snapshotTargetIngredientUnverifiableCount
      ),
      snapshotTargetProductMissingCount: String(snapshotTargetProductMissingCount),
      productIngredientCoverageRatio: (productsWithIngredients / products.size).toFixed(6),
      invalidIngredientRowCount: String(invalidIngredientRows.length),
      replicatedProductIngredientCodeCount: String(replicatedCodes.length),
      easyDrugSource: EASY_DRUG_URL,
      easyDrugApiTotalCount: String(easyResponse.totalCount),
      easyDrugInfoCount: String(easyDrugInfo.size),
      easyDrugInvalidRowCount: String(invalidEasyDrugRows),
      easyDrugDuplicateItemSeqCount: String(duplicateEasyDrugRows),
      easyDrugConflictingItemSeqCount: String(conflictingEasyDrugRows),
      durSource: DUR_USJNT_URL,
      durSnapshotCount: String(durSnapshots.length),
      curatedDurProductCount: String(orderedSnapshotItems.length),
      curatedDurCoverageRatio: (durSnapshots.length / orderedSnapshotItems.length).toFixed(6),
      overallDurSnapshotCoverageRatio: (durSnapshots.length / products.size).toFixed(6),
      durIngredientSource: DUR_INGREDIENT_USJNT_URL,
      durIngredientApiTotalCount: String(ingredientDurResponse.totalCount),
      durIngredientDeletedRowCount: String(deletedDurIngredientRows),
      durIngredientActiveRowCount: String(activeDurIngredientRowCount),
      durIngredientDuplicateRuleCount: String(duplicateDurIngredientRuleCount),
      durIngredientMissingReasonCount: String(missingDurIngredientReasonRows),
      durIngredientCatalogComplete: "true",
      durIngredientAliasCount: String(durIngredientAliasTargets.size),
      durIngredientMultiMappedAliasCount: String(
        Array.from(durIngredientAliasTargets.values()).filter((targets) => targets.size > 1).length
      ),
      durIngredientDeclaredRelationAliasCount: String(declaredDurIngredientRelationKeys.size),
      durIngredientUnmappedRelationAliasCount: String(unmappedDurIngredientRelationKeys.size),
      durIngredientActiveUnmappedRelationAliasCount: String(activeUnmappedRelationAliases.size),
      durIngredientActiveUnmappedRelationProductCount: String(activeUnmappedRelationProducts.size),
      durIngredientActiveOfficialRelationCount: String(activeExpectedOfficialRelations.size),
      durIngredientActiveOfficialRelationMappedCount: String(activeMappedOfficialRelations.size),
      durIngredientConservativeFormMappingCount: String(conservativeDurFormMappingCount),
      durIngredientCuratedSpellingMappingCount: String(curatedDurSpellingMappingCount),
      durIngredientAmbiguousFormMappingCount: String(ambiguousDurFormMappingCount),
      durIngredientRiskyFallbackMappingCount: String(riskyFallbackDurMappingCount),
      durIngredientCatalogAbsentMappingCount: String(catalogAbsentDurMappingCount),
      durIngredientRelationFieldCount: String(durIngredientRelationValues.length),
      durIngredientUnparsedRelationFieldCount: String(unparsedDurIngredientRelations.length),
      durIngredientMixtureFieldCount: String(durIngredientMixtureValues.length),
      durIngredientUnparsedMixtureFieldCount: String(unparsedDurIngredientMixtures.length),
      durIngredientCatalogIdentityCount: String(durIngredientCatalogKeys.size),
      durIngredientCatalogMappedIdentityCount: String(mappedDurCatalogIdentityCount),
      durIngredientCatalogMappingRatio: durCatalogIdentityMappingRatio.toFixed(6),
      durIngredientActiveCatalogIdentityCount: String(activeExpectedDurCatalogKeys.size),
      durIngredientActiveCatalogMappedIdentityCount: String(
        activeMappedDurCatalogIdentityCount
      ),
      durIngredientActiveCatalogMappingRatio: activeDurCatalogMappingRatio.toFixed(6),
      durIngredientFindingCount: String(ingredientDurRules.size),
      durIngredientCatalogUnmappedIdentityCount: String(
        durIngredientCatalogKeys.size - mappedDurCatalogIdentityCount
      ),
      durIngredientProductCoverageCount: String(durIngredientCoveredProducts.length),
      durIngredientProductCoverageRatio: (durIngredientCoveredProducts.length / products.size).toFixed(6),
      liveSelfTestItemSeq: redSnapshot.itemSeq,
      liveSelfTestMixtureItemSeq: redFinding.targetItemSeq,
      liveSelfTestTotalCount: String(redSnapshot.contraindications.length),
      liveSelfTestReason: redFinding.reason
    },
    products: Array.from(products.values()).sort((left, right) =>
      (left.itemSeq ?? "").localeCompare(right.itemSeq ?? "")
    ),
    easyDrugInfo: Array.from(easyDrugInfo.values()).sort((left, right) =>
      left.itemSeq.localeCompare(right.itemSeq)
    ),
    durSnapshots: durSnapshots.sort((left, right) => left.itemSeq.localeCompare(right.itemSeq)),
    durIngredientContraindications: Array.from(ingredientDurRules.values()).sort(
      (left, right) =>
        left.sourceIngredientKey.localeCompare(right.sourceIngredientKey) ||
        left.targetIngredientKey.localeCompare(right.targetIngredientKey) ||
        left.reason.localeCompare(right.reason)
    )
  };

  mkdirSync(dirname(resolve(args.output)), { recursive: true });
  mkdirSync(dirname(resolve(args.aliases)), { recursive: true });
  const aliasFile: LiveAliasFile = {
    metadata: { generationId, fetchedAt },
    aliases
  };
  writeAtomicGroup([
    { path: resolve(args.output), content: `${JSON.stringify(seed, null, 2)}\n` },
    { path: resolve(args.aliases), content: `${JSON.stringify(aliasFile, null, 2)}\n` }
  ]);

  console.log(`live seed written: ${args.output}`);
  console.log(`live aliases written: ${args.aliases}`);
  console.log(
    `products=${seed.products.length} ingredientCoverage=${productsWithIngredients} easyDrug=${seed.easyDrugInfo.length} aliases=${aliases.length} durSnapshots=${durSnapshots.length} durIngredientRules=${ingredientDurRules.size}`
  );
  console.log(`liveSelfTestItemSeq=${seed.metadata.liveSelfTestItemSeq}`);
  console.log(`liveSelfTestMixtureItemSeq=${seed.metadata.liveSelfTestMixtureItemSeq}`);
}

function isInvalidIngredientKey(value: string): boolean {
  const normalized = normalizeIngredientName(value);
  return (
    !normalized ||
    !/[\p{L}]/u.test(value) ||
    /^(?:g|mg|ml|mcg|밀리그램|밀리그람|밀리리터|그램|단위|\d+(?:\.\d+)?(?:mg|ml|g)?)$/iu.test(
      normalized
    )
  );
}

function allDeclaredDurReferencesParsed(value: string): boolean {
  const declaredCount = Array.from(value.matchAll(/\[[A-Za-z]\d+]/g)).length;
  return declaredCount > 0 && parseDurIngredientReferences(value).length === declaredCount;
}

await main();

function writeAtomicGroup(files: Array<{ path: string; content: string }>): void {
  const prepared: Array<{ path: string; temporaryPath: string }> = [];
  try {
    for (const file of files) {
      const temporaryPath = `${file.path}.${process.pid}.${randomUUID()}.tmp`;
      const descriptor = openSync(temporaryPath, "wx");
      try {
        writeFileSync(descriptor, file.content);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      prepared.push({ path: file.path, temporaryPath });
    }
    for (const file of prepared) renameSync(file.temporaryPath, file.path);
  } catch (error) {
    for (const file of prepared) {
      try {
        unlinkSync(file.temporaryPath);
      } catch {
        // The file may already have been renamed.
      }
    }
    throw error;
  }
}
