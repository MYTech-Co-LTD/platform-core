// single-flight.ts — 同键并发只执行一次（R4）。
//
// 为什么需要：冷缓存时同一份 SQL 会被**并发**发出多次（KPI 当前值、图表、事实包在同一帧里
// 各查一遍），服务端缓存只能接住「后到的第二次」，接不住「同时到的一批」。单飞把并发收敛成
// 一次执行，其余等待同一结果——与缓存互补：缓存管**跨请求**重复，单飞管**同请求内**并发重复。
//
// 语义：同键的调用共享同一个 Promise（含失败）；Promise settle 后立即移除键，下次重新执行。
export function singleFlight<T>(
  map: Map<string, Promise<T>>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const existing = map.get(key)
  if (existing !== undefined) return existing
  const p = fn()
  // 先挂清理再登记：即使 fn() 同步抛错，也不会留下永久的 rejected 条目。
  const tracked = p.finally(() => { map.delete(key) })
  map.set(key, tracked)
  return tracked
}
