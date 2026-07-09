export type ResolutionStatus = "CONFIRMED" | "AMBIGUOUS" | "NOT_FOUND" | "OUT_OF_SCOPE";
export type InputKind = "PRODUCT" | "INGREDIENT" | "UNKNOWN" | "FOOD_OR_SUPPLEMENT";
export type Verdict = "NO_KNOWN_FINDINGS" | "CAUTION" | "WARN" | "UNCERTAIN";
export type FindingLevel = "RED" | "YELLOW" | "GREEN";
export type FindingOrigin = "DUR_API" | "LOCAL_INGREDIENT" | "LOCAL_ATC" | "LOCAL_POLICY";

export type FindingType =
  | "USJNT_TABOO"
  | "AGE_TABOO"
  | "PREG_TABOO"
  | "DUP_INGREDIENT"
  | "EFCY_DUP"
  | "ELDERLY_CAUTION"
  | "CAPACITY"
  | "PERIOD"
  | "SR_SPLIT"
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
}

export interface AliasEntry {
  alias: string;
  kind: Exclude<InputKind, "UNKNOWN">;
  targetItemSeq?: string;
  targetIngredientCode?: string;
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
  subjectIsUser?: boolean;
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
}

export interface SafetyResult {
  verdict: Verdict;
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
  reason: string;
  baseDate: string;
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
