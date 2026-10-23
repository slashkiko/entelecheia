import assert from "node:assert/strict";
import { test } from "node:test";
import { discounted, total } from "../src/price.mjs";

test("discounted applies the rate", () => {
  assert.strictEqual(discounted(1000, 0.1), 900);
});

test("discounted rejects a rate of 1 or more", () => {
  assert.throws(() => discounted(1000, 1), RangeError);
});

test("total adds price times quantity", () => {
  assert.strictEqual(
    total([
      { price: 120, quantity: 2 },
      { price: 80, quantity: 1 },
    ]),
    320,
  );
});
