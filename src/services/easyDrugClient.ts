import { EASY_DRUG_ENDPOINT, FIELD_MAP, OFFICIAL_SOURCE_URLS, readMappedField } from "../config/schemaMap.js";
import type { AppConfig } from "../config/env.js";
import { MasterRepository } from "../repositories/masterRepository.js";
import type { EasyDrugInfo, EasyDrugLookupResult } from "../types.js";
import { publicDataItems } from "../utils/publicDataIntegrity.js";

export interface EasyDrugClient {
  explain(itemSeq: string): Promise<EasyDrugLookupResult>;
}

export class FixtureEasyDrugClient implements EasyDrugClient {
  async explain(itemSeq: string): Promise<EasyDrugLookupResult> {
    const fixtures = new Map<string, EasyDrugInfo>([
      [
        "DEMO-TYLENOL-500",
        {
          itemSeq,
          itemName: "타이레놀정500밀리그람",
          entpName: "데모제약",
          efcyQesitm: "[DEMO] 통증 및 발열 관련 설명 fixture",
          useMethodQesitm: "[DEMO] 제품 라벨과 전문가 지시를 확인하세요.",
          atpnQesitm: "[DEMO] 중복 성분 확인이 필요할 수 있습니다."
        }
      ]
    ]);
    const info = fixtures.get(itemSeq) ?? null;
    return info ? { status: "FOUND", info } : { status: "NOT_FOUND", info: null };
  }
}

export class RepositoryEasyDrugClient implements EasyDrugClient {
  constructor(private readonly repository: MasterRepository) {}

  async explain(itemSeq: string): Promise<EasyDrugLookupResult> {
    if (!/^\d{9}$/.test(itemSeq)) return { status: "NOT_FOUND", info: null };
    const info = this.repository.getEasyDrugInfo(itemSeq);
    return info ? { status: "FOUND", info } : { status: "NOT_FOUND", info: null };
  }
}

export class LiveEasyDrugClient implements EasyDrugClient {
  constructor(private readonly config: AppConfig) {}

  async explain(itemSeq: string): Promise<EasyDrugLookupResult> {
    if (!this.config.mfdsServiceKey) {
      return { status: "UPSTREAM_ERROR", info: null, error: "MFDS service key is not configured" };
    }
    if (!/^\d{9}$/.test(itemSeq)) {
      return { status: "NOT_FOUND", info: null };
    }

    const url = new URL(EASY_DRUG_ENDPOINT);
    url.search = new URLSearchParams({
      serviceKey: this.config.mfdsServiceKey,
      type: "json",
      itemSeq,
      pageNo: "1",
      numOfRows: "3"
    }).toString();

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.durTimeoutMs);
      const response = await fetch(url, { signal: controller.signal }).finally(() => {
        clearTimeout(timer);
      });
      if (!response.ok) {
        return { status: "UPSTREAM_ERROR", info: null, error: `e약은요 HTTP ${response.status}` };
      }

      const json = (await response.json()) as Record<string, unknown>;
      const normalized = normalizeEasyDrugResponse(json);
      if (normalized.resultCode && normalized.resultCode !== "00") {
        return {
          status: "UPSTREAM_ERROR",
          info: null,
          error: `${normalized.resultCode}: ${normalized.resultMsg ?? "e약은요 result error"}`
        };
      }
      if (normalized.items.length === 0) {
        return { status: "NOT_FOUND", info: null };
      }

      const item = normalized.items.find(
        (candidate) => readMappedField(candidate, FIELD_MAP.easyDrug.itemSeq) === itemSeq
      );
      if (!item) {
        return {
          status: "UPSTREAM_ERROR",
          info: null,
          error: "e약은요 response itemSeq did not match the request"
        };
      }

      return {
        status: "FOUND",
        info: {
          itemSeq,
          itemName: readMappedField(item, FIELD_MAP.easyDrug.itemName) ?? "제품명 정보 없음",
          entpName: readMappedField(item, FIELD_MAP.easyDrug.entpName) ?? "",
          efcyQesitm: readMappedField(item, FIELD_MAP.easyDrug.efcyQesitm) ?? undefined,
          useMethodQesitm: readMappedField(item, FIELD_MAP.easyDrug.useMethodQesitm) ?? undefined,
          atpnWarnQesitm: readMappedField(item, FIELD_MAP.easyDrug.atpnWarnQesitm) ?? undefined,
          atpnQesitm: readMappedField(item, FIELD_MAP.easyDrug.atpnQesitm) ?? undefined,
          intrcQesitm: readMappedField(item, FIELD_MAP.easyDrug.intrcQesitm) ?? undefined,
          seQesitm: readMappedField(item, FIELD_MAP.easyDrug.seQesitm) ?? undefined,
          depositMethodQesitm:
            readMappedField(item, FIELD_MAP.easyDrug.depositMethodQesitm) ?? undefined
        }
      };
    } catch (error) {
      return {
        status: "UPSTREAM_ERROR",
        info: null,
        error:
          error instanceof Error && error.name === "AbortError"
            ? "e약은요 request timeout"
            : "e약은요 request failed"
      };
    }
  }
}

export function formatEasyDrugInfo(result: EasyDrugLookupResult): string {
  if (result.status === "UPSTREAM_ERROR") {
    return `의약품 설명 조회에 실패했습니다. 잠시 후 다시 시도하거나 약사에게 확인하세요.\n출처: ${OFFICIAL_SOURCE_URLS.easyDrugInfo}`;
  }
  if (!result.info) {
    return `의약품 설명 정보가 공개 데이터에 없습니다.\n출처: ${OFFICIAL_SOURCE_URLS.easyDrugInfo}`;
  }

  const info = result.info;
  const lines = [`${info.itemName}${info.entpName ? ` / ${info.entpName}` : ""}`];
  if (info.efcyQesitm) lines.push(`효능: ${conciseField(info.efcyQesitm, 220)}`);
  if (info.useMethodQesitm) lines.push(`사용법: ${conciseField(info.useMethodQesitm, 240)}`);
  const caution = [info.atpnWarnQesitm, info.atpnQesitm].filter(Boolean).join(" ");
  if (caution) lines.push(`핵심 주의: ${conciseField(caution, 360)}`);
  if (info.intrcQesitm) lines.push(`상호작용: ${conciseField(info.intrcQesitm, 220)}`);
  lines.push(`출처: ${OFFICIAL_SOURCE_URLS.easyDrugInfo}`);
  return lines.join("\n");
}

export function conciseEasyDrugInfo(info: EasyDrugInfo): EasyDrugInfo {
  return {
    itemSeq: info.itemSeq,
    itemName: conciseField(info.itemName, 160),
    entpName: conciseField(info.entpName, 120),
    efcyQesitm: optionalConciseField(info.efcyQesitm, 220),
    useMethodQesitm: optionalConciseField(info.useMethodQesitm, 240),
    atpnWarnQesitm: optionalConciseField(info.atpnWarnQesitm, 240),
    atpnQesitm: optionalConciseField(info.atpnQesitm, 360),
    intrcQesitm: optionalConciseField(info.intrcQesitm, 220),
    seQesitm: optionalConciseField(info.seQesitm, 220),
    depositMethodQesitm: optionalConciseField(info.depositMethodQesitm, 160)
  };
}

function optionalConciseField(value: string | undefined, maxChars: number): string | undefined {
  return value ? conciseField(value, maxChars) : undefined;
}

function conciseField(value: string, maxChars = 320): string {
  const plain = value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= maxChars) return plain;
  const prefix = plain.slice(0, maxChars + 1);
  const sentenceEnd = Math.max(
    prefix.lastIndexOf("."),
    prefix.lastIndexOf("다."),
    prefix.lastIndexOf("요."),
    prefix.lastIndexOf(";")
  );
  const cut = sentenceEnd >= Math.floor(maxChars * 0.6) ? sentenceEnd + 1 : maxChars;
  return `${plain.slice(0, cut).trim()}…`;
}

function normalizeEasyDrugResponse(json: Record<string, unknown>): {
  resultCode: string | null;
  resultMsg: string | null;
  items: Record<string, unknown>[];
} {
  const response = (json.response ?? json) as Record<string, unknown>;
  const header = (response.header ?? {}) as Record<string, unknown>;
  const body = (response.body ?? {}) as Record<string, unknown>;
  return {
    resultCode: header.resultCode == null ? null : String(header.resultCode),
    resultMsg: header.resultMsg == null ? null : String(header.resultMsg),
    items: publicDataItems(body.items)
  };
}
