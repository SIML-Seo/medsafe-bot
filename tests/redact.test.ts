import test from "node:test";
import assert from "node:assert/strict";
import { omitConfirmationTokens } from "../src/utils/redact.js";

test("remote evidence redaction removes confirmation tokens recursively", () => {
  const redacted = omitConfirmationTokens({
    confirmationToken: "top-secret",
    resolved: [
      {
        matchedName: "테스트정",
        candidates: [{ confirmationToken: "nested-secret", itemSeq: "123456789" }]
      }
    ]
  });

  const serialized = JSON.stringify(redacted);
  assert.doesNotMatch(serialized, /confirmationToken|top-secret|nested-secret/);
  assert.match(serialized, /123456789/);
});
