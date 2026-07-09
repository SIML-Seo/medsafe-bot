import { EASY_DRUG_ENDPOINT, FIELD_MAP, OFFICIAL_SOURCE_URLS, readMappedField } from "../config/schemaMap.js";
import type { AppConfig } from "../config/env.js";
import type { EasyDrugInfo } from "../types.js";

export interface EasyDrugClient {
  explain(itemSeq: string): Promise<EasyDrugInfo | null>;
}

export class FixtureEasyDrugClient implements EasyDrugClient {
  async explain(itemSeq: string): Promise<EasyDrugInfo | null> {
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
    return fixtures.get(itemSeq) ?? null;
  }
}

export class LiveEasyDrugClient implements EasyDrugClient {
  constructor(private readonly config: AppConfig) {}

  async explain(itemSeq: string): Promise<EasyDrugInfo | null> {
    if (!this.config.mfdsServiceKey) return null;

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
      if (!response.ok) return null;

      const json = (await response.json()) as Record<string, unknown>;
      const responseBody = (json.response ?? json) as Record<string, unknown>;
      const body = (responseBody.body ?? {}) as Record<string, unknown>;
      const itemsWrapper = (body.items ?? {}) as Record<string, unknown> | Record<string, unknown>[];
      const rawItems = Array.isArray(itemsWrapper)
        ? itemsWrapper
        : ((itemsWrapper as Record<string, unknown>).item ?? []);
      const item = (Array.isArray(rawItems) ? rawItems[0] : rawItems) as Record<string, unknown> | undefined;
      if (!item) return null;

      return {
        itemSeq: readMappedField(item, FIELD_MAP.easyDrug.itemSeq) ?? itemSeq,
        itemName: readMappedField(item, FIELD_MAP.easyDrug.itemName) ?? "제품명 정보 없음",
        entpName: readMappedField(item, FIELD_MAP.easyDrug.entpName) ?? "",
        efcyQesitm: readMappedField(item, FIELD_MAP.easyDrug.efcyQesitm) ?? undefined,
        useMethodQesitm: readMappedField(item, FIELD_MAP.easyDrug.useMethodQesitm) ?? undefined,
        atpnWarnQesitm: readMappedField(item, FIELD_MAP.easyDrug.atpnWarnQesitm) ?? undefined,
        atpnQesitm: readMappedField(item, FIELD_MAP.easyDrug.atpnQesitm) ?? undefined,
        intrcQesitm: readMappedField(item, FIELD_MAP.easyDrug.intrcQesitm) ?? undefined,
        seQesitm: readMappedField(item, FIELD_MAP.easyDrug.seQesitm) ?? undefined,
        depositMethodQesitm: readMappedField(item, FIELD_MAP.easyDrug.depositMethodQesitm) ?? undefined
      };
    } catch {
      return null;
    }
  }
}

export function formatEasyDrugInfo(info: EasyDrugInfo | null): string {
  if (!info) {
    return `의약품 설명 정보를 찾지 못했습니다.\n출처: ${OFFICIAL_SOURCE_URLS.easyDrugInfo}`;
  }

  const lines = [`${info.itemName}${info.entpName ? ` / ${info.entpName}` : ""}`];
  if (info.efcyQesitm) lines.push(`효능: ${info.efcyQesitm}`);
  if (info.useMethodQesitm) lines.push(`사용법: ${info.useMethodQesitm}`);
  if (info.atpnWarnQesitm) lines.push(`경고: ${info.atpnWarnQesitm}`);
  if (info.atpnQesitm) lines.push(`주의: ${info.atpnQesitm}`);
  if (info.intrcQesitm) lines.push(`상호작용: ${info.intrcQesitm}`);
  if (info.seQesitm) lines.push(`부작용: ${info.seQesitm}`);
  if (info.depositMethodQesitm) lines.push(`보관법: ${info.depositMethodQesitm}`);
  lines.push(`출처: ${OFFICIAL_SOURCE_URLS.easyDrugInfo}`);
  return lines.join("\n");
}
