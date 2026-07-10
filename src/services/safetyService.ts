import { MasterRepository } from "../repositories/masterRepository.js";
import type {
  DurContraindication,
  MasterProduct,
  MedicationForCheck,
  ProductIngredient,
  SafetyContext,
  SafetyFinding,
  SafetyResult
} from "../types.js";
import { canonicalIngredientIdentity } from "../utils/text.js";
import { parseDurIngredientReferences } from "../utils/durIngredient.js";
import type { DurClient } from "./durClient.js";
import {
  emergencyResult,
  hasEmergencySignal,
  hasPotentialOverdoseSignal,
  potentialOverdoseResult,
  STANDARD_DISCLAIMER,
  verdictFrom
} from "./safetyPolicy.js";

interface ValidMedication {
  product: MasterProduct | null;
  itemSeq: string | null;
  ingredientCode: string | null;
  ingredients: ProductIngredient[];
  displayName: string;
  inputCount: number;
  durQueryable: boolean;
}

const CURATED_DUPLICATE_INGREDIENT_EQUIVALENTS = new Map<string, string[]>([
  [canonicalIngredientIdentity("벤조산나트륨카페인"), [canonicalIngredientIdentity("카페인")]],
  [canonicalIngredientIdentity("초산 L-리신"), [canonicalIngredientIdentity("L-리신")]]
]);

export class SafetyService {
  constructor(
    private readonly repository: MasterRepository,
    private readonly durClient: DurClient,
    private readonly baseDate: string
  ) {}

  async check(medications: MedicationForCheck[], context: SafetyContext = {}): Promise<SafetyResult> {
    const emergencyText = context.notes ?? "";
    const medicationNames = medications.flatMap((medication) => {
      const productName = medication.itemSeq
        ? this.repository.getProduct(medication.itemSeq)?.name
        : null;
      return [medication.displayName, productName].filter(
        (name): name is string => Boolean(name)
      );
    });
    if (hasEmergencySignal(emergencyText, medicationNames)) {
      return emergencyResult(this.baseDate);
    }
    if (hasPotentialOverdoseSignal(emergencyText, medicationNames)) {
      return potentialOverdoseResult(this.baseDate);
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
      const productIngredients = product ? this.repository.getProductIngredients(product.itemSeq) : [];
      const knownIngredientCodes = new Set(
        [productIngredientCode, ...productIngredients.map((ingredient) => nonEmptyOrNull(ingredient.ingredientCode))]
          .filter((code): code is string => Boolean(code))
      );
      if (product && callerIngredientCode && knownIngredientCodes.size > 0 && !knownIngredientCodes.has(callerIngredientCode)) {
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

      const ingredients = product
        ? productIngredients
        : ingredientCode
          ? ingredientRowsForCode(this.repository, ingredientCode)
          : [];

      valid.push({
        product,
        itemSeq: product?.itemSeq ?? null,
        ingredientCode,
        ingredients,
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
    const failedTypes: string[] = [];
    if (deduplicated.length > 1) {
      const incompleteIngredient = deduplicated.filter(
        (medication) =>
          medication.ingredients.length === 0 ||
          (medication.product !== null && !medication.product.ingredientsComplete)
      );
      if (incompleteIngredient.length > 0) {
        failedTypes.push("DUP_INGREDIENT");
        unresolved.push(
          ...incompleteIngredient.map(
            (medication) => `${medication.displayName}: 성분정보 미확인 또는 불완전으로 중복성분 판정 보류`
          )
        );
      } else {
        checkedTypes.push("DUP_INGREDIENT");
      }
    } else {
      checkedTypes.push("DUP_INGREDIENT");
    }
    const itemSeqSet = new Set(deduplicated.map((medication) => medication.itemSeq).filter(Boolean));
    const ingredientKeySet = new Set(
      deduplicated.flatMap((medication) =>
        medication.ingredients
          .flatMap((ingredient) => ingredient.durIngredientKeys)
          .filter(Boolean)
      )
    );
    const ingredientCodeSet = new Set(
      deduplicated.flatMap((medication) =>
        medication.ingredients
          .map((ingredient) => canonicalIngredientCode(ingredient.ingredientCode))
          .filter(Boolean)
      )
    );
    const durFindings = new Map<string, SafetyFinding>();
    const catalogComplete = this.repository.hasCompleteDurIngredientCatalog();
    const medicationCatalogMapped = new Map(
      deduplicated.map((medication) => [
        medication,
        (medication.product === null || medication.product.ingredientsComplete) &&
          medication.ingredients.length > 0 &&
          medication.ingredients.every((ingredient) => {
            if (ingredient.durIngredientKeys.length === 0) return false;
            const mappings = ingredient.durIngredientMappings;
            return (
              !mappings ||
              (mappings.length > 0 &&
                mappings.every(
                  (mapping) =>
                    mapping.basis !== "FALLBACK" && mapping.basis !== "AMBIGUOUS_FORM"
                ))
            );
          })
      ])
    );
    const ingredientCatalogUsable =
      deduplicated.length > 0 &&
      catalogComplete &&
      deduplicated.every((medication) => medicationCatalogMapped.get(medication) === true);

    const ingredientRules = this.repository.getDurIngredientContraindications(
      Array.from(ingredientKeySet)
    );
    const conditionalRuleIssues = new Set<string>();
    for (const rule of ingredientRules) {
      const sourceMedications = deduplicated.filter((medication) =>
        medicationHasIngredient(
          medication,
          rule.sourceIngredientKey,
          rule.sourceIngredientCode
        )
      );
      for (const sourceMedication of sourceMedications) {
        const targetMedications = deduplicated.filter(
          (medication) =>
            medication !== sourceMedication &&
            medicationHasIngredient(
              medication,
              rule.targetIngredientKey,
              rule.targetIngredientCode
            )
        );
        for (const targetMedication of targetMedications) {
          const sourceApplicability = ingredientRuleSideApplicability(
            sourceMedication.ingredients,
            sourceMedication.product?.ingredientsComplete ?? true,
            rule.sourceIngredientKey,
            rule.sourceMixType,
            rule.sourceMixture
          );
          const targetApplicability = ingredientRuleSideApplicability(
            targetMedication.ingredients,
            targetMedication.product?.ingredientsComplete ?? true,
              rule.targetIngredientKey,
              rule.targetMixType,
              rule.targetMixture
          );
          if (sourceApplicability === "NO_MATCH" || targetApplicability === "NO_MATCH") {
            continue;
          }
          if (sourceApplicability === "UNKNOWN" || targetApplicability === "UNKNOWN") {
            conditionalRuleIssues.add(
              `${sourceMedication.displayName} × ${targetMedication.displayName}: DUR 복합제·관계성분 조건 확인 불가`
            );
            continue;
          }
          mergeDurFinding(durFindings, {
            type: "USJNT_TABOO",
            origin: "DUR_INGREDIENT_SNAPSHOT",
            level: "RED",
            a: sourceMedication.displayName,
            b: targetMedication.displayName,
            reason: rule.reason,
            source: rule.source,
            baseDate: rule.baseDate,
            dateBasis: rule.dateBasis
          });
        }
      }
    }
    if (conditionalRuleIssues.size > 0) {
      failedTypes.push("USJNT_TABOO");
      unresolved.push(...conditionalRuleIssues);
    }
    if (ingredientCatalogUsable) checkedTypes.push("USJNT_TABOO");

    for (const medication of deduplicated.filter((item) => item.itemSeq)) {
      let contraindications: DurContraindication[];
      if (ingredientCatalogUsable) {
        const snapshot = this.repository.getDurSnapshot(medication.itemSeq!);
        if (!snapshot?.complete) continue;
        contraindications = snapshot.contraindications;
      } else {
        if (!medication.durQueryable) {
          failedTypes.push("USJNT_TABOO");
          unresolved.push(`${medication.displayName}: DUR 품목기준코드 미확인으로 병용금기 조회 보류`);
          continue;
        }
        const result = await this.durClient.checkUsjntTaboo(medication.itemSeq!);
        if (!result.ok) {
          failedTypes.push(result.failedType ?? "USJNT_TABOO");
          unresolved.push(`${medication.displayName}: 병용금기 데이터 미확인으로 판정 보류`);
          continue;
        }
        contraindications = result.contraindications;
      }

      checkedTypes.push("USJNT_TABOO");
      for (const taboo of contraindications) {
        const targetIngredientKey = taboo.targetIngredientKey
          ? canonicalIngredientIdentity(taboo.targetIngredientKey)
          : taboo.targetIngredientName
            ? canonicalIngredientIdentity(taboo.targetIngredientName)
            : null;
        const targetMatched =
          (taboo.targetItemSeq && itemSeqSet.has(taboo.targetItemSeq)) ||
          (targetIngredientKey && ingredientKeySet.has(targetIngredientKey)) ||
          (taboo.targetIngredientCode &&
            ingredientCodeSet.has(canonicalIngredientCode(taboo.targetIngredientCode)));
        if (!targetMatched) continue;
        const target = this.findValidMedication(
          deduplicated,
          taboo.targetItemSeq,
          targetIngredientKey,
          taboo.targetIngredientCode
        );
        const targetName =
          target?.displayName ?? taboo.targetItemSeq ?? taboo.targetIngredientName ?? taboo.targetIngredientCode ?? "상대 약";
        mergeDurFinding(durFindings, {
          type: "USJNT_TABOO",
          origin: "DUR_SNAPSHOT",
          level: "RED",
          a: medication.displayName,
          b: targetName,
          reason: taboo.reason,
          source: taboo.source,
          baseDate: taboo.baseDate,
          dateBasis: taboo.dateBasis
        });
      }
    }

    if (!ingredientCatalogUsable && deduplicated.some((item) => !item.itemSeq)) {
      failedTypes.push("USJNT_TABOO");
    }

    findings.push(...durFindings.values());

    if (deduplicated.length === 0 && unresolved.length === 0) {
      unresolved.push("확정된 약 없음");
    }

    const uniqueFailedTypes = Array.from(new Set(failedTypes));
    const failedTypeSet = new Set(uniqueFailedTypes);
    const partial = {
      findings,
      unresolved,
      checkedTypes: Array.from(new Set(checkedTypes)).filter((type) => !failedTypeSet.has(type)),
      failedTypes: uniqueFailedTypes
    };
    return {
      verdict: verdictFrom(partial),
      dataAsOf: this.baseDate,
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
        baseDate: this.baseDate,
        dateBasis: "LOCAL_POLICY_DATE"
      }));
  }

  private localDuplicateIngredientFindings(valid: ValidMedication[]): SafetyFinding[] {
    const identities = new IngredientIdentitySet();
    for (const medication of valid) {
      for (const ingredient of medication.ingredients) {
        identities.add(ingredient);
      }
    }

    const groups = new Map<
      string,
      { medications: Set<ValidMedication>; names: Set<string>; codes: Set<string> }
    >();
    for (const medication of valid) {
      for (const ingredient of medication.ingredients) {
        const root = identities.rootFor(ingredient);
        const group = groups.get(root) ?? {
          medications: new Set<ValidMedication>(),
          names: new Set<string>(),
          codes: new Set<string>()
        };
        group.medications.add(medication);
        group.names.add(ingredient.ingredientName);
        if (ingredient.ingredientCode) group.codes.add(ingredient.ingredientCode);
        groups.set(root, group);
      }
    }

    const findings: SafetyFinding[] = [];
    for (const group of groups.values()) {
      const uniqueNames = Array.from(group.medications, (item) => item.displayName);
      if (uniqueNames.length < 2) continue;
      const ingredientName = Array.from(group.names).sort(
        (left, right) => left.length - right.length || left.localeCompare(right)
      )[0] ?? Array.from(group.codes)[0] ?? "동일 주성분";
      findings.push({
        type: "DUP_INGREDIENT",
        origin: "LOCAL_INGREDIENT",
        level: "YELLOW",
        a: uniqueNames[0]!,
        b: uniqueNames.slice(1).join(", "),
        reason: `${ingredientName} 성분이 겹칩니다. 공개 데이터 기반 정보 조회 결과이며 임의 중단 또는 용량 변경 지시가 아닙니다.`,
        source: "MFDS DUR 품목 성분 스냅샷",
        baseDate: this.baseDate,
        dateBasis: "SNAPSHOT_FETCHED_AT"
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
        baseDate: this.baseDate,
        dateBasis: "LOCAL_POLICY_DATE"
      });
    } else if (context.ageGroup === "child" || context.ageGroup === "elderly") {
      findings.push({
        type: "CONTEXT_UNKNOWN",
        origin: "LOCAL_POLICY",
        level: "YELLOW",
        a: context.ageGroup === "child" ? "소아 복약" : "고령자 복약",
        b: null,
        reason:
          context.ageGroup === "child"
            ? "이 도구는 연령별 금기를 판정하지 않습니다. 소아 복약은 의사 또는 약사에게 확인하세요."
            : "이 도구는 노인주의를 판정하지 않습니다. 고령자 복약은 의사 또는 약사에게 확인하세요.",
        source: "서버 범위 정책",
        baseDate: this.baseDate,
        dateBasis: "LOCAL_POLICY_DATE"
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
        baseDate: this.baseDate,
        dateBasis: "LOCAL_POLICY_DATE"
      });
    }
    if (context.pregnancy === "yes") {
      findings.push({
        type: "CONTEXT_UNKNOWN",
        origin: "LOCAL_POLICY",
        level: "YELLOW",
        a: "임신 컨텍스트",
        b: null,
        reason: "이 도구는 임부금기를 판정하지 않습니다. 임신 중 복약은 반드시 의사 또는 약사에게 확인하세요.",
        source: "서버 범위 정책",
        baseDate: this.baseDate,
        dateBasis: "LOCAL_POLICY_DATE"
      });
    }
    return findings;
  }

  private findValidMedication(
    valid: ValidMedication[],
    itemSeq?: string | null,
    ingredientKey?: string | null,
    ingredientCode?: string | null
  ): ValidMedication | null {
    return (
      valid.find((medication) => itemSeq && medication.itemSeq === itemSeq) ??
      valid.find((medication) =>
        ingredientKey &&
        medication.ingredients.some(
          (ingredient) => ingredient.durIngredientKeys.includes(ingredientKey)
        )
      ) ??
      valid.find((medication) =>
        ingredientCode &&
        medication.ingredients.some(
          (ingredient) =>
            canonicalIngredientCode(ingredient.ingredientCode) ===
            canonicalIngredientCode(ingredientCode)
        )
      ) ??
      null
    );
  }
}

function mergeDurFinding(findings: Map<string, SafetyFinding>, incoming: SafetyFinding): void {
  const key = [incoming.a, incoming.b ?? ""].sort().join("|");
  const existing = findings.get(key);
  if (!existing) {
    findings.set(key, incoming);
    return;
  }
  existing.reason = mergeEvidenceText(existing.reason, incoming.reason);
  if (evidenceIsNewer(incoming, existing)) {
    existing.origin = incoming.origin;
    existing.source = incoming.source;
    existing.baseDate = incoming.baseDate;
    existing.dateBasis = incoming.dateBasis;
  }
}

function mergeEvidenceText(left: string, right: string): string {
  const values = new Set(
    [left, right]
      .flatMap((value) => value.split(" / "))
      .map((value) => value.replace(/\s+/g, " ").trim())
      .filter(Boolean)
  );
  return Array.from(values).join(" / ");
}

function evidenceIsNewer(incoming: SafetyFinding, existing: SafetyFinding): boolean {
  if (incoming.baseDate !== existing.baseDate) return incoming.baseDate > existing.baseDate;
  const rank = (basis: SafetyFinding["dateBasis"]): number =>
    basis === "SOURCE_DATE"
      ? 4
      : basis === "SNAPSHOT_FETCHED_AT"
        ? 3
        : basis === "FIXTURE_DATE"
          ? 2
          : 1;
  if (rank(incoming.dateBasis) !== rank(existing.dateBasis)) {
    return rank(incoming.dateBasis) > rank(existing.dateBasis);
  }
  return incoming.source.localeCompare(existing.source) > 0;
}

class IngredientIdentitySet {
  private readonly parent = new Map<string, string>();

  add(ingredient: ProductIngredient): void {
    const keyIdentity = `key:${ingredient.ingredientKey}`;
    this.ensure(keyIdentity);
    const canonicalKey = canonicalIngredientIdentity(ingredient.ingredientName);
    if (canonicalKey) {
      const canonicalIdentity = `canonical:${canonicalKey}`;
      this.ensure(canonicalIdentity);
      this.union(keyIdentity, canonicalIdentity);
      for (const equivalent of CURATED_DUPLICATE_INGREDIENT_EQUIVALENTS.get(canonicalKey) ?? []) {
        if (!equivalent) continue;
        const equivalentIdentity = `canonical:${equivalent}`;
        this.ensure(equivalentIdentity);
        this.union(keyIdentity, equivalentIdentity);
        const durEquivalentIdentity = `dur:${equivalent}`;
        this.ensure(durEquivalentIdentity);
        this.union(keyIdentity, durEquivalentIdentity);
      }
    }
    for (const durIngredientKey of ingredient.durIngredientKeys) {
      const durIdentity = `dur:${durIngredientKey}`;
      this.ensure(durIdentity);
      this.union(keyIdentity, durIdentity);
    }
    if (!ingredient.ingredientCode) return;
    const codeIdentity = `hira:${ingredient.ingredientCode}`;
    this.ensure(codeIdentity);
    this.union(keyIdentity, codeIdentity);
  }

  rootFor(ingredient: ProductIngredient): string {
    return this.find(`key:${ingredient.ingredientKey}`);
  }

  private ensure(value: string): void {
    if (!this.parent.has(value)) this.parent.set(value, value);
  }

  private find(value: string): string {
    this.ensure(value);
    const parent = this.parent.get(value)!;
    if (parent === value) return value;
    const root = this.find(parent);
    this.parent.set(value, root);
    return root;
  }

  private union(left: string, right: string): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parent.set(rightRoot, leftRoot);
  }
}

function ingredientRowsForCode(
  repository: MasterRepository,
  ingredientCode: string
): ProductIngredient[] {
  const product = repository.getProductsByIngredient(ingredientCode)[0];
  if (!product) return [];
  return repository
    .getProductIngredients(product.itemSeq)
    .filter((ingredient) => ingredient.ingredientCode === ingredientCode);
}

function canQueryDur(product: MasterProduct): boolean {
  return product.source !== "HIRA_ATC_MAPPING";
}

function nonEmptyOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function canonicalIngredientCode(value: string | null | undefined): string {
  return value?.trim().toUpperCase() ?? "";
}

function medicationHasIngredient(
  medication: ValidMedication,
  ingredientKey: string | null | undefined,
  ingredientCode: string | null | undefined
): boolean {
  const expectedKey = ingredientKey ? canonicalIngredientIdentity(ingredientKey) : "";
  const expectedCode = canonicalIngredientCode(ingredientCode);
  return medication.ingredients.some(
    (ingredient) =>
      (expectedKey && ingredient.durIngredientKeys.includes(expectedKey)) ||
      (expectedCode && canonicalIngredientCode(ingredient.ingredientCode) === expectedCode)
  );
}

export type IngredientRuleApplicability = "MATCH" | "NO_MATCH" | "UNKNOWN";

export function ingredientRuleSideApplicability(
  ingredients: ProductIngredient[],
  ingredientsComplete: boolean,
  primaryIngredientKey: string,
  mixType?: string,
  mixture?: string
): IngredientRuleApplicability {
  if (!ingredientsComplete || ingredients.length === 0) return "UNKNOWN";
  const normalizedMixType = normalizeConditionText(mixType);
  let compoundRequired = false;
  if (normalizedMixType) {
    const single = normalizedMixType.includes("단일");
    const compound = normalizedMixType.includes("복합");
    if (single && compound) return "UNKNOWN";
    if (single && ingredients.length !== 1) return "NO_MATCH";
    compoundRequired = compound;
    if (!single && !compound) {
      return "UNKNOWN";
    }
  }

  const ingredientKeys = new Set(
    ingredients.flatMap((ingredient) => ingredient.durIngredientKeys).filter(Boolean)
  );
  const ingredientCodes = new Set(
    ingredients.flatMap((ingredient) =>
      (ingredient.durIngredientMappings ?? []).flatMap((mapping) => mapping.codes)
    )
  );
  const primaryKey = canonicalIngredientIdentity(primaryIngredientKey);
  let structuredConditionFound = false;
  for (const condition of [mixture]) {
    const normalized = normalizeConditionText(condition);
    if (!normalized || /^(?:-|없음|해당없음|n|no|아니오)$/i.test(normalized)) continue;
    if (/^(?:y|yes|예|해당|복합제)$/i.test(normalized)) {
      if (ingredientKeys.size < 2) return "NO_MATCH";
      continue;
    }
    const required = conditionIngredientRequirements(condition ?? "").filter(
      (reference) => reference.key && reference.key !== primaryKey
    );
    if (required.length === 0) {
      if (primaryKey && normalized.includes(primaryKey)) continue;
      return "UNKNOWN";
    }
    structuredConditionFound = hasStructuredIngredientCondition(condition ?? "");
    if (
      !required.every(
        (reference) =>
          ingredientKeys.has(reference.key) ||
          (reference.code !== null && ingredientCodes.has(reference.code))
      )
    ) {
      return hasStructuredIngredientCondition(condition ?? "") ? "NO_MATCH" : "UNKNOWN";
    }
  }
  if (compoundRequired && !structuredConditionFound && ingredientKeys.size < 2) {
    return "NO_MATCH";
  }
  return "MATCH";
}

function normalizeConditionText(value: string | null | undefined): string {
  return value?.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "") ?? "";
}

function conditionIngredientRequirements(
  value: string
): Array<{ key: string; code: string | null }> {
  const officialReferences = parseDurIngredientReferences(value);
  if (officialReferences.length > 0) {
    return officialReferences.map((reference) => ({
      key: reference.key,
      code: reference.code.trim().toUpperCase() || null
    }));
  }
  return value
    .split(/\s*(?:\/|\+|,|·|;)\s*|\s+(?:및|와|과)\s+/u)
    .map((part) => canonicalIngredientIdentity(part))
    .filter((part) => part.length >= 2 && !/^(?:단일제?|복합제?|관계성분)$/.test(part))
    .map((key) => ({ key, code: null }));
}

function hasStructuredIngredientCondition(value: string): boolean {
  return /\[[A-Za-z]\d+\]/u.test(value) || /(?:\/|\+|,|·|;|&)|\s+(?:및|와|과)\s+/u.test(value);
}
