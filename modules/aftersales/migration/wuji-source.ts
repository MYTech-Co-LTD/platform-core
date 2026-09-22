// wuji-source.ts — 无极托管库只读 HTTP API 客户端（M2b 拉取层）。
//
// 通道口径（2026-09-15 真机实测，spec §3.3；勿凭猜改）：
//   GET {origin}/api/private/object?appid=&schemaid=&schemakey=
//   分页 page（1 起）+ size（上限 15000）；limit/skip/offset/pagesize 全部【静默忽略】——所以这里
//   只发 page/size，别画蛇添足（写了也不报错，但会让人误以为它生效）。
//   count=<任意值> → {"data":{"total":N}}；返回 {"data":[行字段平铺]}。
//   schemaid+schemakey 严格双因子，错一即 403 forbidden。
// 键值一律不落仓/不落日志（.env.example 只写键名与取法）。
export interface WujiTableCfg { origin: string; appid: string; schemaid: string; schemakey: string }
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export class WujiApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message) }
}

function buildUrl(cfg: WujiTableCfg, params: Record<string, string>): string {
  const u = new URL('/api/private/object', cfg.origin)
  u.searchParams.set('appid', cfg.appid)
  u.searchParams.set('schemaid', cfg.schemaid)
  u.searchParams.set('schemakey', cfg.schemakey)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  return u.toString()
}

function forbidden(cfg: WujiTableCfg): WujiApiError {
  return new WujiApiError(403, `wuji 403：schemaid/schemakey 双因子错一即拒（${cfg.schemaid}）——核对两键`)
}

export async function wujiCount(fetcher: FetchLike, cfg: WujiTableCfg): Promise<number> {
  const res = await fetcher(buildUrl(cfg, { count: '1' }))
  if (res.status === 403) throw forbidden(cfg)
  if (!res.ok) throw new WujiApiError(res.status, `wuji HTTP ${res.status}（${cfg.schemaid}）`)
  const body = (await res.json().catch(() => null)) as { data?: { total?: unknown } } | null
  const total = Number(body?.data?.total)
  if (!Number.isFinite(total)) {
    throw new WujiApiError(0, `wuji count 返回形状不对（${cfg.schemaid}）：${JSON.stringify(body).slice(0, 200)}`)
  }
  return total
}

/** 全量分页拉取。opts.maxRows 供拉样截断（T3 的 --sample：拉到即停）。 */
export async function wujiFetchAll(
  fetcher: FetchLike, cfg: WujiTableCfg, opts: { pageSize?: number; maxRows?: number } = {},
): Promise<Record<string, unknown>[]> {
  const pageSize = Math.min(opts.pageSize ?? 15000, 15000)   // 实测上限
  const maxRows = opts.maxRows ?? Number.MAX_SAFE_INTEGER
  const out: Record<string, unknown>[] = []
  for (let page = 1; ; page++) {
    const res = await fetcher(buildUrl(cfg, { page: String(page), size: String(pageSize) }))
    if (res.status === 403) throw forbidden(cfg)
    if (!res.ok) throw new WujiApiError(res.status, `wuji HTTP ${res.status}（${cfg.schemaid} page=${page}）`)
    const body = (await res.json().catch(() => null)) as { data?: unknown } | null
    const rows = Array.isArray(body?.data) ? (body!.data as Record<string, unknown>[]) : []
    out.push(...rows.slice(0, Math.max(0, maxRows - out.length)))
    if (out.length >= maxRows) break
    if (rows.length < pageSize) break   // 末页
  }
  return out
}

/** 对账基线（spec §3.3「窗口首尾各取一次最大 _mtime」）：对已拉取行算 max(_mtime)。
 *  字符串字典序比较——T3 拉样时核对 _mtime 形态确属可字典序比较（若非，改为 Date 解析再比）。 */
export function maxMtimeOf(rows: Record<string, unknown>[]): string | null {
  let max: string | null = null
  for (const r of rows) {
    const v = r._mtime
    if (typeof v === 'string' && v !== '' && (max === null || v > max)) max = v
  }
  return max
}
