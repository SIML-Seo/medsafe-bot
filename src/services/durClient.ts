import {
  DUR_BASE_URLS,
  DUR_OPERATION_MAP,
  FIELD_MAP,
  OFFICIAL_SOURCE_URLS,
  readMappedField
} from "../config/schemaMap.js";
import type { AppConfig } from "../config/env.js";
import type { DurCheckResult, DurContraindication } from "../types.js";

export interface DurClient {
  checkUsjntTaboo(itemSeq: string): Promise<DurCheckResult>;
  selfTest(): Promise<{ ok: boolean; message: string }>;
}

export class FixtureDurClient implements DurClient {
  constructor(private readonly baseDate: string) {}

  async selfTest(): Promise<{ ok: boolean; message: string }> {
    return { ok: true, message: "fixture DUR client ready" };
  }

  async checkUsjntTaboo(itemSeq: string): Promise<DurCheckResult> {
    const pairs = new Map<string, DurContraindication[]>([
      [
        "DEMO-WARFARIN",
        [
          {
            sourceItemSeq: "DEMO-WARFARIN",
            targetItemSeq: "DEMO-ASPIRIN",
            targetIngredientCode: "INGR-ASPIRIN",
            reason: "[DEMO] 병용금기 fixture입니다. 실제 DUR 데이터가 아닙니다.",
            baseDate: this.baseDate,
            source: "DEMO_FIXTURE_DUR"
          }
        ]
      ],
      [
        "DEMO-ASPIRIN",
        [
          {
            sourceItemSeq: "DEMO-ASPIRIN",
            targetItemSeq: "DEMO-WARFARIN",
            targetIngredientCode: "INGR-WARFARIN",
            reason: "[DEMO] 병용금기 fixture입니다. 실제 DUR 데이터가 아닙니다.",
            baseDate: this.baseDate,
            source: "DEMO_FIXTURE_DUR"
          }
        ]
      ]
    ]);

    return {
      ok: true,
      type: "USJNT_TABOO",
      contraindications: pairs.get(itemSeq) ?? []
    };
  }
}

export class LiveDurClient implements DurClient {
  private readonly usjntCache = new Map<string, { expiresAt: number; result: DurCheckResult }>();

  constructor(private readonly config: AppConfig) {}

  async selfTest(): Promise<{ ok: boolean; message: string }> {
    if (!this.config.mfdsServiceKey) {
      return { ok: false, message: "MFDS_SERVICE_KEY is not configured" };
    }
    if (!this.config.liveSelfTestItemSeq) {
      return {
        ok: false,
        message: "LIVE_SELF_TEST_ITEM_SEQ is required in live mode to verify operation/schema with a known itemSeq"
      };
    }

    const result = await this.checkUsjntTabooWithTimeout(
      this.config.liveSelfTestItemSeq,
      this.config.durSelfTestTimeoutMs
    );
    if (!result.ok) {
      return { ok: false, message: result.error ?? "DUR self-test failed" };
    }
    if (this.config.liveSelfTestExpectContraindication && result.contraindications.length === 0) {
      return {
        ok: false,
        message: "DUR self-test returned zero contraindications for the configured red-case itemSeq"
      };
    }
    return { ok: true, message: "DUR self-test succeeded" };
  }

  async checkUsjntTaboo(itemSeq: string): Promise<DurCheckResult> {
    return this.checkUsjntTabooWithTimeout(itemSeq, this.config.durTimeoutMs);
  }

  private async checkUsjntTabooWithTimeout(
    itemSeq: string,
    timeoutMs: number
  ): Promise<DurCheckResult> {
    if (!this.config.mfdsServiceKey) {
      return {
        ok: false,
        type: "USJNT_TABOO",
        contraindications: [],
        failedType: "USJNT_TABOO",
        error: "MFDS_SERVICE_KEY is not configured"
      };
    }

    const cached = this.usjntCache.get(itemSeq);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }

    const operation = DUR_OPERATION_MAP.USJNT_TABOO.operationName;
    const errors: string[] = [];
    for (const baseUrl of DUR_BASE_URLS) {
      try {
        const result = await this.fetchAllPages(`${baseUrl}/${operation}`, itemSeq, timeoutMs);
        if (result.ok) {
          this.cacheUsjntResult(itemSeq, result);
          return result;
        }
        errors.push(result.error ?? "unknown DUR error");
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    return {
      ok: false,
      type: "USJNT_TABOO",
      contraindications: [],
      failedType: "USJNT_TABOO",
      error: errors.join(" | ") || "DUR request failed"
    };
  }

  private cacheUsjntResult(itemSeq: string, result: DurCheckResult): void {
    if (this.config.durCacheTtlMs <= 0) return;
    this.usjntCache.set(itemSeq, {
      expiresAt: Date.now() + this.config.durCacheTtlMs,
      result
    });
  }

  private async fetchAllPages(
    endpoint: string,
    itemSeq: string,
    timeoutMs: number
  ): Promise<DurCheckResult> {
    const contraindications: DurContraindication[] = [];
    const unresolvedFields = new Set<string>();
    const numOfRows = 100;
    let pageNo = 1;
    let totalCount = 0;

    do {
      const url = new URL(endpoint);
      url.search = new URLSearchParams({
        serviceKey: this.config.mfdsServiceKey ?? "",
        type: "json",
        pageNo: String(pageNo),
        numOfRows: String(numOfRows),
        itemSeq
      }).toString();

      const response = await this.fetchWithRetry(url, timeoutMs);

      if (!response.ok) {
        return {
          ok: false,
          type: "USJNT_TABOO",
          contraindications: [],
          failedType: "USJNT_TABOO",
          error: `DUR HTTP ${response.status}`
        };
      }

      const json = (await response.json()) as Record<string, unknown>;
      const wrapped = normalizePublicDataResponse(json);
      const resultCode = wrapped.header?.resultCode;
      if (resultCode && resultCode !== "00") {
        return {
          ok: false,
          type: "USJNT_TABOO",
          contraindications: [],
          failedType: "USJNT_TABOO",
          error: `${resultCode}: ${wrapped.header?.resultMsg ?? "DUR result error"}`
        };
      }

      totalCount = wrapped.totalCount ?? Number.NaN;
      if (!Number.isFinite(totalCount)) {
        return {
          ok: false,
          type: "USJNT_TABOO",
          contraindications,
          failedType: "USJNT_TABOO",
          error: "DUR totalCount is missing or invalid"
        };
      }
      for (const row of wrapped.items) {
        const targetItemSeq = readMappedField(row, FIELD_MAP.durUsjntTaboo.targetItemSeq);
        const targetIngredientCode = readMappedField(
          row,
          FIELD_MAP.durUsjntTaboo.targetIngredientCode
        );
        const reason = readMappedField(row, FIELD_MAP.durUsjntTaboo.reason);
        if (!targetItemSeq && !targetIngredientCode) unresolvedFields.add("targetItemSeq");
        if (!reason) unresolvedFields.add("reason");
        contraindications.push({
          sourceItemSeq: itemSeq,
          targetItemSeq,
          targetIngredientCode,
          reason: reason ?? "DUR 병용금기 응답 필드 미해결",
          baseDate:
            readMappedField(row, FIELD_MAP.durUsjntTaboo.baseDate) ?? this.config.durBaseDate,
          source: OFFICIAL_SOURCE_URLS.durProductInfo
        });
      }

      pageNo += 1;
      if (pageNo > this.config.durMaxPages) {
        return {
          ok: false,
          type: "USJNT_TABOO",
          contraindications,
          failedType: "USJNT_TABOO",
          error: `DUR pagination exceeded ${this.config.durMaxPages} pages`
        };
      }
    } while ((pageNo - 1) * numOfRows < totalCount);

    if (unresolvedFields.size > 0) {
      return {
        ok: false,
        type: "USJNT_TABOO",
        contraindications,
        failedType: "USJNT_TABOO",
        unresolvedFields: Array.from(unresolvedFields),
        error: `unresolved DUR fields: ${Array.from(unresolvedFields).join(", ")}`
      };
    }

    return { ok: true, type: "USJNT_TABOO", contraindications };
  }

  private async fetchWithRetry(url: URL, timeoutMs: number): Promise<Response> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.config.durMaxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { signal: controller.signal });
        if ((response.status === 429 || response.status >= 500) && attempt < this.config.durMaxRetries) {
          await delay(backoffMs(attempt));
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt >= this.config.durMaxRetries) break;
        await delay(backoffMs(attempt));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "DUR request failed"));
  }
}

function backoffMs(attempt: number): number {
  return Math.min(1000, 150 * 2 ** attempt);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePublicDataResponse(json: Record<string, unknown>): {
  header: { resultCode?: string; resultMsg?: string } | null;
  items: Record<string, unknown>[];
  totalCount: number | null;
} {
  const response = (json.response ?? json) as Record<string, unknown>;
  const header = (response.header ?? null) as Record<string, unknown> | null;
  const body = (response.body ?? {}) as Record<string, unknown>;
  const itemsWrapper = (body.items ?? {}) as Record<string, unknown> | Record<string, unknown>[];
  const rawItems = Array.isArray(itemsWrapper)
    ? itemsWrapper
    : ((itemsWrapper as Record<string, unknown>).item ?? []);
  const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];

  return {
    header: header
      ? {
          resultCode: header.resultCode == null ? undefined : String(header.resultCode),
          resultMsg: header.resultMsg == null ? undefined : String(header.resultMsg)
        }
      : null,
    items: items as Record<string, unknown>[],
    totalCount: body.totalCount == null ? null : Number(body.totalCount)
  };
}
