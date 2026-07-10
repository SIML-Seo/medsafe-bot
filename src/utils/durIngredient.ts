import type { DurIngredientContraindication } from "../types.js";
import { normalizedHangulDistanceScore } from "./hangul.js";
import { canonicalIngredientIdentity } from "./text.js";

export interface DurIngredientReference {
  code: string;
  name: string;
  key: string;
}

export interface DurIngredientAliasMapping {
  aliasKey: string;
  catalogKey: string;
}

export interface DurIngredientMaterialResolution {
  keys: string[];
  basis:
    | "OFFICIAL_RELATION"
    | "CONSERVATIVE_FORM"
    | "CURATED_SPELLING"
    | "FALLBACK"
    | "AMBIGUOUS_FORM";
}

export type DurDeletionState = "ACTIVE" | "DELETED" | "UNKNOWN";

const DUR_FORM_SUFFIXES = [
  "세스키히드레이트",
  "헤미히드레이트",
  "히드레이트",
  "고체분산체",
  "무정형",
  "층"
] as const;

const DUR_SALT_SUFFIXES = [
  "브롬화수소산염",
  "헤미에탄올레이트",
  "아스파르트산염",
  "푸마르산염",
  "숙신산염",
  "메실산염",
  "베실산염",
  "토실산염",
  "구연산염",
  "아세트산염",
  "에탄올레이트",
  "지나포산염",
  "니코틴산염",
  "캄실산염",
  "포스페이트",
  "염산염",
  "황산염",
  "말레이트",
  "말산염",
  "인산염",
  "나트륨",
  "칼륨",
  "칼슘"
] as const;

const DUR_SALT_PREFIXES = [
  "브롬화수소산",
  "클로르수소산",
  "황산수소",
  "말레인산",
  "구연산",
  "메실산",
  "베실산",
  "토실산",
  "염산",
  "황산",
  "인산",
  "초산"
] as const;

const MIN_DUR_BASE_IDENTITY_LENGTH = 5;
const SHORT_DUR_BASE_IDENTITIES = new Set(["살메테롤", "투카티닙", "에탐부톨"]);
const POTENTIAL_SPELLING_VARIANT_SCORE = 0.81;

export const CURATED_DUR_SPELLING_EQUIVALENTS = [
  { aliasKey: "니메수리드", catalogKey: "니메술리드" },
  { aliasKey: "이소니아짓", catalogKey: "이소니아지드" },
  { aliasKey: "클리피도그렐", catalogKey: "클로피도그렐" },
  { aliasKey: "아미노카프로산", catalogKey: "아미노카프론산" },
  { aliasKey: "에데트산칼슘디나트륨", catalogKey: "에데트산칼슘나트륨" },
  { aliasKey: "트라넥사민산", catalogKey: "트라넥삼산" },
  { aliasKey: "자일로메타졸린", catalogKey: "키실로메타졸린" }
] as const;

const CURATED_DUR_SPELLING_TARGETS = new Map(
  CURATED_DUR_SPELLING_EQUIVALENTS.map(({ aliasKey, catalogKey }) => [
    canonicalIngredientIdentity(aliasKey),
    canonicalIngredientIdentity(catalogKey)
  ])
);

export function durIngredientContraindicationFromRow(
  row: Record<string, unknown>,
  fetchedAt: string,
  source: string
): DurIngredientContraindication | null {
  const deletionState = durDeletionState(row);
  if (deletionState !== "ACTIVE") return null;
  const sourceIngredientCode = text(row.INGR_CODE ?? row.ingrCode) || null;
  const sourceIngredientName = text(row.INGR_KOR_NAME ?? row.ingrKorName);
  const targetIngredientCode =
    text(row.MIXTURE_INGR_CODE ?? row.mixtureIngrCode) || null;
  const targetIngredientName = text(
    row.MIXTURE_INGR_KOR_NAME ?? row.mixtureIngrKorName
  );
  const declaredReason = text(
    row.PROHBT_CONTENT ?? row.prohbtContent ?? row.REMARK ?? row.remark
  );
  const typeName = text(row.TYPE_NAME ?? row.typeName);
  if (typeName !== "병용금기") return null;
  const reason =
    declaredReason ||
    (typeName === "병용금기"
      ? "식약처 DUR 성분정보에 병용금기로 등록됨(상세 금기내용 미제공)"
      : "");
  const sourceIngredientKey = canonicalIngredientIdentity(sourceIngredientName);
  const targetIngredientKey = canonicalIngredientIdentity(targetIngredientName);
  if (
    !sourceIngredientName ||
    !sourceIngredientKey ||
    !targetIngredientName ||
    !targetIngredientKey ||
    !reason
  ) {
    return null;
  }

  const rawSourceDate = text(
    row.NOTIFICATION_DATE ?? row.notificationDate ?? row.BASE_DATE ?? row.baseDate
  );
  const sourceDate = normalizedDurDate(rawSourceDate);
  if (rawSourceDate && !sourceDate) return null;
  return {
    sourceIngredientCode,
    sourceIngredientName,
    sourceIngredientKey,
    targetIngredientCode,
    targetIngredientName,
    targetIngredientKey,
    sourceMixType: text(row.MIX_TYPE ?? row.mixType),
    sourceMixture: text(row.MIX ?? row.mix),
    sourceRelation: text(row.ORI ?? row.ori),
    targetMixType: text(row.MIXTURE_MIX_TYPE ?? row.mixtureMixType),
    targetMixture: text(row.MIXTURE_MIX ?? row.mixtureMix),
    targetRelation: text(row.MIXTURE_ORI ?? row.mixtureOri),
    reason,
    baseDate: sourceDate ?? fetchedAt.slice(0, 10),
    dateBasis: sourceDate ? "SOURCE_DATE" : "SNAPSHOT_FETCHED_AT",
    source
  };
}

export function isDeletedDurRow(row: Record<string, unknown>): boolean {
  return durDeletionState(row) === "DELETED";
}

export function durDeletionState(row: Record<string, unknown>): DurDeletionState {
  const value = text(
    row.DEL_YN ?? row.delYn ?? row.DELETE_YN ?? row.deleteYn
  ).toUpperCase();
  if (["N", "NO", "FALSE", "0", "정상"].includes(value)) return "ACTIVE";
  if (["Y", "YES", "TRUE", "1", "삭제"].includes(value)) return "DELETED";
  return "UNKNOWN";
}

export function normalizedDurDate(value: string): string | null {
  let candidate: string;
  if (/^\d{8}$/.test(value)) {
    candidate = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  } else {
    const matched = value.match(/^\d{4}-\d{2}-\d{2}/);
    if (!matched) return null;
    candidate = matched[0];
  }
  const [year, month, day] = candidate.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month! - 1 &&
    date.getUTCDate() === day
    ? candidate
    : null;
}

export function parseDurIngredientReferences(value: string): DurIngredientReference[] {
  const matches = Array.from(value.matchAll(/\[([A-Za-z]\d+)]\s*/g));
  if (matches.length === 0) return [];
  const references: DurIngredientReference[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? value.length;
    const rawName = value
      .slice(start, end)
      .replace(/^\s*(?:\/|\+|,|·|;)+\s*/u, "")
      .replace(/\s*(?:\/|\+|,|·|;)+\s*$/u, "")
      .trim();
    const name = preferredReferenceName(rawName);
    const key = canonicalIngredientIdentity(name);
    if (!name || !key) continue;
    references.push({ code: match[1]!.toUpperCase(), name, key });
  }
  return references;
}

export function durIngredientAliasMappingsForSide(
  primaryIngredientKey: string,
  mixture: string | null | undefined,
  relation: string | null | undefined
): DurIngredientAliasMapping[] {
  const primaryKey = canonicalIngredientIdentity(primaryIngredientKey);
  if (!primaryKey) return [];
  const mixtureReferences = parseDurIngredientReferences(mixture ?? "");
  const candidates = Array.from(
    new Set([primaryKey, ...mixtureReferences.map((reference) => reference.key)].filter(Boolean))
  );
  const mappings = new Map<string, string>([[primaryKey, primaryKey]]);
  for (const reference of mixtureReferences) mappings.set(reference.key, reference.key);

  const relationReferences = parseDurIngredientReferences(relation ?? "");
  if (mixtureReferences.length === 0) {
    for (const reference of relationReferences) mappings.set(reference.key, primaryKey);
  } else {
    for (const reference of relationReferences) {
      const matched = uniquelyMatchingCatalogKey(reference.key, candidates);
      if (matched) mappings.set(reference.key, matched);
    }
  }
  return Array.from(mappings, ([aliasKey, catalogKey]) => ({ aliasKey, catalogKey }));
}

export function resolveDurIngredientMaterialKeys(
  materialName: string,
  aliasTargets: ReadonlyMap<string, ReadonlySet<string>>,
  catalogKeys: ReadonlySet<string>
): DurIngredientMaterialResolution {
  const materialKey = durMaterialIdentity(materialName);
  const exactTargets = aliasTargets.get(materialKey);
  if (exactTargets && exactTargets.size > 0) {
    return { keys: Array.from(exactTargets).sort(), basis: "OFFICIAL_RELATION" };
  }

  const curatedTarget = CURATED_DUR_SPELLING_TARGETS.get(materialKey);
  if (curatedTarget && catalogKeys.has(curatedTarget)) {
    return { keys: [curatedTarget], basis: "CURATED_SPELLING" };
  }

  const matchedTargetSets = new Map<string, Set<string>>();
  for (const candidate of conservativeDurFormCandidates(materialKey)) {
    const targets = new Set(aliasTargets.get(candidate) ?? []);
    if (catalogKeys.has(candidate)) targets.add(candidate);
    if (targets.size === 0) continue;
    matchedTargetSets.set(Array.from(targets).sort().join("\u001f"), targets);
  }
  if (matchedTargetSets.size === 1) {
    return {
      keys: Array.from(matchedTargetSets.values().next().value ?? []).sort(),
      basis: "CONSERVATIVE_FORM"
    };
  }
  if (matchedTargetSets.size > 1) {
    return { keys: [materialKey], basis: "AMBIGUOUS_FORM" };
  }
  return { keys: [materialKey], basis: "FALLBACK" };
}

export function hasPotentialDurIdentityVariant(
  materialName: string,
  knownIdentityKeys: ReadonlySet<string>
): boolean {
  const materialKey = durMaterialIdentity(materialName);
  if (!materialKey) return false;
  for (const knownKey of knownIdentityKeys) {
    if (knownKey.length < 4) continue;
    if (materialKey.includes(knownKey) || knownKey.includes(materialKey)) return true;
    if (
      Math.abs(materialKey.length - knownKey.length) <= 2 &&
      normalizedHangulDistanceScore(materialKey, knownKey) >= POTENTIAL_SPELLING_VARIANT_SCORE
    ) {
      return true;
    }
  }
  return false;
}

function conservativeDurFormCandidates(materialKey: string): string[] {
  const reordered = carrierReorderedCandidates(materialKey);
  const candidates = new Set(reordered);
  const queue = [materialKey, ...reordered];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of strippedDurForms(current)) {
      if (
        !eligibleDurBaseIdentity(next) ||
        next === materialKey ||
        candidates.has(next)
      ) {
        continue;
      }
      candidates.add(next);
      queue.push(next);
    }
  }
  return Array.from(candidates);
}

function durMaterialIdentity(value: string): string {
  return canonicalIngredientIdentity(
    value
      .normalize("NFKC")
      .replace(/\((?:R|S|RS|SR|R\/S|S\/R)\)\s*[-·]?/giu, "")
  );
}

function carrierReorderedCandidates(value: string): string[] {
  const candidates: string[] = [];
  const silicaAdsorbate = value.match(/^이산화규소흡착(.+)$/u)?.[1];
  if (silicaAdsorbate) candidates.push(`${silicaAdsorbate}이산화규소`, silicaAdsorbate);
  if (value.endsWith("프로피오네이드")) {
    candidates.push(`${value.slice(0, -"프로피오네이드".length)}프로피오네이트`);
  }
  return candidates;
}

function eligibleDurBaseIdentity(value: string): boolean {
  return value.length >= MIN_DUR_BASE_IDENTITY_LENGTH || SHORT_DUR_BASE_IDENTITIES.has(value);
}

function strippedDurForms(value: string): string[] {
  const values: string[] = [];
  for (const suffix of [...DUR_FORM_SUFFIXES, ...DUR_SALT_SUFFIXES]) {
    if (value.endsWith(suffix)) values.push(value.slice(0, -suffix.length));
  }
  for (const prefix of DUR_SALT_PREFIXES) {
    if (value.startsWith(prefix)) values.push(value.slice(prefix.length));
  }
  return values.filter(Boolean);
}

function preferredReferenceName(rawName: string): string {
  const leadingName = rawName.split("(", 1)[0]?.trim() ?? "";
  if (/\p{Script=Hangul}/u.test(leadingName)) return rawName;
  if (!/[A-Za-z]/.test(leadingName)) return rawName;
  const koreanParenthetical = Array.from(rawName.matchAll(/\(([^()]*)\)/g))
    .map((match) => match[1]?.trim() ?? "")
    .find((candidate) => /\p{Script=Hangul}/u.test(candidate));
  return koreanParenthetical || rawName;
}

function uniquelyMatchingCatalogKey(aliasKey: string, candidates: string[]): string | null {
  const scored = candidates
    .map((candidate) => ({ candidate, score: ingredientIdentityScore(aliasKey, candidate) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || right.candidate.length - left.candidate.length);
  if (scored.length === 0) return null;
  if (scored[1]?.score === scored[0]!.score) return null;
  return scored[0]!.candidate;
}

function ingredientIdentityScore(aliasKey: string, catalogKey: string): number {
  if (aliasKey === catalogKey) return 10_000 + catalogKey.length;
  if (catalogKey.length >= 3 && aliasKey.includes(catalogKey)) return 1_000 + catalogKey.length;
  if (aliasKey.length >= 3 && catalogKey.includes(aliasKey)) return 500 + aliasKey.length;
  const variants = [aliasKey, ...conservativeDurFormCandidates(aliasKey)];
  const distanceScore = Math.max(
    ...variants.map((variant) => normalizedHangulDistanceScore(variant, catalogKey))
  );
  if (distanceScore >= 0.84) return 100 + distanceScore;
  return 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}
