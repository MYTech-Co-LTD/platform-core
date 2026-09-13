// subscription-source.ts — Casdoor 订阅源的纯逻辑（spec D5）：过滤口径 + TTL 缓存。
// 口径三件套：mod- 前缀 / state=Active / 未过 EndTime；外来订阅（非 mod-，如支付流产生的
// plan-pro）一律忽略——容忍共存，不误伤他人数据。enabledFor 的 casdoor 分支消费本文件。
import type { CasdoorSubscription } from '@platform/auth-core'

/** 订阅列表 → 租户可见模块 id 集合（只回 loadedIds 内的，磁盘上已删的模块不进集合） */
export function enabledFromSubscriptions(
  subs: CasdoorSubscription[],
  loadedIds: Iterable<string>,
  now: number,
): Set<string> {
  const loaded = new Set(loadedIds)
  const out = new Set<string>()
  for (const s of subs) {
    if (!s.plan.startsWith('mod-')) continue
    const id = s.plan.slice(4)
    if (!loaded.has(id)) continue
    if (s.state !== 'Active') continue
    if (!s.endTime || Date.parse(s.endTime) < now) continue
    out.add(id)
  }
  return out
}

/** 按 org 的 TTL 缓存（改订阅 → 菜单最长延迟 = TTL，spec §6.3 已接受该窗口） */
export class SubscriptionCache {
  readonly #ttlMs: number
  readonly #now: () => number
  readonly #store = new Map<string, { at: number; value: Promise<Set<string>> }>()

  constructor(opts: { ttlMs: number; now?: () => number }) {
    this.#ttlMs = opts.ttlMs
    this.#now = opts.now ?? Date.now
  }

  get(org: string, load: () => Promise<Set<string>>): Promise<Set<string>> {
    const hit = this.#store.get(org)
    if (hit && this.#now() - hit.at < this.#ttlMs) return hit.value
    const value = load()
    this.#store.set(org, { at: this.#now(), value })
    return value
  }
}
