import test from "node:test";
import assert from "node:assert/strict";
import { publicDataItems } from "../src/utils/publicDataIntegrity.js";

test("public data item wrappers normalize every observed response shape", () => {
  const first = { id: "first" };
  const second = { id: "second" };

  assert.deepEqual(publicDataItems([first, second]), [first, second]);
  assert.deepEqual(publicDataItems({ item: [first, second] }), [first, second]);
  assert.deepEqual(publicDataItems({ item: first }), [first]);
  assert.deepEqual(publicDataItems([{ item: first }, { item: second }]), [first, second]);
  assert.deepEqual(publicDataItems([{ item: [first, second] }]), [first, second]);
  assert.deepEqual(publicDataItems(null), []);
});
