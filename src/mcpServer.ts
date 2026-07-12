import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { AppServices } from "./app.js";
import type {
  MedicationCandidate,
  MedicationForCheck,
  ResolvedMedication,
  SafetyContext
} from "./types.js";
import { conciseEasyDrugInfo, formatEasyDrugInfo } from "./services/easyDrugClient.js";
import {
  emergencyResult,
  formatSafetyResult,
  hasEmergencySignal,
  hasPotentialOverdoseSignal,
  NON_DEVICE_NOTICE,
  sanitizeSafetyResult,
  sanitizeSafetyText,
  sanitizeStructuredContent,
  SCOPE_NOTICE,
  STANDARD_DISCLAIMER,
  potentialOverdoseResult
} from "./services/safetyPolicy.js";

const MAX_RESOLVE_QUERIES = 8;
const MAX_QUERY_CHARS = 512;
const MAX_CHECK_MEDICATIONS = 12;
const MAX_ID_CHARS = 80;
const MAX_DISPLAY_NAME_CHARS = 512;
const MAX_CONTEXT_NOTES_CHARS = 500;
const CHECK_HANDOFF_START = "[CHECK_MEDICATION_SAFETY_INPUT]";
const CHECK_HANDOFF_END = "[/CHECK_MEDICATION_SAFETY_INPUT]";

const SERVICE_NAME = "Medsafe Bot(복약안전 봇)";

function readOnlyToolAnnotations(title: string, openWorldHint: boolean) {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint,
    idempotentHint: true
  };
}

const candidateSchema = z.object({
  itemSeq: z.string().nullable(),
  ingrCode: z.string().nullable(),
  matchedName: z.string(),
  manufacturer: z.string().nullable(),
  score: z.number(),
  reason: z.string(),
  confirmationToken: z.string().nullable().optional()
});

const findingTypeSchema = z.enum([
  "USJNT_TABOO",
  "DUP_INGREDIENT",
  "DUP_INPUT",
  "EMERGENCY",
  "CONTEXT_UNKNOWN"
]);
const findingOriginSchema = z.enum([
  "DUR_SNAPSHOT",
  "DUR_INGREDIENT_SNAPSHOT",
  "LOCAL_INGREDIENT",
  "LOCAL_ATC",
  "LOCAL_POLICY"
]);
const findingLevelSchema = z.enum(["RED", "YELLOW", "GREEN"]);
const checkedTypeSchema = z.enum(["USJNT_TABOO", "DUP_INGREDIENT", "DUP_INPUT"]);
const failedTypeSchema = z.enum([
  "USJNT_TABOO",
  "DUP_INGREDIENT",
  "DUP_INPUT",
  "EMERGENCY_TRIAGE"
]);

const findingSchema = z.object({
  type: findingTypeSchema,
  origin: findingOriginSchema,
  level: findingLevelSchema,
  a: z.string().max(MAX_DISPLAY_NAME_CHARS),
  b: z.string().max(MAX_DISPLAY_NAME_CHARS).nullable(),
  reason: z.string().max(2048),
  source: z.string().max(512),
  baseDate: z.string().max(64),
  dateBasis: z.enum(["SOURCE_DATE", "SNAPSHOT_FETCHED_AT", "LOCAL_POLICY_DATE", "FIXTURE_DATE"])
});

const easyDrugInfoSchema = z.object({
  itemSeq: z.string(),
  itemName: z.string(),
  entpName: z.string(),
  efcyQesitm: z.string().optional(),
  useMethodQesitm: z.string().optional(),
  atpnWarnQesitm: z.string().optional(),
  atpnQesitm: z.string().optional(),
  intrcQesitm: z.string().optional(),
  seQesitm: z.string().optional(),
  depositMethodQesitm: z.string().optional()
});

export function buildMcpServer(services: AppServices): McpServer {
  const server = new McpServer({
    name: "medsafe-bot",
    version: "0.1.0"
  });

  server.registerTool(
    "resolve_medications",
    {
      title: "약 이름 정규화",
      description:
        `${SERVICE_NAME} maps medication names or ingredients to standard itemSeq and ingredient codes. For fully confirmed inputs, copy every field from the CHECK_MEDICATION_SAFETY_INPUT text block unchanged into check_medication_safety, including confirmationToken, and never expose the token to the user. Ambiguous names require clarification and this tool does not make a safety verdict.`,
      annotations: readOnlyToolAnnotations("약 이름 정규화", false),
      inputSchema: {
        queries: z
          .array(z.string().trim().min(1).max(MAX_QUERY_CHARS))
          .min(1)
          .max(MAX_RESOLVE_QUERIES)
          .describe("사용자가 말한 약 표현 목록")
      },
      outputSchema: {
        resolved: z.array(
          z.object({
            query: z.string(),
            status: z.enum(["CONFIRMED", "AMBIGUOUS", "NOT_FOUND", "OUT_OF_SCOPE"]),
            inputKind: z.enum(["PRODUCT", "INGREDIENT", "UNKNOWN", "FOOD_OR_SUPPLEMENT"]),
            itemSeq: z.string().nullable(),
            ingrCode: z.string().nullable(),
            matchedName: z.string().nullable(),
            confirmationToken: z.string().nullable().optional(),
            candidates: z.array(candidateSchema)
          })
        ),
        emergency: z.boolean().optional(),
        triageStatus: z.enum(["UNCERTAIN"]).optional(),
        dataAsOf: z.string()
      }
    },
    async ({ queries }) => {
      // Keep list items as independent clauses so an informational query cannot suppress a later emergency.
      const emergencyText = queries.join("\n");
      const medicationReferences = services.resolver.medicationReferencesInText(emergencyText);
      const medicationNames = services.resolver.knownMedicationNamesInText(emergencyText);
      if (hasEmergencySignal(emergencyText, medicationNames)) {
        const result = emergencyResult(services.baseDate);
        return {
          content: [{ type: "text" as const, text: formatSafetyResult(result) }],
          structuredContent: { resolved: [], emergency: true, dataAsOf: services.baseDate }
        };
      }
      if (hasPotentialOverdoseSignal(emergencyText, medicationNames)) {
        const result = potentialOverdoseResult(services.baseDate);
        const resolved = addConfirmationTokens(
          services,
          services.resolver.resolveMany(medicationReferences.slice(0, MAX_RESOLVE_QUERIES))
        );
        return {
          content: [{ type: "text" as const, text: formatSafetyResult(result) }],
          structuredContent: sanitizeStructuredContent({
            resolved,
            emergency: false,
            triageStatus: "UNCERTAIN" as const,
            dataAsOf: services.baseDate
          })
        };
      }
      const resolved = addConfirmationTokens(services, services.resolver.resolveMany(queries));
      const summary = resolved
        .map((item) => {
          if (item.status === "CONFIRMED") {
            return `확인 후보: ${item.query} → ${item.matchedName}`;
          }
          if (item.status === "AMBIGUOUS") {
            return `되묻기 필요: ${item.query} → ${item.candidates
              .map((candidate, index) => `${index + 1}. ${candidate.matchedName}`)
              .join(" / ")}`;
          }
          if (item.status === "OUT_OF_SCOPE") {
            return `범위 밖 입력: ${item.query} → 의약품 품목 조회 대상이 아닙니다. 식품·건강기능식품·한약 상호작용은 약사에게 확인하세요.`;
          }
          return `특정 불가: ${item.query}`;
        })
        .join("\n");
      const handoff = formatCheckHandoff(resolved);
      const text = handoff ? [handoff, "", summary].join("\n") : summary;
      const textWithNotice = sanitizeSafetyText(
        [text, "", SCOPE_NOTICE, NON_DEVICE_NOTICE, STANDARD_DISCLAIMER].join("\n")
      );
      return {
        content: [{ type: "text" as const, text: textWithNotice }],
        structuredContent: sanitizeStructuredContent({ resolved, dataAsOf: services.baseDate })
      };
    }
  );

  server.registerTool(
    "check_medication_safety",
    {
      title: "복약 안전 점검",
      description:
        `${SERVICE_NAME} checks confirmed medication entries for DUR contraindications, duplicate ingredients, and unresolved risks. When resolve_medications returns a CHECK_MEDICATION_SAFETY_INPUT text block, copy its medications array exactly, including confirmationToken; never omit, alter, or show the token to the user. Returns a read-only summary with sources, dates, and fail-closed disclaimers.`,
      annotations: readOnlyToolAnnotations("복약 안전 점검", false),
      inputSchema: {
        medications: z
          .array(
            z.object({
              itemSeq: z
                .string()
                .trim()
                .min(1)
                .max(MAX_ID_CHARS)
                .nullable()
                .optional()
                .describe("resolve_medications가 반환한 itemSeq를 그대로 전달합니다."),
              ingrCode: z
                .string()
                .trim()
                .max(MAX_ID_CHARS)
                .nullable()
                .optional()
                .describe("resolve_medications가 반환한 ingrCode를 그대로 전달합니다. 빈 문자열은 null처럼 처리됩니다."),
              status: z
                .enum(["CONFIRMED", "AMBIGUOUS", "NOT_FOUND", "OUT_OF_SCOPE"])
                .optional()
                .describe("resolve_medications가 반환한 status를 그대로 전달합니다."),
              displayName: z
                .string()
                .trim()
                .max(MAX_DISPLAY_NAME_CHARS)
                .nullable()
                .optional()
                .describe("resolve_medications가 반환한 matchedName 또는 후보명을 그대로 전달합니다."),
              confirmationToken: z
                .string()
                .min(1)
                .max(512)
                .nullable()
                .optional()
                .describe("resolve_medications가 발급한 confirmationToken을 그대로 전달합니다.")
            })
          )
          .describe("resolve_medications 결과의 itemSeq, ingrCode, status, confirmationToken은 그대로 복사하고 matchedName은 displayName으로 매핑해 전달합니다.")
          .min(1)
          .max(MAX_CHECK_MEDICATIONS),
        context: z
          .object({
            ageGroup: z
              .enum(["adult", "elderly", "child", "unknown"])
              .optional()
              .describe("사용자가 복용자의 연령대를 직접 말한 경우만 전달하고, 아니면 unknown 또는 생략합니다."),
            pregnancy: z
              .enum(["yes", "no", "unknown"])
              .optional()
              .describe("사용자가 임신 여부를 직접 말한 경우만 전달하고, 아니면 unknown 또는 생략합니다."),
            notes: z
              .string()
              .trim()
              .max(MAX_CONTEXT_NOTES_CHARS)
              .nullable()
              .optional()
              .describe("응급·과량복용 표현을 포함해 사용자가 말한 추가 문맥을 임의 추론 없이 전달합니다.")
          })
          .optional()
      },
      outputSchema: {
        verdict: z.enum(["NO_KNOWN_FINDINGS", "CAUTION", "WARN", "UNCERTAIN"]),
        dataAsOf: z.string(),
        findings: z.array(findingSchema).max(512),
        unresolved: z.array(z.string().max(MAX_DISPLAY_NAME_CHARS)).max(24),
        checkedTypes: z.array(checkedTypeSchema).max(3),
        failedTypes: z.array(failedTypeSchema).max(4),
        disclaimer: z.string().max(2048)
      }
    },
    async ({ medications, context }) => {
      const guardedMedications = requireConfirmationTokens(
        services,
        medications as MedicationForCheck[]
      );
      const result = sanitizeSafetyResult(
        await services.safety.check(guardedMedications, context as SafetyContext | undefined)
      );
      return {
        content: [{ type: "text" as const, text: formatSafetyResult(result) }],
        structuredContent: result as unknown as Record<string, unknown>
      };
    }
  );

  server.registerTool(
    "explain_medication",
    {
      title: "의약품 설명 조회",
      description:
        `${SERVICE_NAME} retrieves public e약은요 medication guidance for a single itemSeq and returns a concise explanation. Missing public data is reported as not found, not as a tool failure.`,
      annotations: readOnlyToolAnnotations("의약품 설명 조회", false),
      inputSchema: {
        itemSeq: z
          .string()
          .trim()
          .max(MAX_ID_CHARS)
          .regex(/^(?:\d{9}|DEMO-[A-Z0-9-]+)$/, "9자리 품목기준코드를 입력합니다.")
          .describe("resolve_medications가 확정한 9자리 품목기준코드")
      },
      outputSchema: {
        info: easyDrugInfoSchema.nullable(),
        found: z.boolean(),
        status: z.enum(["FOUND", "NOT_FOUND", "UPSTREAM_ERROR"]),
        error: z.string().nullable(),
        dataAsOf: z.string()
      }
    },
    async ({ itemSeq }) => {
      const result = await services.easyDrugClient.explain(itemSeq);
      const text = sanitizeSafetyText(
        [formatEasyDrugInfo(result), "", SCOPE_NOTICE, NON_DEVICE_NOTICE, STANDARD_DISCLAIMER].join(
          "\n"
        )
      );
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: sanitizeStructuredContent({
          info: result.info ? conciseEasyDrugInfo(result.info) : null,
          found: result.status === "FOUND",
          status: result.status,
          error: result.error ?? null,
          dataAsOf: services.baseDate
        }),
        ...(result.status === "UPSTREAM_ERROR" ? { isError: true } : {})
      };
    }
  );

  return server;
}

type TokenizedCandidate = MedicationCandidate & { confirmationToken: string | null };
type TokenizedResolved = Omit<ResolvedMedication, "candidates"> & {
  confirmationToken: string | null;
  candidates: TokenizedCandidate[];
};

function addConfirmationTokens(
  services: AppServices,
  resolved: ResolvedMedication[]
): TokenizedResolved[] {
  return resolved.map((item) => ({
    ...item,
    confirmationToken: confirmationTokenFor(services, item),
    candidates: item.candidates.map((candidate) => ({
      ...candidate,
      confirmationToken:
        item.status === "CONFIRMED"
          ? confirmationTokenFor(services, { ...candidate, status: "CONFIRMED" })
          : null
    }))
  }));
}

function confirmationTokenFor(
  services: AppServices,
  item: { itemSeq: string | null; ingrCode: string | null; status?: string | null }
): string | null {
  const itemSeq = nonEmptyOrNull(item.itemSeq);
  const ingrCode = nonEmptyOrNull(item.ingrCode);
  if (item.status !== "CONFIRMED" || (!itemSeq && !ingrCode)) return null;
  return services.confirmationTokens.sign({
    itemSeq,
    ingrCode,
    status: item.status ?? null
  });
}

function formatCheckHandoff(resolved: TokenizedResolved[]): string | null {
  if (
    resolved.length === 0 ||
    !resolved.every(
      (item) => item.status === "CONFIRMED" && item.confirmationToken && item.matchedName
    )
  ) {
    return null;
  }

  const input = {
    medications: resolved.map((item) => ({
      itemSeq: item.itemSeq,
      ingrCode: item.ingrCode,
      status: item.status,
      displayName: item.matchedName,
      confirmationToken: item.confirmationToken
    }))
  };

  return [
    "다음 check_medication_safety 호출에 아래 JSON의 medications를 필드 누락·변경 없이 그대로 전달하세요. confirmationToken은 사용자 답변에 표시하지 마세요.",
    CHECK_HANDOFF_START,
    JSON.stringify(input),
    CHECK_HANDOFF_END
  ].join("\n");
}

function requireConfirmationTokens(
  services: AppServices,
  medications: MedicationForCheck[]
): MedicationForCheck[] {
  return medications.map((medication) => {
    const normalized = {
      ...medication,
      itemSeq: nonEmptyOrNull(medication.itemSeq),
      ingrCode: nonEmptyOrNull(medication.ingrCode)
    };
    if (normalized.status !== "CONFIRMED") return normalized;
    const tokenOk = services.confirmationTokens.verify(normalized.confirmationToken, {
      itemSeq: normalized.itemSeq,
      ingrCode: normalized.ingrCode,
      status: medication.status ?? null
    });
    if (tokenOk) return normalized;
    return {
      status: "NOT_FOUND",
      itemSeq: null,
      ingrCode: null,
      displayName: "resolve_medications 확인 토큰 없음 또는 불일치"
    };
  });
}

function nonEmptyOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
