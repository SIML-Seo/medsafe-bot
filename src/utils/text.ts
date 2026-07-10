const DOSAGE_PATTERN =
  /(\d+(?:\.\d+)?)\s*(밀리그램|밀리그람|마이크로그램|밀리리터|mg|mcg|μg|g|그램|ml|%)/giu;

const CANONICAL_DOSAGE_PATTERN = /\d+(?:\.\d+)?(?:mg|ml|%)/g;

const FORM_WORDS = [
  "서방정",
  "장용정",
  "연질캡슐",
  "캡슐제",
  "현탁액",
  "건조시럽",
  "주사액",
  "주사제",
  "캡슐",
  "정제",
  "시럽",
  "이알",
  "크림",
  "연고",
  "산제",
  "산",
  "액",
  "정"
] as const;

export function normalizeMedicationText(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(DOSAGE_PATTERN, (_match, amount: string, unit: string) =>
      canonicalDosage(Number(amount), unit)
    )
    .replace(/[()[\]{}]/g, " ")
    .replace(/[^\p{L}\p{N}.%]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function compactText(input: string): string {
  return normalizeMedicationText(input).replace(/\s+/g, "");
}

export function normalizeIngredientName(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s*-\s*\[(?:내수용|수출용)\]\s*$/gu, "")
    .replace(/[()[\]{}]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

const INGREDIENT_FORMULATION_SUFFIXES = [
  "제피세립",
  "장용펠렛",
  "장용과립",
  "서방과립",
  "미분화"
] as const;

const INGREDIENT_HYDRATE_SUFFIX = /(?:일|이|삼|사|오|육|칠|팔|구|십|\d+)?수화물$/u;
const INGREDIENT_ACID_SALT_SUFFIXES = [
  "브롬화수소산염",
  "클로르수소산염",
  "타르타르산염",
  "시트르산염",
  "아세트산염",
  "말레산염",
  "푸마르산염",
  "숙신산염",
  "메실산염",
  "베실산염",
  "토실산염",
  "옥살산염",
  "락트산염",
  "파모산염",
  "염산염",
  "황산염",
  "인산염",
  "질산염"
] as const;

export function canonicalIngredientIdentity(input: string): string {
  let normalized = normalizeIngredientName(input);
  normalized = normalized.replace(/^와르파린(?=나트륨|$)/u, "와파린");
  const suffix = INGREDIENT_FORMULATION_SUFFIXES.find((candidate) =>
    normalized.endsWith(candidate)
  );
  if (suffix) normalized = normalized.slice(0, -suffix.length) || normalized;
  normalized = normalized.replace(INGREDIENT_HYDRATE_SUFFIX, "") || normalized;
  const saltSuffix = INGREDIENT_ACID_SALT_SUFFIXES.find(
    (candidate) => normalized.endsWith(candidate) && normalized.length > candidate.length + 1
  );
  if (saltSuffix) normalized = normalized.slice(0, -saltSuffix.length) || normalized;
  return normalized;
}

export function canonicalProductCode(input: string): string {
  const normalized = input.normalize("NFKC").trim();
  if (!/^\d+$/.test(normalized)) return normalized;
  return normalized.replace(/^0+(?=\d)/, "");
}

export function medicationSearchStem(input: string): string {
  return normalizeMedicationText(input).replace(CANONICAL_DOSAGE_PATTERN, "").replace(/\s+/g, "");
}

export function extractDosageTokens(input: string): string[] {
  return Array.from(new Set(normalizeMedicationText(input).match(CANONICAL_DOSAGE_PATTERN) ?? []));
}

export function extractFormTokens(input: string): string[] {
  const compact = compactText(input);
  return FORM_WORDS.filter((word) => compact.includes(word));
}

export function tokenize(input: string): string[] {
  const normalized = normalizeMedicationText(input);
  if (!normalized) return [];
  return normalized.split(" ").filter(Boolean);
}

export function tokenSetRatio(a: string, b: string): number {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (left.size === 0 || right.size === 0) return 0;

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return (2 * intersection) / (left.size + right.size);
}

export function containsAny(input: string, words: string[]): boolean {
  const normalized = input.normalize("NFKC").toLowerCase();
  return words.some((word) => normalized.includes(word.toLowerCase()));
}

function canonicalDosage(amount: number, rawUnit: string): string {
  const unit = rawUnit.toLowerCase();
  if (unit === "g" || unit === "그램") return `${formatNumber(amount * 1000)}mg`;
  if (unit === "mcg" || unit === "μg" || unit === "마이크로그램") {
    return `${formatNumber(amount / 1000)}mg`;
  }
  if (unit === "ml" || unit === "밀리리터") return `${formatNumber(amount)}ml`;
  if (unit === "%") return `${formatNumber(amount)}%`;
  return `${formatNumber(amount)}mg`;
}

function formatNumber(value: number): string {
  return Number(value.toFixed(6)).toString();
}
