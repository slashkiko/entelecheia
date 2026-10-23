import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { discounted } from "../src/price.mjs";

// 正解表。検査は base のものを差し込むので、head で書き換えても効かない。
const vectors = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));

for (const { price, rate, expected } of vectors) {
  test(`discounted(${price}, ${rate}) is ${expected}`, () => {
    assert.strictEqual(discounted(price, rate), expected);
  });
}
