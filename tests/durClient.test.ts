import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config/env.js";
import { LiveDurClient } from "../src/services/durClient.js";

test("live DUR client accepts an exact max-page boundary", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const rows = Array.from({ length: 500 }, (_, index) => ({
    ITEM_SEQ: "123456789",
    MIXTURE_ITEM_SEQ: String(900000000 + index),
    MIXTURE_INGR_KOR_NAME: "시험성분",
    PROHBT_CONTENT: "시험 병용금기"
  }));
  try {
    globalThis.fetch = (async () => {
      calls += 1;
      const pageRows = rows.map((row, index) => ({
        ...row,
        MIXTURE_ITEM_SEQ: String(900000000 + index + (calls - 1) * 500)
      }));
      return jsonResponse({
        response: {
          header: { resultCode: "00" },
          body: { totalCount: 1000, items: { item: pageRows } }
        }
      });
    }) as typeof fetch;

    const client = new LiveDurClient(
      loadConfig({
        ...process.env,
        DATA_MODE: "live",
        MFDS_SERVICE_KEY: "test-key",
        DUR_MAX_PAGES: "2",
        DUR_TIMEOUT_MS: "5000"
      })
    );
    const result = await client.checkUsjntTaboo("123456789");
    assert.equal(result.ok, true);
    assert.equal(calls, 2);
    assert.equal(result.contraindications.length, 1000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("live DUR client rejects a repeated page even when totalCount is satisfied", async () => {
  const originalFetch = globalThis.fetch;
  const rows = Array.from({ length: 2 }, (_, index) => ({
    ITEM_SEQ: "123456789",
    MIXTURE_ITEM_SEQ: String(900000000 + index),
    PROHBT_CONTENT: "시험 병용금기"
  }));
  try {
    globalThis.fetch = (async () =>
      jsonResponse({
        response: {
          header: { resultCode: "00" },
          body: { totalCount: 4, items: { item: rows } }
        }
      })) as typeof fetch;

    const client = new LiveDurClient(
      loadConfig({
        ...process.env,
        DATA_MODE: "live",
        MFDS_SERVICE_KEY: "test-key",
        DUR_MAX_PAGES: "2"
      })
    );
    const result = await client.checkUsjntTaboo("123456789");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /repeated|duplicate/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("live DUR client coalesces concurrent cold requests", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return jsonResponse({
        response: {
          header: { resultCode: "00" },
          body: { totalCount: 0, items: { item: [] } }
        }
      });
    }) as typeof fetch;

    const client = new LiveDurClient(
      loadConfig({
        ...process.env,
        DATA_MODE: "live",
        MFDS_SERVICE_KEY: "test-key",
        DUR_TIMEOUT_MS: "1000",
        DUR_CACHE_TTL_MS: "0"
      })
    );
    const results = await Promise.all([
      client.checkUsjntTaboo("123456789"),
      client.checkUsjntTaboo("123456789"),
      client.checkUsjntTaboo("123456789")
    ]);
    assert.ok(results.every((result) => result.ok));
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("live DUR client bounds its successful-result cache", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse({
        response: {
          header: { resultCode: "00" },
          body: { totalCount: 0, items: { item: [] } }
        }
      });
    }) as typeof fetch;
    const client = new LiveDurClient(
      loadConfig({
        ...process.env,
        DATA_MODE: "live",
        MFDS_SERVICE_KEY: "test-key",
        DUR_CACHE_TTL_MS: "60000",
        DUR_CACHE_MAX_ENTRIES: "1"
      })
    );

    await client.checkUsjntTaboo("123456789");
    await client.checkUsjntTaboo("987654321");
    await client.checkUsjntTaboo("123456789");
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("live DUR client rejects rows for a different requested itemSeq", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      jsonResponse({
        response: {
          header: { resultCode: "00" },
          body: {
            totalCount: 1,
            items: {
              item: [{
                ITEM_SEQ: "987654321",
                MIXTURE_ITEM_SEQ: "111111111",
                PROHBT_CONTENT: "mismatched row"
              }]
            }
          }
        }
      })) as typeof fetch;
    const client = new LiveDurClient(
      loadConfig({ ...process.env, DATA_MODE: "live", MFDS_SERVICE_KEY: "test-key" })
    );
    const result = await client.checkUsjntTaboo("123456789");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /itemSeq mismatch/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("live product DUR lookup never falls back to the ingredient-service base URL", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input) => {
      assert.match(String(input), /DURPrdlstInfoService03\/getUsjntTabooInfoList03/);
      assert.doesNotMatch(String(input), /DURIrdntInfoService03/);
      return jsonResponse({
        response: {
          header: { resultCode: "00" },
          body: { totalCount: 0, items: { item: [] } }
        }
      });
    }) as typeof fetch;
    const client = new LiveDurClient(
      loadConfig({ ...process.env, DATA_MODE: "live", MFDS_SERVICE_KEY: "test-key" })
    );
    assert.equal((await client.checkUsjntTaboo("123456789")).ok, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("live product DUR uses notification dates, skips deleted rows, and fails closed on invalid dates", async () => {
  const originalFetch = globalThis.fetch;
  let invalidDate = false;
  try {
    globalThis.fetch = (async () =>
      jsonResponse({
        response: {
          header: { resultCode: "00" },
          body: {
            totalCount: 2,
            items: {
              item: [
                {
                  ITEM_SEQ: "123456789",
                  MIXTURE_ITEM_SEQ: "111111111",
                  PROHBT_CONTENT: "active finding",
                  NOTIFICATION_DATE: invalidDate ? "20260229" : "20090303",
                  DEL_YN: "N"
                },
                {
                  ITEM_SEQ: "123456789",
                  MIXTURE_ITEM_SEQ: "222222222",
                  PROHBT_CONTENT: "deleted finding",
                  NOTIFICATION_DATE: "20200101",
                  DEL_YN: "Y"
                }
              ]
            }
          }
        }
      })) as typeof fetch;
    const config = loadConfig({
      ...process.env,
      DATA_MODE: "live",
      MFDS_SERVICE_KEY: "test-key",
      DUR_CACHE_TTL_MS: "0"
    });
    const client = new LiveDurClient(config);
    const valid = await client.checkUsjntTaboo("123456789");
    assert.equal(valid.ok, true);
    assert.equal(valid.contraindications.length, 1);
    assert.equal(valid.contraindications[0]?.baseDate, "2009-03-03");
    assert.equal(valid.contraindications[0]?.dateBasis, "SOURCE_DATE");

    invalidDate = true;
    const invalid = await client.checkUsjntTaboo("123456789");
    assert.equal(invalid.ok, false);
    assert.ok(invalid.unresolvedFields?.includes("baseDate"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
