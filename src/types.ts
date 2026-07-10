export type ResolutionStatus = "CONFIRMED" | "AMBIGUOUS" | "NOT_FOUND" | "OUT_OF_SCOPE";
export type InputKind = "PRODUCT" | "INGREDIENT" | "UNKNOWN" | "FOOD_OR_SUPPLEMENT";
export type Verdict = "NO_KNOWN_FINDINGS" | "CAUTION" | "WARN" | "UNCERTAIN";
export type FindingLevel = "RED" | "YELLOW" | "GREEN";
export type FindingOrigin =
  | "DUR_SNAPSHOT"
  | "DUR_INGREDIENT_SNAPSHOT"
  | "LOCAL_INGREDIENT"
  | "LOCAL_ATC"
  | "LOCAL_POLICY";
export type DateBasis =
  | "SOURCE_DATE"
  | "SNAPSHOT_FETCHED_AT"
  | "LOCAL_POLICY_DATE"
  | "FIXTURE_DATE";

export type FindingType =
  | "USJNT_TABOO"
  | "DUP_INGREDIENT"
  | "DUP_INPUT"
  | "EMERGENCY"
  | "CONTEXT_UNKNOWN";

export interface MasterProduct {
  itemSeq: string;
  productCode: string;
  name: string;
  normalizedName: string;
  manufacturer: string;
  ingredientCode: string;
  ingredientName: string;
  atcCode: string;
  atcName: string;
  source: string;
  ingredientsComplete: boolean;
}

export interface MasterProductInput {
  itemSeq?: string;
  productCode?: string;
  name: string;
  manufacturer?: string;
  ingredientCode?: string;
  ingredientName?: string;
  atcCode?: string;
  atcName?: string;
  source?: string;
  ingredients?: ProductIngredientInput[];
  ingredientsComplete?: boolean;
}

export type DurIngredientMappingBasis =
  | "OFFICIAL_RELATION"
  | "CONSERVATIVE_FORM"
  | "CURATED_SPELLING"
  | "CATALOG_ABSENT"
  | "FALLBACK"
  | "AMBIGUOUS_FORM"
  | "FIXTURE";

export interface DurIngredientMapping {
  key: string;
  codes: string[];
  basis: DurIngredientMappingBasis;
}

export interface ProductIngredientInput {
  ingredientName: string;
  ingredientCode?: string;
  ingredientKey?: string;
  durIngredientKeys?: string[];
  durIngredientMappings?: DurIngredientMapping[];
}

export interface ProductIngredient {
  itemSeq: string;
  ingredientKey: string;
  durIngredientKeys: string[];
  durIngredientMappings?: DurIngredientMapping[];
  ingredientName: string;
  ingredientCode: string;
}

export interface AliasEntry {
  alias: string;
  kind: Exclude<InputKind, "UNKNOWN">;
  targetItemSeq?: string;
  targetIngredientCode?: string;
  targetIngredientKey?: string;
  label?: string;
}

export interface MedicationCandidate {
  itemSeq: string | null;
  ingrCode: string | null;
  matchedName: string;
  manufacturer: string | null;
  score: number;
  reason: string;
}

export interface ResolvedMedication {
  query: string;
  status: ResolutionStatus;
  inputKind: InputKind;
  itemSeq: string | null;
  ingrCode: string | null;
  matchedName: string | null;
  candidates: MedicationCandidate[];
}

export interface MedicationForCheck {
  itemSeq?: string | null;
  ingrCode?: string | null;
  status?: ResolutionStatus;
  displayName?: string | null;
  confirmationToken?: string | null;
}

export interface SafetyContext {
  ageGroup?: "adult" | "elderly" | "child" | "unknown";
  pregnancy?: "yes" | "no" | "unknown";
  notes?: string | null;
}

export interface SafetyFinding {
  type: FindingType;
  origin: FindingOrigin;
  level: FindingLevel;
  a: string;
  b: string | null;
  reason: string;
  source: string;
  baseDate: string;
  dateBasis: DateBasis;
}

export interface SafetyResult {
  verdict: Verdict;
  dataAsOf: string;
  findings: SafetyFinding[];
  unresolved: string[];
  checkedTypes: string[];
  failedTypes: string[];
  disclaimer: string;
}

export interface ToolResponse<T> {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: T;
  isError?: boolean;
}

export interface DurContraindication {
  sourceItemSeq: string;
  targetItemSeq?: string | null;
  targetIngredientCode?: string | null;
  targetIngredientName?: string | null;
  targetIngredientKey?: string | null;
  reason: string;
  baseDate: string;
  dateBasis: DateBasis;
  source: string;
}

export interface DurSnapshotInput {
  itemSeq: string;
  complete: boolean;
  fetchedAt: string;
  source: string;
  contraindications: DurContraindication[];
}

export interface DurSnapshot {
  itemSeq: string;
  complete: boolean;
  fetchedAt: string;
  source: string;
  contraindications: DurContraindication[];
}

export interface DurIngredientContraindication {
  sourceIngredientCode: string | null;
  sourceIngredientName: string;
  sourceIngredientKey: string;
  targetIngredientCode: string | null;
  targetIngredientName: string;
  targetIngredientKey: string;
  sourceMixType?: string;
  sourceMixture?: string;
  sourceRelation?: string;
  targetMixType?: string;
  targetMixture?: string;
  targetRelation?: string;
  reason: string;
  baseDate: string;
  dateBasis: DateBasis;
  source: string;
}

export interface DurCheckResult {
  ok: boolean;
  type: "USJNT_TABOO";
  contraindications: DurContraindication[];
  failedType?: string;
  unresolvedFields?: string[];
  error?: string;
}

export interface EasyDrugInfo {
  itemSeq: string;
  itemName: string;
  entpName: string;
  efcyQesitm?: string;
  useMethodQesitm?: string;
  atpnWarnQesitm?: string;
  atpnQesitm?: string;
  intrcQesitm?: string;
  seQesitm?: string;
  depositMethodQesitm?: string;
}

export type EasyDrugLookupStatus = "FOUND" | "NOT_FOUND" | "UPSTREAM_ERROR";

export interface EasyDrugLookupResult {
  status: EasyDrugLookupStatus;
  info: EasyDrugInfo | null;
  error?: string;
}
