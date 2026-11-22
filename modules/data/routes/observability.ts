// observability.ts — 「运行观测」的只读聚合面（2026-11-22，#2681）。
//
// 与 system-map 的分工：system-map 回答「结构长什么样、链路通没通」；本文件回答
// 「**现在**跑得怎么样」——调度档位、22 条体检、湖卫生、对账差异。
//
// 数据源全部是现成产物，不新增采集：
//   · 调度   → platform.job_schedule / job_run（平台 PG，每拍更新）
//   · 体检   → data.warehouse_assertions / platform.warehouse_assertions_oo 的最近一次
//              job_run.output_tail（每 5 分钟一轮；解析 `OK|WARN|ERR <check>: <detail>` 行）
//   · 湖     → warehouse：duckdb.query(glob(...)) 的文件数与 bizday 水位（5 分钟内缓存）
//   · 物化   → warehouse：data.load_log 每个 relation 的最新一行
//   · 对账   → warehouse：staging.recon_break（verdict / attribution / diff / swap_offset）
//
// 三条纪律：
//   1. **只读**：本文件不写任何表、不触发任何 job（首版边界，#2681）。
//   2. **单块降级**：任一数据源失败只让对应块返回 error + warnings，不整体 500——
//      观测面自己挂掉时，人更需要看到「哪几块还能看」。
//   3. **缓存**：湖 glob 要枚举全史目录（~4s），30 秒内复用；调度/体检是秒级查询，同样缓存
//      以对齐前端轮询节奏。
import type { ModuleHono, RouteCtx } from './context'
import { requesterOf } from './context'
import { warehousePool } from '../domain/warehouse'

const CACHE_TTL_MS = 30_000

interface CacheEntry {
  body: unknown
  expiresAt: number
}
const cache = new Map<string, CacheEntry>()

/** 测试缝：清空缓存。 */
export function clearObservabilityCache(): void {
  cache.clear()
}

/** 体检结果的一条（check 名与 data.warehouse_assertions 逐字一致）。 */
export interface AssertionRow {
  group: 'core' | 'oo'
  check: string
  verdict: 'ok' | 'warn' | 'err'
  detail: string
  at: string
}

export interface ScheduleRow {
  key: string
  cron: string
  timezone: string
  enabled: boolean
  nextRunAt: string | null
  lastRun: {
    status: string
    at: string
    durationMs: number | null
    exitCode: number | null
    error: string | null
  } | null
  fails24h: number
}

export interface ReconSummary {
  windowDays: number
  storeDays: number
  overTol: number
  withinTol: number
  overTolDiffSum: number
  byAttribution: Array<{ attribution: string; n: number; swapOffset: number }>
  topBranches: Array<{
    systemBook: string
    bizday: string
    branchNum: number
    diff: number
    attribution: string | null
    swapOffset: number
  }>
}

export interface ObservabilityBody {
  generatedAt: string
  schedules: ScheduleRow[]
  assertions: { rows: AssertionRow[]; coreAt: string | null; ooAt: string | null }
  lake: {
    hourFiles: number | null
    hourOldest: string | null
    dayFiles: number | null
    dayNewest: string | null
    monthFiles: number | null
    sealedMax: string | null
    monthIndexMax: string | null
    error?: string
  }
  materialization: Array<{ relation: string; status: string; maxBizday: string | null; materializedAt: string }>
  recon: ReconSummary | { error: string }
  warnings: string[]
}

/** 把 assert 脚本的 output_tail 解析成结构化行（行格式：`OK <check>: <detail>`）。 */
export function parseAssertionTail(tail: string, group: 'core' | 'oo', at: string): AssertionRow[] {
  const out: AssertionRow[] = []
  for (const line of tail.split('\n')) {
    const m = /^(OK|WARN|ERR)\s+([a-z_0-9]+):\s?(.*)$/.exec(line.trim())
    if (m === null) continue
    out.push({
      group,
      check: m[2],
      verdict: m[1] === 'OK' ? 'ok' : m[1] === 'WARN' ? 'warn' : 'err',
      detail: m[3],
      at,
    })
  }
  return out
}

/**
 * 湖卫生：**从 ㉑ 断言的 detail 解析**，不在请求路径里扫对象存储。
 *
 * 为什么这么拆（2026-11-22 架构裁决）：`modules/data/**` 的 B1 门禁只许 `data.` schema，
 * `duckdb.query(...)` 属于跨 schema 函数调用、无法用 dataDependencies 声明豁免；而湖是对象
 * 存储，一次枚举 1,565 个键 ~0.4–3s —— 不该进 console 的请求路径。
 * 湖指标由 `scripts/lemeng/warehouse-assertions.mjs` 的 ㉑ 每 5 分钟产出（那里是数据面产物、
 * 不受模块 schema 门禁约束），本页只做展示。**格式契约**：detail 尾部 `k=v` 段
 * （hour_files / hour_oldest / day_files / day_newest / month_files / sealed_max / month_index）。
 */
export function lakeFromAssertions(rows: AssertionRow[]): ObservabilityBody['lake'] {
  const empty = {
    hourFiles: null, hourOldest: null, dayFiles: null, dayNewest: null,
    monthFiles: null, sealedMax: null, monthIndexMax: null,
  }
  const hy = rows.find((r) => r.check === 'lake_hygiene')
  if (hy === undefined) {
    return { ...empty, error: '体检未产出 lake_hygiene（断言脚本版本较旧或该组未运行）' }
  }
  const kv: Record<string, string> = {}
  for (const m of hy.detail.matchAll(/([a-z_]+)=([^\s|]+)/g)) kv[m[1]] = m[2]
  const num = (k: string) => (kv[k] === undefined || kv[k] === '(空)' ? null : Number(kv[k]))
  const str = (k: string) => (kv[k] === undefined || kv[k] === '(空)' ? null : kv[k])
  return {
    hourFiles: num('hour_files'),
    hourOldest: str('hour_oldest'),
    dayFiles: num('day_files'),
    dayNewest: str('day_newest'),
    monthFiles: num('month_files'),
    sealedMax: str('sealed_max'),
    monthIndexMax: str('month_index'),
  }
}

/** 取 body（命中缓存直接回）。 */
async function cached<T>(key: string, build: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const hit = cache.get(key)
  if (hit !== undefined && hit.expiresAt > now) return hit.body as T
  const body = await build()
  cache.set(key, { body, expiresAt: now + CACHE_TTL_MS })
  return body
}

/** 调度档位：每条排班 + 最近一次运行 + 24h 失败数。 */
async function loadSchedules(pool: RouteCtx['pool']): Promise<ScheduleRow[]> {
  const { rows } = await pool.query<{
    key: string; cron: string; timezone: string; enabled: boolean; next_run_at: string | null
    status: string | null; started_at: string | null; duration_ms: number | null
    exit_code: number | null; error: string | null; fails24h: string
  }>(
    `select s.key, s.cron, s.timezone, s.enabled, s.next_run_at,
            r.status, r.started_at, r.duration_ms, r.exit_code, left(coalesce(r.error, ''), 300) as error,
            (select count(*) from platform.job_run f
              where f.schedule_id = s.id
                and f.status in ('failed', 'timeout')
                and f.started_at > now() - interval '24 hours') as fails24h
       from platform.job_schedule s
       left join lateral (
         select status, started_at, duration_ms, exit_code, error
           from platform.job_run x
          where x.schedule_id = s.id
          order by x.started_at desc
          limit 1
       ) r on true
      where s.deleted_at is null
      order by s.key`,
  )
  return rows.map((r) => ({
    key: r.key,
    cron: r.cron,
    timezone: r.timezone,
    enabled: r.enabled,
    nextRunAt: r.next_run_at,
    lastRun: r.status === null
      ? null
      : {
          status: r.status,
          at: r.started_at as string,
          durationMs: r.duration_ms,
          exitCode: r.exit_code,
          error: r.error === '' ? null : r.error,
        },
    fails24h: Number(r.fails24h),
  }))
}

/** 体检：取 core / oo 两组最近一次完成的 run，解析 output_tail。 */
async function loadAssertions(pool: RouteCtx['pool']): Promise<ObservabilityBody['assertions']> {
  const keys: Array<{ key: string; group: 'core' | 'oo' }> = [
    { key: 'data.warehouse_assertions', group: 'core' },
    { key: 'platform.warehouse_assertions_oo', group: 'oo' },
  ]
  const rows: AssertionRow[] = []
  let coreAt: string | null = null
  let ooAt: string | null = null
  for (const k of keys) {
    const { rows: runs } = await pool.query<{ started_at: string; tail: string }>(
      `select r.started_at, coalesce(r.output_tail, '') as tail
         from platform.job_run r
         join platform.job_schedule s on s.id = r.schedule_id
        where s.key = $1 and r.status in ('ok', 'failed', 'timeout')
        order by r.started_at desc
        limit 1`,
      [k.key],
    )
    if (runs.length === 0) continue
    const at = runs[0].started_at
    if (k.group === 'core') coreAt = at
    else ooAt = at
    rows.push(...parseAssertionTail(runs[0].tail, k.group, at))
  }
  // 去重：同名 check 可能同时出现在两组（如 config_drift），以后跑的那组为准。
  const byCheck = new Map<string, AssertionRow>()
  for (const r of rows) {
    const prev = byCheck.get(r.check)
    if (prev === undefined || new Date(r.at) >= new Date(prev.at)) byCheck.set(r.check, r)
  }
  return { rows: [...byCheck.values()].sort((a, b) => a.check.localeCompare(b.check)), coreAt, ooAt }
}

/** 湖：文件数 + bizday 水位（glob 只读文件名，不打开 parquet）。 */
/** 物化水位：每个 relation 的最新一行（load_log 是 tick/夜档/审计共同写的账）。 */
async function loadMaterialization(wpool: ReturnType<typeof warehousePool>) {
  const { rows } = await wpool.query<{
    relation: string; status: string; max_bizday: string | null; materialized_at: string
  }>(
    `select distinct on (relation) relation, status, max_bizday, materialized_at
       from data.load_log
      order by relation, materialized_at desc`,
  )
  return rows.map((r) => ({
    relation: r.relation,
    status: r.status,
    maxBizday: r.max_bizday,
    materializedAt: r.materialized_at,
  }))
}

/** 对账汇总 + 按店 Top N（近 windowDays 天，只列超容差的）。 */
async function loadRecon(wpool: ReturnType<typeof warehousePool>, windowDays: number): Promise<ReconSummary> {
  const [{ rows: totals }, { rows: attrs }, { rows: branches }] = await Promise.all([
    wpool.query<{ verdict: string; n: string; diff_sum: string | null }>(
      `select verdict, count(*)::text as n, coalesce(round(sum(diff), 2), 0)::text as diff_sum
         from staging.recon_break
        where bizday >= (current_date - $1::int)
        group by verdict`,
      [windowDays],
    ),
    wpool.query<{ attribution: string; n: string; swap_offset: string | null }>(
      `select coalesce(attribution, '(none)') as attribution, count(*)::text as n,
              coalesce(round(sum(swap_offset), 2), 0)::text as swap_offset
         from staging.recon_break
        where bizday >= (current_date - $1::int) and verdict = 'over_tol'
        group by 1 order by count(*) desc`,
      [windowDays],
    ),
    wpool.query<{
      system_book: string; bizday: string; branch_num: number; diff: string
      attribution: string | null; swap_offset: string | null
    }>(
      `select system_book, bizday::text, branch_num, round(sum(diff), 2)::text as diff,
              max(attribution) as attribution, coalesce(round(sum(swap_offset), 2), 0)::text as swap_offset
         from staging.recon_break
        where bizday >= (current_date - $1::int) and verdict = 'over_tol'
        group by 1, 2, 3
        order by abs(sum(diff)) desc
        limit 20`,
      [windowDays],
    ),
  ])
  const pick = (v: string) => totals.find((t: { verdict: string }) => t.verdict === v)
  const over = pick('over_tol')
  const within = pick('within_tol')
  return {
    windowDays,
    storeDays: totals.reduce((s: number, t: { n: string }) => s + Number(t.n), 0),
    overTol: Number(over?.n ?? 0),
    withinTol: Number(within?.n ?? 0),
    overTolDiffSum: Number(over?.diff_sum ?? 0),
    byAttribution: attrs.map((a: { attribution: string; n: string; swap_offset: string | null }) => ({ attribution: a.attribution, n: Number(a.n), swapOffset: Number(a.swap_offset ?? 0) })),
    topBranches: branches.map((b: { system_book: string; bizday: string; branch_num: number; diff: string; attribution: string | null; swap_offset: string | null }) => ({
      systemBook: b.system_book,
      bizday: b.bizday,
      branchNum: b.branch_num,
      diff: Number(b.diff),
      attribution: b.attribution,
      swapOffset: Number(b.swap_offset ?? 0),
    })),
  }
}

/**
 * 装配「运行观测」路由。门禁由宿主按 manifest 的 api.internal 施加（本文件不写 requireScope）：
 *   GET /api/modules/data/system-map/observability            → scope data:query
 *   GET /api/modules/data/system-map/observability/recon      → scope data:query
 * @param r 模块 router
 * @param ctx 路由上下文（platform PG）
 */
export function registerObservability(r: ModuleHono, ctx: RouteCtx): void {
  r.get('/system-map/observability', async (c) => {
    if (requesterOf(c) === null) return c.json({ error: 'UNAUTHENTICATED' }, 401)
    const org = requesterOf(c)?.orgId ?? ''
    const body = await cached<ObservabilityBody>(`obs|${org}`, async () => {
      const warnings: string[] = []
      const [schedules, assertions, materialization, recon] = await Promise.all([
        loadSchedules(ctx.pool).catch((e: unknown) => {
          warnings.push(`调度：${e instanceof Error ? e.message : String(e)}`)
          return [] as ScheduleRow[]
        }),
        loadAssertions(ctx.pool).catch((e: unknown) => {
          warnings.push(`体检：${e instanceof Error ? e.message : String(e)}`)
          return { rows: [], coreAt: null, ooAt: null } as ObservabilityBody['assertions']
        }),
        Promise.resolve().then(() => loadMaterialization(warehousePool())).catch((e: unknown) => {
          warnings.push(`物化水位：${e instanceof Error ? e.message : String(e)}`)
          return [] as ObservabilityBody['materialization']
        }),
        Promise.resolve().then(() => loadRecon(warehousePool(), 7)).catch((e: unknown) => ({
          error: e instanceof Error ? e.message : String(e),
        })),
      ])
      const lake = lakeFromAssertions(assertions.rows)
      if (lake.error !== undefined) warnings.push(`湖：${lake.error}`)
      return {
        generatedAt: new Date().toISOString(),
        schedules,
        assertions,
        lake,
        materialization,
        recon,
        warnings,
      }
    })
    return c.json(body)
  })

  // 对账明细（按店下钻）：筛选 + 分页。只读。
  r.get('/system-map/observability/recon', async (c) => {
    if (requesterOf(c) === null) return c.json({ error: 'UNAUTHENTICATED' }, 401)
    const q = c.req.query()
    const book = (q.book ?? '').trim()
    const bizday = (q.bizday ?? '').trim()
    const branch = Number(q.branch ?? NaN)
    const verdict = (q.verdict ?? 'over_tol').trim()
    const limit = Math.min(Math.max(Number(q.limit ?? 100), 1), 500)
    const offset = Math.max(Number(q.offset ?? 0), 0)
    if (!/^[0-9A-Za-z_-]*$/.test(book)) return c.json({ error: 'BAD_BOOK' }, 400)
    if (bizday !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(bizday)) return c.json({ error: 'BAD_DATE' }, 400)
    if (!['over_tol', 'within_tol'].includes(verdict)) return c.json({ error: 'BAD_VERDICT' }, 400)
    try {
      const wpool = warehousePool()
      const where: string[] = ['verdict = $1']
      const params: unknown[] = [verdict]
      if (book !== '') { params.push(book); where.push(`system_book = $${params.length}`) }
      if (bizday !== '') { params.push(bizday); where.push(`bizday = $${params.length}::date`) }
      if (Number.isFinite(branch)) { params.push(branch); where.push(`branch_num = $${params.length}`) }
      const cond = where.join(' and ')
      const [{ rows }, { rows: cnt }] = await Promise.all([
        wpool.query(
          `select system_book, bizday::text, branch_num, control,
                  platform_value::text, source_value::text, diff::text,
                  tol_applied::text, bound_by, verdict, missing_side, reason_code,
                  expires_on::text, disposition, attribution, swap_offset::text, computed_at
             from staging.recon_break
            where ${cond}
            order by abs(diff) desc
            limit $${params.length + 1} offset $${params.length + 2}`,
          [...params, limit, offset],
        ),
        wpool.query<{ n: string }>(`select count(*)::text as n from staging.recon_break where ${cond}`, params),
      ])
      return c.json({ total: Number(cnt[0]?.n ?? 0), limit, offset, rows })
    } catch (e) {
      return c.json({ error: 'RECON_QUERY_FAILED', detail: e instanceof Error ? e.message : String(e) }, 500)
    }
  })
}
