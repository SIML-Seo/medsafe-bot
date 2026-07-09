import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { AppServices } from "./app.js";
import type {
  MedicationCandidate,
  MedicationForCheck,
  ResolvedMedication,
  SafetyContext
} from "./types.js";
import { formatEasyDrugInfo } from "./services/easyDrugClient.js";
import {
  emergencyResult,
  formatSafetyResult,
  hasEmergencySignal,
  NON_DEVICE_NOTICE,
  sanitizeSafetyResult,
  sanitizeSafetyText,
  sanitizeStructuredContent,
  SCOPE_NOTICE,
  STANDARD_DISCLAIMER
} from "./services/safetyPolicy.js";

const MAX_RESOLVE_QUERIES = 8;
const MAX_QUERY_CHARS = 80;
const MAX_CHECK_MEDICATIONS = 12;
const MAX_ID_CHARS = 80;
const MAX_DISPLAY_NAME_CHARS = 100;
const MAX_CONTEXT_NOTES_CHARS = 500;

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

const findingSchema = z.object({
  type: z.string(),
  origin: z.string(),
  level: z.string(),
  a: z.string(),
  b: z.string().nullable(),
  reason: z.string(),
  source: z.string(),
  baseDate: z.string()
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
        `${SERVICE_NAME} maps user-provided medication product names or ingredients to standard itemSeq and ingredient codes. It returns confirmation candidates for ambiguous names and does not make a safety verdict.`,
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
        emergency: z.boolean().optional()
      }
    },
    async ({ queries }) => {
      if (hasEmergencySignal(queries.join(" "))) {
        const result = emergencyResult(process.env.DUR_BASE_DATE ?? "2026-07-01");
        return {
          content: [{ type: "text" as const, text: formatSafetyResult(result) }],
          structuredContent: { resolved: [], emergency: true }
        };
      }
      const resolved = addConfirmationTokens(services, services.resolver.resolveMany(queries));
      const text = resolved
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
      const textWithNotice = sanitizeSafetyText(
        [text, "", SCOPE_NOTICE, NON_DEVICE_NOTICE, STANDARD_DISCLAIMER].join("\n")
      );
      return {
        content: [{ type: "text" as const, text: textWithNotice }],
        structuredContent: sanitizeStructuredContent({ resolved })
      };
    }
  );

  server.registerTool(
    "check_medication_safety",
    {
      title: "복약 안전 점검",
      description:
        `${SERVICE_NAME} checks confirmed medication entries copied from resolve_medications for DUR contraindications, duplicate ingredients, and unresolved risk states. It returns a read-only safety summary with sources, dates, and fail-closed disclaimers.`,
      annotations: readOnlyToolAnnotations("복약 안전 점검", true),
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
          .describe("반드시 resolve_medications 결과의 itemSeq, ingrCode, status, displayName, confirmationToken을 필드명 그대로 복사해 전달합니다.")
          .min(1)
          .max(MAX_CHECK_MEDICATIONS),
        context: z
          .object({
            subjectIsUser: z.boolean().optional(),
            ageGroup: z.enum(["adult", "elderly", "child", "unknown"]).optional(),
            pregnancy: z.enum(["yes", "no", "unknown"]).optional(),
            notes: z.string().trim().max(MAX_CONTEXT_NOTES_CHARS).nullable().optional()
          })
          .optional()
      },
      outputSchema: {
        verdict: z.enum(["NO_KNOWN_FINDINGS", "CAUTION", "WARN", "UNCERTAIN"]),
        findings: z.array(findingSchema),
        unresolved: z.array(z.string()),
        checkedTypes: z.array(z.string()),
        failedTypes: z.array(z.string()),
        disclaimer: z.string()
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
      annotations: readOnlyToolAnnotations("의약품 설명 조회", true),
      inputSchema: {
        itemSeq: z.string().trim().min(1).max(MAX_ID_CHARS).describe("품목기준코드")
      },
      outputSchema: {
        info: z.unknown().nullable(),
        found: z.boolean()
      }
    },
    async ({ itemSeq }) => {
      const info = await services.easyDrugClient.explain(itemSeq);
      const text = sanitizeSafetyText(
        [formatEasyDrugInfo(info), "", SCOPE_NOTICE, NON_DEVICE_NOTICE, STANDARD_DISCLAIMER].join(
          "\n"
        )
      );
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: sanitizeStructuredContent({ info, found: info !== null })
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
      confirmationToken: confirmationTokenFor(services, { ...candidate, status: "CONFIRMED" })
    }))
  }));
}

function confirmationTokenFor(
  services: AppServices,
  item: { itemSeq: string | null; ingrCode: string | null; status?: string | null }
): string | null {
  const itemSeq = nonEmptyOrNull(item.itemSeq);
  const ingrCode = nonEmptyOrNull(item.ingrCode);
  if (!itemSeq && !ingrCode) return null;
  return services.confirmationTokens.sign({
    itemSeq,
    ingrCode,
    status: item.status ?? null
  });
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
