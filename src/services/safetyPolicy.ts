import type { SafetyFinding, SafetyResult, Verdict } from "../types.js";
import { containsAny } from "../utils/text.js";

export const STANDARD_DISCLAIMER =
  "본 정보는 식약처 공개데이터 기반 일반 참고용이며 의사·약사의 진단·처방·복약지도를 대체하지 않습니다. 실제 복용·중단·변경은 반드시 의사 또는 약사와 상담하세요. 응급 증상 시 즉시 119.";

export const SCOPE_NOTICE =
  "이 결과는 건강기능식품·식품·한약·일부 의약품 정보를 포함하지 못할 수 있습니다.";

export const NON_DEVICE_NOTICE = "본 서비스는 의료기기가 아닙니다.";

const BANNED_REPLACEMENTS: Array<[RegExp, string]> = [
  [/<script\b[^>]*>[\s\S]*?<\/script>/gi, "[제거된 스크립트]"],
  [/위\s*결과\s*무시\.?/gi, "[제거된 지시문]"],
  [/ignore\s+(the\s+)?(above|previous)\s+(result|instruction|message)s?/gi, "[removed instruction]"],
  [/system\s+prompt/gi, "[removed instruction]"],
  [/안전합니다/g, "등록된 금기는 조회되지 않았습니다"],
  [/안심하세요/g, "전문가 확인을 권장합니다"],
  [/복용해도 됩니다/g, "복용 가능 여부는 의사 또는 약사와 상담하세요"],
  [/먹지 마세요/g, "임의 중단하지 말고 의사 또는 약사와 상담하세요"],
  [/끊으세요/g, "임의 중단하지 말고 의사 또는 약사와 상담하세요"],
  [/용량을 바꾸세요/g, "용량 변경은 의사 또는 약사와 상담하세요"]
];

export const EMERGENCY_TERMS = [
  "호흡곤란",
  "호흡 곤란",
  "숨쉬기 힘",
  "숨 쉬기 힘",
  "의식저하",
  "의식 저하",
  "아나필락시스",
  "심한 흉통",
  "가슴 통증",
  "가슴이 아파",
  "입술 부종",
  "과다복용",
  "과량복용",
  "과복용"
];

const EMERGENCY_PATTERNS = [
  /과다\s*복용|과량\s*복용|과\s*복용/i,
  /한\s*꺼번\s*에\s*(\d+|[한두세네다섯여섯일곱여덟아홉열일이삼사오육칠팔구십백]+)\s*(알|정|캡슐|통|병)?/i,
  /한\s*꺼번\s*에\s*(한\s*통|두\s*통|세\s*통|\d+\s*통|\d+\s*병)/i,
  /약을\s*(너무\s*)?(많이|과하게)\s*(먹|삼켰|복용)/i,
  /(\d+|[한두세네다섯여섯일곱여덟아홉열일이삼사오육칠팔구십백]+)\s*(알|정|캡슐)\s*(을|를)?\s*(다|전부|모두)\s*(먹|삼켰|복용)/i,
  /(한\s*통|두\s*통|세\s*통|\d+\s*통)\s*(을|를)?\s*(다|전부|모두)\s*(먹|삼켰|복용)/i
];

export function hasEmergencySignal(text: string): boolean {
  const normalized = text.normalize("NFKC").toLowerCase();
  return containsAny(normalized, EMERGENCY_TERMS) || EMERGENCY_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function sanitizeSafetyText(text: string): string {
  const replaced = BANNED_REPLACEMENTS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    text
  );
  return escapeAngleBrackets(replaced).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

export function sanitizeStructuredContent<T>(value: T): T {
  if (typeof value === "string") {
    return sanitizeSafetyText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeStructuredContent(item)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, sanitizeStructuredContent(nested)])
    ) as T;
  }
  return value;
}

export function sanitizeSafetyResult(result: SafetyResult): SafetyResult {
  return sanitizeStructuredContent(result);
}

export function verdictFrom(result: Omit<SafetyResult, "verdict" | "disclaimer">): Verdict {
  if (result.findings.some((finding) => finding.level === "RED")) return "WARN";
  if (result.unresolved.length > 0 || result.failedTypes.length > 0) return "UNCERTAIN";
  if (result.findings.some((finding) => finding.level === "YELLOW")) return "CAUTION";
  return "NO_KNOWN_FINDINGS";
}

export function formatSafetyResult(result: SafetyResult): string {
  const redCount = result.findings.filter((finding) => finding.level === "RED").length;
  const yellowCount = result.findings.filter((finding) => finding.level === "YELLOW").length;
  const signal = result.verdict === "WARN" ? "🔴" : result.verdict === "NO_KNOWN_FINDINGS" ? "🟢" : "🟡";
  const headline =
    result.verdict === "NO_KNOWN_FINDINGS"
      ? `${signal} 등록된 금기/주의 정보 미조회`
      : result.verdict === "WARN"
        ? `${signal} 금기 ${redCount}건 / 주의 ${yellowCount}건`
        : result.findings.length === 0
          ? `${signal} 추가 확인 필요`
          : `${signal} 주의 정보 ${yellowCount}건 (🔴 금기 ${redCount}건)`;

  const lines = [headline, ""];
  for (const finding of result.findings) {
    lines.push(`• [${finding.type}] ${finding.a}${finding.b ? ` × ${finding.b}` : ""}`);
    lines.push(`  → ${finding.reason}`);
    if (needsMappingCaveat(finding)) {
      lines.push("  이 약이 아니면 이 경고는 무시하세요. 이미 처방받은 조합일 수 있으니 임의 중단 전 의사·약사에게 문의하세요.");
    }
    lines.push(`  출처: ${finding.source} · 기준일 ${finding.baseDate}`);
  }

  if (result.unresolved.length > 0) {
    lines.push("");
    lines.push(`※ 특정하지 못한 항목: ${result.unresolved.join(", ")}`);
  }

  if (result.failedTypes.length > 0) {
    lines.push("");
    lines.push(`※ 일부 조회 실패: ${Array.from(new Set(result.failedTypes)).join(", ")}. 이 경우 녹색으로 표시하지 않습니다.`);
  }

  const usjntCheckedWithoutFailure =
    result.checkedTypes.includes("USJNT_TABOO") && !result.failedTypes.includes("USJNT_TABOO");
  if (redCount === 0 && usjntCheckedWithoutFailure) {
    lines.push("");
    lines.push("※ 등록된 병용금기는 조회되지 않았습니다(안전을 보장하는 것은 아닙니다).");
  }

  lines.push(SCOPE_NOTICE);
  lines.push("이미 처방받은 조합일 수 있으니 임의 중단 전 약사·의사에게 문의하세요.");
  lines.push("");
  lines.push("────────");
  lines.push(result.disclaimer);

  return sanitizeSafetyText(lines.join("\n"));
}

function needsMappingCaveat(finding: SafetyFinding): boolean {
  return (
    finding.level !== "GREEN" &&
    finding.type !== "CONTEXT_UNKNOWN" &&
    finding.type !== "EMERGENCY" &&
    finding.a !== "연령 정보 없음" &&
    finding.a !== "임부 여부 정보 없음"
  );
}

function escapeAngleBrackets(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function emergencyResult(baseDate: string): SafetyResult {
  const finding: SafetyFinding = {
    type: "EMERGENCY",
    origin: "LOCAL_POLICY",
    level: "RED",
    a: "응급 의심 표현",
    b: null,
    reason: "응급 신호가 언급되었습니다. 상호작용 조회보다 119 또는 응급실 상담이 우선입니다.",
    source: "서버 안전정책",
    baseDate
  };
  return {
    verdict: "WARN",
    findings: [finding],
    unresolved: [],
    checkedTypes: [],
    failedTypes: [],
    disclaimer: STANDARD_DISCLAIMER
  };
}
