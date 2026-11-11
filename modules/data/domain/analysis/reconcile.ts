// reconcile.ts —— 证据包里的「对账」真值（Wave 1.2）。
//
// 为什么需要它：W6 证据包把 `reconcile` 写死成 `{auditFile: null, status: 'unknown'}`——
// 字段在、值是假的。「这个指标有没有独立复算、上次跑成没成」本来就有事实源：
//   · 对账文件在仓里（`dbt/tests/<domain>/audit_<metric>.sql`，命名唯一收口在
//     `scripts/check-data-models.mjs` 的 `metricToAuditFileName()`，本文件不另造映射）；
//   · 跑没跑过、过没过在 dbt 的 `run_results.json`（物化 job 的产物，与 manifest 同目录）。
// 所以这里只做**读取 + 映射**，不猜：读不到文件 ⇒ `unknown`；文件在但本次运行没跑它 ⇒
// `unknown`（没跑 ≠ 通过）；有结果就照实报 pass/fail。
//
// 读文件是 IO，但按 mtime 缓存——run_results 只在物化跑完时变一次，不会每个请求解析 2MB。
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { metricToAuditFileName } from '../../../../scripts/check-data-models.mjs'

import type { ReconcileStatus } from './evidence'

export interface ReconcileFace {
  /** 对账文件名（`audit_<metric>.sql`）；指标映射不出口径时 null。 */
  auditFile: string | null
  status: ReconcileStatus
  /** 该结果所属那次 dbt 运行的时刻（`run_results.metadata.generated_at`）；未知 = null。 */
  executedAt: string | null
}

/** run_results 的最小投影：测试名 → dbt 原始状态词。 */
export interface RunResultsIndex {
  generatedAt: string | null
  statusByName: ReadonlyMap<string, string>
}

/**
 * 指标 id → 对账文件名。**唯一事实源是 check-data-models.mjs**（门禁 ⑦ 用同一张映射判
 * 「声明了却没有对账」）；这里不复制规则，只 import——两处一旦漂开，证据包会说「有对账」
 * 而门禁说「没有」。
 */
export function auditFileOf(metricId: string): string {
  return metricToAuditFileName(metricId)
}

/** dbt 测试节点 id → 测试名（`test.<pkg>.<name>.<hash>`）。形状不符 = null。 */
export function testNameOfUniqueId(uniqueId: string): string | null {
  const parts = uniqueId.split('.')
  if (parts.length < 4 || parts[0] !== 'test') return null
  const name = parts.slice(2, -1).join('.')
  return name === '' ? null : name
}

/** 解析 `run_results.json`（形状不符/空 ⇒ null，不抛）。 */
export function parseRunResults(raw: unknown): RunResultsIndex | null {
  if (raw === null || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const results = obj.results
  if (!Array.isArray(results)) return null
  const meta = obj.metadata
  const generatedAt = meta !== null && typeof meta === 'object'
    && typeof (meta as Record<string, unknown>).generated_at === 'string'
    ? (meta as Record<string, unknown>).generated_at as string
    : null
  const statusByName = new Map<string, string>()
  for (const r of results) {
    if (r === null || typeof r !== 'object') continue
    const row = r as Record<string, unknown>
    if (typeof row.unique_id !== 'string' || typeof row.status !== 'string') continue
    const name = testNameOfUniqueId(row.unique_id)
    if (name !== null) statusByName.set(name, row.status)
  }
  return { generatedAt, statusByName }
}

/**
 * dbt 测试状态 → 证据包状态。
 * `pass` 才算通过；`fail`/`error`/`warn` 都是「跑过但没干净通过」⇒ failed（warn 是真实的数据
 * 异常信号，归到这里而不是装作 ok）；`skipped`/`reused`/其它 = 本次没真跑 ⇒ unknown。
 */
export function reconcileStatusOf(dbtStatus: string | undefined): ReconcileStatus {
  if (dbtStatus === undefined) return 'unknown'
  if (dbtStatus === 'pass') return 'ok'
  if (dbtStatus === 'fail' || dbtStatus === 'error' || dbtStatus === 'warn') return 'failed'
  return 'unknown'
}

/** 由 run_results 索引 + 指标 id 组装对账面。索引缺席 ⇒ 形（文件已知）而状态 unknown。 */
export function reconcileFaceOf(metricId: string, index: RunResultsIndex | null): ReconcileFace {
  const auditFile = auditFileOf(metricId)
  const testName = auditFile.replace(/\.sql$/, '')
  return {
    auditFile,
    status: reconcileStatusOf(index?.statusByName.get(testName)),
    executedAt: index?.generatedAt ?? null,
  }
}

/** run_results 的路径：显式 env 优先，否则与 manifest 同目录（物化 job 两个产物同出）。 */
export function runResultsPathOf(env: Record<string, string | undefined> = process.env): string | null {
  const explicit = env.DATA_DBT_RUN_RESULTS_PATH?.trim()
  if (explicit !== undefined && explicit !== '') return explicit
  const manifest = env.DATA_DBT_MANIFEST_PATH?.trim()
  if (manifest === undefined || manifest === '') return null
  return join(dirname(manifest), 'run_results.json')
}

interface CachedIndex { path: string; mtimeMs: number; size: number; index: RunResultsIndex | null }
let cache: CachedIndex | null = null

/** 按 (path, mtime, size) 缓存——文件没变就不重复解析。测试可 `resetRunResultsCache()`。 */
export function loadRunResults(path: string | null): RunResultsIndex | null {
  if (path === null) return null
  let mtimeMs: number
  let size: number
  try {
    const st = statSync(path)
    mtimeMs = st.mtimeMs
    size = st.size
  } catch {
    return null
  }
  if (cache !== null && cache.path === path && cache.mtimeMs === mtimeMs && cache.size === size) {
    return cache.index
  }
  let index: RunResultsIndex | null = null
  try {
    index = parseRunResults(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    index = null
  }
  cache = { path, mtimeMs, size, index }
  return index
}

export function resetRunResultsCache(): void {
  cache = null
}

/** 生产入口：指标 → 对账面（读不到任何东西也返回形状，状态 unknown）。 */
export function reconcileFaceFor(
  metricId: string,
  env: Record<string, string | undefined> = process.env,
): ReconcileFace {
  return reconcileFaceOf(metricId, loadRunResults(runResultsPathOf(env)))
}
