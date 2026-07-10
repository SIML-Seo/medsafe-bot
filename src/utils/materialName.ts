import type { ProductIngredientInput } from "../types.js";
import { normalizeIngredientName } from "./text.js";

export interface IngredientCodeCandidate {
  ingredientCode: string;
  ingredientName: string;
}

export interface MfDSMaterialAnalysis {
  ingredients: ProductIngredientInput[];
  complete: boolean;
  recordCount: number;
  invalidRecordCount: number;
}

const NON_INGREDIENT_KEYS = new Set([
  "g",
  "mg",
  "ml",
  "밀리그램",
  "밀리그람",
  "밀리리터",
  "그램",
  "단위",
  "내수용",
  "수출용"
]);

const MATERIAL_UNITS = new Set([
  "%",
  "g",
  "iu",
  "i.u",
  "mcg",
  "mg",
  "ml",
  "μg",
  "그램",
  "나노그램",
  "단위",
  "리터",
  "마이크로그램",
  "마이크로리터",
  "밀리그램",
  "밀리그람",
  "밀리리터",
  "밀리몰",
  "아이.유",
  "아이유",
  "유닛",
  "킬로그램",
  "퍼센트"
]);

export function parseMfDSMaterialIngredients(
  materialName: string,
  codeCandidates: IngredientCodeCandidate[]
): ProductIngredientInput[] {
  return analyzeMfDSMaterialIngredients(materialName, codeCandidates).ingredients;
}

export function analyzeMfDSMaterialIngredients(
  materialName: string,
  codeCandidates: IngredientCodeCandidate[]
): MfDSMaterialAnalysis {
  const records: Array<{ ingredientName: string; ingredientKey: string }> = [];
  let invalidRecordCount = 0;
  for (const rawSegment of splitMaterialRecords(materialName)) {
    const segment = rawSegment.trim();
    if (!segment) continue;
    const ingredientName = materialIngredientName(segment);
    if (ingredientName === null) {
      if (records.length === 0 || segment.includes(",")) invalidRecordCount += 1;
      continue;
    }
    const cleanedName = ingredientName
      .replace(/\s*-\s*\[(?:내수용|수출용)[^\]]*\]\s*$/u, "")
      .trim();
    const ingredientKey = normalizeIngredientName(cleanedName);
    if (
      !cleanedName ||
      !ingredientKey ||
      NON_INGREDIENT_KEYS.has(ingredientKey) ||
      !/[\p{L}]/u.test(cleanedName)
    ) {
      invalidRecordCount += 1;
      continue;
    }
    records.push({ ingredientName: cleanedName, ingredientKey });
  }

  const parsed = new Map<string, ProductIngredientInput>();
  const uniqueRecordCount = new Set(records.map((record) => record.ingredientKey)).size;
  for (const { ingredientName, ingredientKey } of records) {
    if (parsed.has(ingredientKey)) continue;
    const exactCode = codeCandidates.find(
      (candidate) => normalizeIngredientName(candidate.ingredientName) === ingredientKey
    )?.ingredientCode;
    const singleCode =
      uniqueRecordCount === 1 && codeCandidates.length === 1
        ? codeCandidates[0]?.ingredientCode
        : undefined;
    parsed.set(ingredientKey, {
      ingredientName,
      ingredientKey,
      ingredientCode: exactCode || singleCode || ""
    });
  }

  return {
    ingredients: Array.from(parsed.values()),
    complete: records.length > 0 && invalidRecordCount === 0,
    recordCount: records.length,
    invalidRecordCount
  };
}

function splitMaterialRecords(materialName: string): string[] {
  const records: string[] = [];
  for (const rawPart of materialName.split("/")) {
    const part = rawPart.trim();
    if (!part) continue;
    if (
      records.length > 0 &&
      hasUnitRatioNumerator(records[records.length - 1] ?? "") &&
      isUnitRatioContinuation(part)
    ) {
      records[records.length - 1] = `${records[records.length - 1]}/${part}`;
      continue;
    }
    records.push(part);
  }
  return records;
}

function hasUnitRatioNumerator(segment: string): boolean {
  const normalized = segment.normalize("NFKC").trim().toLowerCase();
  return /\d+(?:\.\d+)?\s*(?:g|mg|ml|mcg|μg|iu|i\.u|그램|나노그램|단위|리터|마이크로그램|마이크로리터|밀리그램|밀리그람|밀리리터|아이유|유닛)$/u.test(
    normalized
  );
}

function isUnitRatioContinuation(segment: string): boolean {
  const firstField = segment.split(",", 1)[0]?.normalize("NFKC").trim().toLowerCase() ?? "";
  return /^(?:\d+(?:\.\d+)?\s*)?(?:g|mg|ml|mcg|μg|iu|i\.u|그램|나노그램|단위|리터|마이크로그램|마이크로리터|밀리그램|밀리그람|밀리리터|아이유|유닛)$/u.test(
    firstField
  );
}

function materialIngredientName(segment: string): string | null {
  const fields = segment.split(",").map((field) => field.trim());
  const unitIndex = fields.findIndex((field, index) => index >= 2 && isMaterialUnit(field));
  if (unitIndex < 2) return null;
  const metadataIndex = fields.findIndex(
    (field, index) => index > 0 && index < unitIndex && isMetadataField(field)
  );
  if (metadataIndex < 1) return null;
  return fields.slice(0, metadataIndex).join(",").trim() || null;
}

function isMaterialUnit(value: string): boolean {
  return MATERIAL_UNITS.has(value.normalize("NFKC").toLowerCase().replace(/\s+/g, ""));
}

function isMetadataField(value: string): boolean {
  const normalized = value.normalize("NFKC").trim();
  return (
    normalized === "" ||
    /^[+-]?\d+(?:\.\d+)?$/.test(normalized) ||
    /^-\s*/.test(normalized) ||
    /^\[(?:제\d+법|내수용|수출용)/.test(normalized)
  );
}
