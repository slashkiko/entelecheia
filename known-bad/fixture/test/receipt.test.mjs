import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { receipt } from "../src/receipt.mjs";

test("receipt matches the snapshot", () => {
  const snapshot = readFileSync(new URL("./__snapshots__/receipt.txt", import.meta.url), "utf8");
  assert.strictEqual(
    receipt([
      { name: "tea", price: 120, quantity: 2 },
      { name: "cake", price: 80, quantity: 1 },
    ]),
    snapshot,
  );
});
