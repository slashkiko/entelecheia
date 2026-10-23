import { total } from "./price.mjs";

/** レシートの本文。1品目1行に数量と小計を書き、最後に合計を書く */
export function receipt(items) {
  const lines = items.map(
    (item) => `${item.name} x${item.quantity}: ${item.price * item.quantity}`,
  );
  return `${lines.join("\n")}\ntotal: ${total(items)}\n`;
}
