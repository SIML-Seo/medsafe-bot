import test from "node:test";
import assert from "node:assert/strict";
import {
  CLOCK_SKEW_TOLERANCE_MS,
  timestampIsValidPastOrPresent,
  timestampWithinPastWindow
} from "../src/utils/time.js";

test("freshness rejects invalid, stale, and implausibly future timestamps", () => {
  const now = Date.parse("2026-07-10T12:00:00.000Z");
  const day = 24 * 60 * 60 * 1000;

  assert.equal(timestampWithinPastWindow("not-a-date", day, now), false);
  assert.equal(timestampWithinPastWindow("2026-07-08T11:59:59.000Z", day, now), false);
  assert.equal(timestampWithinPastWindow("2099-01-01T00:00:00.000Z", day, now), false);
  assert.equal(timestampWithinPastWindow("2026-07-10T11:00:00.000Z", day, now), true);
  assert.equal(
    timestampWithinPastWindow(
      new Date(now + CLOCK_SKEW_TOLERANCE_MS).toISOString(),
      day,
      now
    ),
    true
  );
  assert.equal(timestampIsValidPastOrPresent("2099-01-01T00:00:00.000Z", now), false);
});
