// console/lib/format.ts — 展示层格式化。
//
// ⚠️ **不做任何金额推导**（spec §0.3：金额一律服务端算并落库，前端传来的金额永不信任）。
// 这里只把服务端已经算好的整数分**显示**成元。
/** 整数分 → `¥x.xx`；未处理（null）时给占位符——**不是 ¥0.00**，那会让人以为算过且是 0 */
export function formatMinor(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return '—'
  const sign = minor < 0 ? '-' : ''
  const abs = Math.abs(minor)
  return `${sign}¥${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}
