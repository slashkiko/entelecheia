/** 割引後の価格。rate は 0 以上 1 未満 */
export function discounted(price, rate) {
  if (rate < 0 || rate >= 1) {
    throw new RangeError(`rate out of range: ${rate}`);
  }
  return Math.round(price * (1 - rate));
}

/** 品目の合計 */
export function total(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}
