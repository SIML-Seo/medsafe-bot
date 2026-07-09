const DOSAGE_PATTERN =
  /(\d+(\.\d+)?\s?(mg|밀리그람|g|그램|mcg|μg|마이크로그램|ml|밀리리터|%))/gi;

const FORM_WORDS = [
  "정",
  "정제",
  "캡슐",
  "캡슐제",
  "서방정",
  "이알",
  "현탁액",
  "시럽",
  "액",
  "연질캡슐",
  "장용정"
];

export function normalizeMedicationText(input: string): string {
  let normalized = input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[()[\]{}]/g, " ")
    .replace(DOSAGE_PATTERN, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ");

  for (const formWord of [...FORM_WORDS].sort((a, b) => b.length - a.length)) {
    normalized = normalized.replace(new RegExp(`${formWord}(?=\\s|$)`, "gi"), " ");
  }

  return normalized.trim().replace(/\s+/g, " ");
}

export function compactText(input: string): string {
  return normalizeMedicationText(input).replace(/\s+/g, "");
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
