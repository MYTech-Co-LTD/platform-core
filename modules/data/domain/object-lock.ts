// object-lock.ts — 每对象一把锁（spec §3③）。**进程内**：单实例成立；多副本部署时退化成
// 「只有版本比对生效」（不静默，只是并发窗口变宽）——别当分布式锁用。
//
// 为什么手搓而不引 async-mutex：仓内零锁基建、零相关依赖（实测 grep），这点需求不值得引包。
// 语义：同键串行、异键并行；前一个抛错不影响后续排队者（用 settled 的链尾做锚）。
const chains = new Map<string, Promise<unknown>>()

export function withObjectLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve()
  // 前一个无论成功失败都继续排队（失败已由它自己的调用方处理）
  const run = prev.then(fn, fn)
  const tail = run.then(() => {}, () => {})
  chains.set(key, tail)
  // 链尾就是自己时清掉，避免 Map 无限增长
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key) })
  return run
}
