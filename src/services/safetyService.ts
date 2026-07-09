import { OFFICIAL_SOURCE_URLS } from "../config/schemaMap.js";
import { MasterRepository } from "../repositories/masterRepository.js";
import type {
  MasterProduct,
  MedicationForCheck,
  SafetyContext,
  SafetyFinding,
  SafetyResult
} from "../types.js";
import type { DurClient } from "./durClient.js";
import {
  emergencyResult,
  hasEmergencySignal,
  STANDARD_DISCLAIMER,
  verdictFrom
} from "./safetyPolicy.js";

interface ValidMedication {
  product: MasterProduct | null;
  itemSeq: string | null;
  ingredientCode: string | null;
  displayName: string;
  inputCount: number;
  durQueryable: boolean;
}

const MVP_UNIMPLEMENTED_DUR_TYPES = [
  "AGE_TABOO",
  "PREG_TABOO",
  "CAPACITY",
  "PERIOD",
  "ELDERLY_CAUTION",
  "EFCY_DUP",
  "SR_SPLIT"
] as const;

export class SafetyService {
  constructor(
    private readonly repository: MasterRepository,
    private readonly durClient: DurClient,
    private readonly baseDate: string
  ) {}

  async check(medications: MedicationForCheck[], context: SafetyContext = {}): Promise<SafetyResult> {
    const emergencyText = [
      context.notes ?? "",
      ...medications.map((medication) => medication.displayName ?? "")
    ].join(" ");
    if (hasEmergencySignal(emergencyText)) {
      return emergencyResult(this.baseDate);
    }

    const unresolved: string[] = [];
    const valid: ValidMedication[] = [];

    for (const medication of medications) {
      if (medication.status !== "CONFIRMED") {
        unresolved.push(medication.displayName ?? medication.itemSeq ?? "미확정 약");
        continue;
      }

      const itemSeq = medication.itemSeq ?? null;
      const product = itemSeq ? this.repository.getProduct(itemSeq) : null;
      if (itemSeq && !product) {
        unresolved.push(medication.displayName ?? itemSeq);
        continue;
      }

      const callerIngredientCode = nonEmptyOrNull(medication.ingrCode);
      const productIngredientCode = nonEmptyOrNull(product?.ingredientCode);
      if (product && callerIngredientCode && productIngredientCode && callerIngredientCode !== productIngredientCode) {
        unresolved.push(`${product.name}: 입력 성분코드 불일치`);
      }

      const ingredientCode = productIngredientCode ?? callerIngredientCode;
      if (!product && !ingredientCode) {
        unresolved.push(medication.displayName ?? "성분/품목 미확정");
        continue;
      }
      if (!product && ingredientCode && this.repository.getProductsByIngredient(ingredientCode).length === 0) {
        unresolved.push(medication.displayName ?? ingredientCode);
        continue;
      }

      valid.push({
        product,
        itemSeq: product?.itemSeq ?? null,
        ingredientCode,
        displayName:
          product?.name ??
          this.repository.getProductsByIngredient(ingredientCode ?? "")[0]?.ingredientName ??
          ingredientCode ??
          "확인된 성분",
        inputCount: 1,
        durQueryable: product ? canQueryDur(product) : false
      });
    }

    const deduplicated = this.deduplicateValidMedications(valid);
    const findings: SafetyFinding[] = [];
    findings.push(...this.localDuplicateInputFindings(deduplicated));
    findings.push(...this.localDuplicateIngredientFindings(deduplicated));
    findings.push(...this.contextUnknownFindings(context));

    const checkedTypes: string[] = ["DUP_INPUT"];
    const failedTypes: string[] = deduplicated.length > 0 ? [...MVP_UNIMPLEMENTED_DUR_TYPES] : [];
    if (deduplicated.length > 1) {
      const missingIngredient = deduplicated.filter((medication) => !medication.ingredientCode);
      if (missingIngredient.length > 0) {
        failedTypes.push("DUP_INGREDIENT");
        unresolved.push(
          ...missingIngredient.map(
            (medication) => `${medication.displayName}: 성분코드 미확인으로 중복성분 판정 보류`
          )
        );
      } else {
        checkedTypes.push("DUP_INGREDIENT");
      }
    } else {
      checkedTypes.push("DUP_INGREDIENT");
    }
    const itemSeqSet = new Set(deduplicated.map((medication) => medication.itemSeq).filter(Boolean));
    const ingredientSet = new Set(
      deduplicated.map((medication) => medication.ingredientCode).filter(Boolean)
    );
    const durCoveredItemSeqs = new Set<string>();
    const durFindingKeys = new Set<string>();

    for (const medication of deduplicated.filter((item) => item.itemSeq)) {
      if (!medication.durQueryable) {
        failedTypes.push("USJNT_TABOO");
        unresolved.push(`${medication.displayName}: DUR 품목기준코드 미확인으로 병용금기 조회 보류`);
        continue;
      }
      if (durCoveredItemSeqs.has(medication.itemSeq!)) continue;
      const result = await this.durClient.checkUsjntTaboo(medication.itemSeq!);
      if (!result.ok) {
        failedTypes.push(result.failedType ?? "USJNT_TABOO");
        continue;
      }

      checkedTypes.push("USJNT_TABOO");
      for (const taboo of result.contraindications) {
        const targetMatched =
          (taboo.targetItemSeq && itemSeqSet.has(taboo.targetItemSeq)) ||
          (taboo.targetIngredientCode && ingredientSet.has(taboo.targetIngredientCode));
        if (!targetMatched) continue;
        const target = this.findValidMedication(deduplicated, taboo.targetItemSeq, taboo.targetIngredientCode);
        const findingKey = [
          medication.displayName,
          target?.displayName ?? taboo.targetItemSeq ?? taboo.targetIngredientCode ?? "상대 약",
          taboo.reason.replace(/\s+/g, " ").trim()
        ].join("|");
        if (durFindingKeys.has(findingKey)) continue;
        durFindingKeys.add(findingKey);
        findings.push({
          type: "USJNT_TABOO",
          origin: "DUR_API",
          level: "RED",
          a: medication.displayName,
          b: target?.displayName ?? taboo.targetItemSeq ?? taboo.targetIngredientCode ?? "상대 약",
          reason: taboo.reason,
          source: taboo.source,
          baseDate: taboo.baseDate
        });
        if (deduplicated.length === 2 && taboo.targetItemSeq) {
          durCoveredItemSeqs.add(taboo.targetItemSeq);
        }
      }
    }

    if (deduplicated.some((item) => !item.itemSeq)) {
      failedTypes.push("USJNT_TABOO");
    }

    if (deduplicated.length === 0 && unresolved.length === 0) {
      unresolved.push("확정된 약 없음");
    }

    const partial = {
      findings,
      unresolved,
      checkedTypes: Array.from(new Set(checkedTypes)),
      failedTypes: Array.from(new Set(failedTypes))
    };
    return {
      verdict: verdictFrom(partial),
      ...partial,
      disclaimer: STANDARD_DISCLAIMER
    };
  }

  private deduplicateValidMedications(valid: ValidMedication[]): ValidMedication[] {
    const byCanonical = new Map<string, ValidMedication>();
    for (const medication of valid) {
      const key = medication.itemSeq
        ? `item:${medication.itemSeq}`
        : `ingredient:${medication.ingredientCode ?? medication.displayName}`;
      const existing = byCanonical.get(key);
      if (!existing) {
        byCanonical.set(key, { ...medication });
        continue;
      }
      existing.inputCount += 1;
    }
    return Array.from(byCanonical.values());
  }

  private localDuplicateInputFindings(valid: ValidMedication[]): SafetyFinding[] {
    return valid
      .filter((medication) => medication.inputCount > 1)
      .map((medication) => ({
        type: "DUP_INPUT" as const,
        origin: "LOCAL_POLICY" as const,
        level: "YELLOW" as const,
        a: medication.displayName,
        b: null,
        reason: `같은 약이 ${medication.inputCount}회 입력되었습니다. 실제 중복 복용인지, 단순 반복 입력인지 확인이 필요합니다.`,
        source: "서버 안전정책",
        baseDate: this.baseDate
      }));
  }

  private localDuplicateIngredientFindings(valid: ValidMedication[]): SafetyFinding[] {
    const byIngredient = new Map<string, ValidMedication[]>();
    for (const medication of valid) {
      if (!medication.ingredientCode) continue;
      const list = byIngredient.get(medication.ingredientCode) ?? [];
      list.push(medication);
      byIngredient.set(medication.ingredientCode, list);
    }

    const findings: SafetyFinding[] = [];
    for (const [ingredientCode, list] of byIngredient) {
      const uniqueNames = Array.from(new Set(list.map((item) => item.displayName)));
      if (uniqueNames.length < 2) continue;
      const ingredientName =
        list.find((item) => item.product?.ingredientName)?.product?.ingredientName ?? ingredientCode;
      findings.push({
        type: "DUP_INGREDIENT",
        origin: "LOCAL_INGREDIENT",
        level: "YELLOW",
        a: uniqueNames[0]!,
        b: uniqueNames.slice(1).join(", "),
        reason: `${ingredientName} 성분이 겹칩니다. 공개 데이터 기반 정보 조회 결과이며 임의 중단 또는 용량 변경 지시가 아닙니다.`,
        source: "로컬 주성분코드",
        baseDate: this.baseDate
      });
    }
    return findings;
  }

  private contextUnknownFindings(context: SafetyContext): SafetyFinding[] {
    const findings: SafetyFinding[] = [];
    if (!context.ageGroup || context.ageGroup === "unknown") {
      findings.push({
        type: "CONTEXT_UNKNOWN",
        origin: "LOCAL_POLICY",
        level: "YELLOW",
        a: "연령 정보 없음",
        b: null,
        reason: "연령대 금기/노인주의 판정은 복용자 연령 정보가 없어 보류되었습니다.",
        source: "서버 안전정책",
        baseDate: this.baseDate
      });
    }
    if (!context.pregnancy || context.pregnancy === "unknown") {
      findings.push({
        type: "CONTEXT_UNKNOWN",
        origin: "LOCAL_POLICY",
        level: "YELLOW",
        a: "임부 여부 정보 없음",
        b: null,
        reason: "임부금기 판정은 임신 여부 정보가 없어 보류되었습니다.",
        source: "서버 안전정책",
        baseDate: this.baseDate
      });
    }
    if (context.pregnancy === "yes") {
      findings.push({
        type: "PREG_TABOO",
        origin: "LOCAL_POLICY",
        level: "YELLOW",
        a: "임신 컨텍스트",
        b: null,
        reason: "임부 관련 DUR 세부 조회는 MVP에서 best-effort이며, 임신 중 복약은 반드시 전문가 확인이 필요합니다.",
        source: OFFICIAL_SOURCE_URLS.durProductInfo,
        baseDate: this.baseDate
      });
    }
    return findings;
  }

  private findValidMedication(
    valid: ValidMedication[],
    itemSeq?: string | null,
    ingredientCode?: string | null
  ): ValidMedication | null {
    return (
      valid.find((medication) => itemSeq && medication.itemSeq === itemSeq) ??
      valid.find((medication) => ingredientCode && medication.ingredientCode === ingredientCode) ??
      null
    );
  }
}

function canQueryDur(product: MasterProduct): boolean {
  return (
    product.source === "MFDS_EASY_DRUG_API" ||
    product.source === "MFDS_DUR_USJNT_TABOO_API" ||
    product.source === "DEMO_FIXTURE"
  );
}

function nonEmptyOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
