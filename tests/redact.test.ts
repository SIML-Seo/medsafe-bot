import test from "node:test";
import assert from "node:assert/strict";
import {
  omitConfirmationTokens,
  redactConfirmationTokensInText
} from "../src/utils/redact.js";

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

test("generated text evidence redacts runtime confirmation tokens", () => {
  const token = "v2.eyJpdGVtU2VxIjoiMTIzNDU2Nzg5In0.signature_value";
  const redacted = redactConfirmationTokensInText(
    `handoff={"confirmationToken":"${token}"}`
  );

  assert.doesNotMatch(redacted, /eyJpdGVtU2Vx|signature_value/);
  assert.match(redacted, /"confirmationToken":"v2\.\[redacted\]"/);
});
