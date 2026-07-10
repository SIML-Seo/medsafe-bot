import {
  DUR_PRODUCT_BASE_URL,
  DUR_OPERATION_MAP,
  FIELD_MAP,
  OFFICIAL_SOURCE_URLS,
  readMappedField
} from "../config/schemaMap.js";
import type { AppConfig } from "../config/env.js";
import { MasterRepository } from "../repositories/masterRepository.js";
import type { DurCheckResult, DurContraindication } from "../types.js";
import { normalizeIngredientName } from "../utils/text.js";
import {
  publicDataItems,
  publicDataPageFingerprint,
  publicDataRowFingerprint
} from "../utils/publicDataIntegrity.js";
import { isDeletedDurRow, normalizedDurDate } from "../utils/durIngredient.js";

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
            dateBasis: "FIXTURE_DATE",
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
            dateBasis: "FIXTURE_DATE",
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

export class RepositoryDurClient implements DurClient {
  constructor(
    private readonly repository: MasterRepository,
    private readonly config: AppConfig
  ) {}

  async selfTest(): Promise<{ ok: boolean; message: string }> {
    const itemSeq = this.config.liveSelfTestItemSeq;
    if (!itemSeq) {
      return { ok: false, message: "LIVE_SELF_TEST_ITEM_SEQ is required for snapshot verification" };
    }
    const result = await this.checkUsjntTaboo(itemSeq);
    if (!result.ok) return { ok: false, message: result.error ?? "DUR snapshot self-test failed" };
    if (this.config.liveSelfTestExpectContraindication && result.contraindications.length === 0) {
      return {
        ok: false,
        message: "DUR snapshot contains no contraindication for the configured red-case itemSeq"
      };
    }
    if (
      this.config.liveSelfTestTargetItemSeq &&
      !result.contraindications.some(
        (finding) => finding.targetItemSeq === this.config.liveSelfTestTargetItemSeq
      )
    ) {
      return {
        ok: false,
        message: "DUR snapshot does not contain the configured red-case target itemSeq"
      };
    }
    return { ok: true, message: "local DUR snapshot verified" };
  }

  async checkUsjntTaboo(itemSeq: string): Promise<DurCheckResult> {
    const snapshot = this.repository.getDurSnapshot(itemSeq);
    if (!snapshot || !snapshot.complete) {
      return {
        ok: false,
        type: "USJNT_TABOO",
        contraindications: [],
        failedType: "USJNT_TABOO",
        error: snapshot
          ? `DUR snapshot is incomplete for ${itemSeq}`
          : `DUR snapshot is unavailable for ${itemSeq}`
      };
    }
    return {
      ok: true,
      type: "USJNT_TABOO",
      contraindications: snapshot.contraindications
    };
  }
}

export class LiveDurClient implements DurClient {
  private readonly usjntCache = new Map<string, { expiresAt: number; result: DurCheckResult }>();
  private readonly inFlight = new Map<string, Promise<DurCheckResult>>();

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
    if (
      this.config.liveSelfTestTargetItemSeq &&
      !result.contraindications.some(
        (finding) => finding.targetItemSeq === this.config.liveSelfTestTargetItemSeq
      )
    ) {
      return {
        ok: false,
        message: "DUR self-test did not return the configured target itemSeq"
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
      this.usjntCache.delete(itemSeq);
      this.usjntCache.set(itemSeq, cached);
      return cached.result;
    }
    if (cached) this.usjntCache.delete(itemSeq);

    const inFlightKey = `${itemSeq}:${timeoutMs}`;
    const existingRequest = this.inFlight.get(inFlightKey);
    if (existingRequest) return existingRequest;

    const request = this.fetchUsjntTaboo(itemSeq, timeoutMs).finally(() => {
      this.inFlight.delete(inFlightKey);
    });
    this.inFlight.set(inFlightKey, request);
    return request;
  }

  private async fetchUsjntTaboo(itemSeq: string, timeoutMs: number): Promise<DurCheckResult> {
    const operation = DUR_OPERATION_MAP.USJNT_TABOO.operationName;
    try {
      const result = await this.fetchAllPages(
        `${DUR_PRODUCT_BASE_URL}/${operation}`,
        itemSeq,
        timeoutMs
      );
      if (result.ok) this.cacheUsjntResult(itemSeq, result);
      return result;
    } catch (error) {
      return {
        ok: false,
        type: "USJNT_TABOO",
        contraindications: [],
        failedType: "USJNT_TABOO",
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private cacheUsjntResult(itemSeq: string, result: DurCheckResult): void {
    if (this.config.durCacheTtlMs <= 0) return;
    const now = Date.now();
    for (const [key, cached] of this.usjntCache) {
      if (cached.expiresAt <= now) this.usjntCache.delete(key);
    }
    this.usjntCache.delete(itemSeq);
    while (this.usjntCache.size >= this.config.durCacheMaxEntries) {
      const oldest = this.usjntCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.usjntCache.delete(oldest);
    }
    this.usjntCache.set(itemSeq, {
      expiresAt: now + this.config.durCacheTtlMs,
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
    const numOfRows = 500;
    const deadline = Date.now() + timeoutMs;
    let pageNo = 1;
    let totalCount: number | null = null;
    let receivedRows = 0;
    const pageFingerprints = new Set<string>();
    const rowFingerprints = new Set<string>();

    while (true) {
      if (pageNo > this.config.durMaxPages) {
        return {
          ok: false,
          type: "USJNT_TABOO",
          contraindications,
          failedType: "USJNT_TABOO",
          error: `DUR pagination exceeded ${this.config.durMaxPages} pages`
        };
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return {
          ok: false,
          type: "USJNT_TABOO",
          contraindications,
          failedType: "USJNT_TABOO",
          error: "DUR request deadline exceeded"
        };
      }
      const url = new URL(endpoint);
      url.search = new URLSearchParams({
        serviceKey: this.config.mfdsServiceKey ?? "",
        type: "json",
        pageNo: String(pageNo),
        numOfRows: String(numOfRows),
        itemSeq
      }).toString();

      const response = await this.fetchWithRetry(url, remainingMs);

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

      const pageTotalCount = wrapped.totalCount;
      if (pageTotalCount === null || !Number.isFinite(pageTotalCount) || pageTotalCount < 0) {
        return {
          ok: false,
          type: "USJNT_TABOO",
          contraindications,
          failedType: "USJNT_TABOO",
          error: "DUR totalCount is missing or invalid"
        };
      }
      if (totalCount !== null && totalCount !== pageTotalCount) {
        return {
          ok: false,
          type: "USJNT_TABOO",
          contraindications,
          failedType: "USJNT_TABOO",
          error: "DUR totalCount changed during pagination"
        };
      }
      totalCount = pageTotalCount;
      if (Math.ceil(totalCount / numOfRows) > this.config.durMaxPages) {
        return {
          ok: false,
          type: "USJNT_TABOO",
          contraindications,
          failedType: "USJNT_TABOO",
          error: `DUR pagination exceeded ${this.config.durMaxPages} pages`
        };
      }
      const pageFingerprint = publicDataPageFingerprint(wrapped.items);
      if (pageFingerprints.has(pageFingerprint)) {
        return {
          ok: false,
          type: "USJNT_TABOO",
          contraindications,
          failedType: "USJNT_TABOO",
          error: "DUR pagination repeated an identical page"
        };
      }
      pageFingerprints.add(pageFingerprint);
      for (const row of wrapped.items) {
        const rowFingerprint = publicDataRowFingerprint(row);
        if (rowFingerprints.has(rowFingerprint)) {
          return {
            ok: false,
            type: "USJNT_TABOO",
            contraindications,
            failedType: "USJNT_TABOO",
            error: "DUR pagination returned duplicate rows"
          };
        }
        rowFingerprints.add(rowFingerprint);
        if (isDeletedDurRow(row)) continue;
        const sourceItemSeq = readMappedField(row, FIELD_MAP.durUsjntTaboo.sourceItemSeq);
        if (!sourceItemSeq) unresolvedFields.add("sourceItemSeq");
        if (sourceItemSeq && sourceItemSeq !== itemSeq) {
          return {
            ok: false,
            type: "USJNT_TABOO",
            contraindications,
            failedType: "USJNT_TABOO",
            error: `DUR response itemSeq mismatch: requested ${itemSeq}, received ${sourceItemSeq}`
          };
        }
        const targetItemSeq = readMappedField(row, FIELD_MAP.durUsjntTaboo.targetItemSeq);
        const targetIngredientCode = readMappedField(
          row,
          FIELD_MAP.durUsjntTaboo.targetIngredientCode
        );
        const targetIngredientName = readMappedField(
          row,
          FIELD_MAP.durUsjntTaboo.targetIngredientName
        );
        const reason = readMappedField(row, FIELD_MAP.durUsjntTaboo.reason);
        if (!targetItemSeq && !targetIngredientCode) unresolvedFields.add("targetItemSeq");
        if (!reason) unresolvedFields.add("reason");
        const rawSourceBaseDate = readMappedField(row, FIELD_MAP.durUsjntTaboo.baseDate);
        const sourceBaseDate = normalizedDurDate(rawSourceBaseDate ?? "");
        if (rawSourceBaseDate && !sourceBaseDate) unresolvedFields.add("baseDate");
        contraindications.push({
          sourceItemSeq: itemSeq,
          targetItemSeq,
          targetIngredientCode,
          targetIngredientName,
          targetIngredientKey: targetIngredientName
            ? normalizeIngredientName(targetIngredientName)
            : null,
          reason: reason ?? "DUR 병용금기 응답 필드 미해결",
          baseDate: sourceBaseDate ?? this.config.durBaseDate,
          dateBasis: sourceBaseDate ? "SOURCE_DATE" : "SNAPSHOT_FETCHED_AT",
          source: OFFICIAL_SOURCE_URLS.durProductInfo
        });
      }
      receivedRows += wrapped.items.length;
      if (receivedRows >= totalCount) break;
      if (wrapped.items.length === 0) {
        return {
          ok: false,
          type: "USJNT_TABOO",
          contraindications,
          failedType: "USJNT_TABOO",
          error: "DUR pagination ended before totalCount rows were received"
        };
      }
      pageNo += 1;
    }

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

    if (rowFingerprints.size !== totalCount) {
      return {
        ok: false,
        type: "USJNT_TABOO",
        contraindications,
        failedType: "USJNT_TABOO",
        error: "DUR distinct row count does not match totalCount"
      };
    }

    return { ok: true, type: "USJNT_TABOO", contraindications };
  }

  private async fetchWithRetry(url: URL, timeoutMs: number): Promise<Response> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.config.durMaxRetries; attempt += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error("DUR request deadline exceeded");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remainingMs);
      try {
        const response = await fetch(url, { signal: controller.signal });
        if ((response.status === 429 || response.status >= 500) && attempt < this.config.durMaxRetries) {
          const waitMs = retryDelayMs(response, attempt);
          if (Date.now() + waitMs >= deadline) throw new Error("DUR retry exceeds request deadline");
          await delay(waitMs);
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

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(5000, seconds * 1000);
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.min(5000, Math.max(0, dateMs - Date.now()));
  }
  return backoffMs(attempt);
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
  const items = publicDataItems(body.items);

  return {
    header: header
      ? {
          resultCode: header.resultCode == null ? undefined : String(header.resultCode),
          resultMsg: header.resultMsg == null ? undefined : String(header.resultMsg)
        }
      : null,
    items,
    totalCount: body.totalCount == null ? null : Number(body.totalCount)
  };
}
