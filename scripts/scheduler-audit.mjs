#!/usr/bin/env node
// scheduler-audit.mjs —— 调度器自身的周度体检（#2602 的复评触发判据）。
//
// 为什么需要它：`#2602`（应用单元部署没有排空栅栏 / 排空信号是全局单行）当时的结论是
// **「不建机制，先用数据触发复评」**——30 天台账里 `runner lost on worker restart` 为 0。
// 但「0 条」如果没人定期重算，就退化成一个会被忘掉的印象。这个 job 就是那条机器判据：
//
//   · 每 runner 近 N 天（缺省 30）的 `runner lost on worker restart` 条数；
//   · ≥1 ⇒ 判红探针（`scheduler_runner_lost:<runner>`）→ 桥 → 企微 ⇒ 触发 #2602 复评；
//   · 顺带记录各 runner 的成功/失败/超时分布（周度台账，趋势用）。
//
// 红线（与 `data-monitor` 一致）：**只报事实，不改任何状态**；退出码只表示「能不能算出来」。
//   · 0 = 算出来了（无论有没有红，红由探针承担）；
//   · 2 = 算不出来（缺 DATABASE_URL / 查询失败）——这种必须让 job 红，否则「审计没跑」也是静默。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { emitFailure, emitProbe } from './probe-emit.mjs'

/** 回看天数（缺省 30；复评条件是「滚动 30 天 ≥1」）。 */
export const DEFAULT_WINDOW_DAYS = 30
/** 「进程没了」这一类的 error 文本（`reapLostRunners` 写死）。 */
export const RUNNER_LOST_PREFIX = 'runner lost on worker restart'

/**
 * 汇总 → 探针行（纯函数，单测用）。
 *
 * @param {Array<{runner_id?: string|null, lost?: number|string|null, ok?: number|string|null, failed?: number|string|null, timeout?: number|string|null}>} rows
 * @param {number} windowDays
 * @returns {Array<{probe:string, check:string, verdict:'OK'|'ERR', detail:string}>}
 */
export function auditRows(rows, windowDays = DEFAULT_WINDOW_DAYS) {
  const out = []
  for (const r of rows ?? []) {
    const runner = r?.runner_id ?? '(none)'
    const lost = Number(r?.lost ?? 0)
    const ok = Number(r?.ok ?? 0)
    const failed = Number(r?.failed ?? 0)
    const timeout = Number(r?.timeout ?? 0)
    /** @type {'OK'|'ERR'} */
    const verdict = lost > 0 ? 'ERR' : 'OK'
    out.push({
      probe: 'scheduler_audit',
      check: `scheduler_runner_lost:${runner}`,
      // ≥1 就判红：这一条存在的唯一目的就是「一旦真丢过作业，就逼人回来复评 #2602」。
      verdict,
      detail: `近 ${windowDays} 天 ${runner}: runner_lost=${lost} ok=${ok} failed=${failed} timeout=${timeout}`,
    })
  }
  return out
}

/** 查询（runner 维度）。**只读**。 */
export function auditSql(windowDays = DEFAULT_WINDOW_DAYS) {
  return `select coalesce(runner_id, '(none)') as runner_id,
                 count(*) filter (where error like '${RUNNER_LOST_PREFIX}%') as lost,
                 count(*) filter (where status = 'ok') as ok,
                 count(*) filter (where status = 'failed') as failed,
                 count(*) filter (where status = 'timeout') as timeout
            from platform.job_run
           where started_at > now() - make_interval(days => ${Number(windowDays)})
           group by 1
           order by 1`
}

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('scheduler-audit: 缺 DATABASE_URL')
    return 2
  }
  const windowDays = Number(process.env.SCHEDULER_AUDIT_DAYS ?? DEFAULT_WINDOW_DAYS)
  const days = Number.isFinite(windowDays) && windowDays > 0 ? Math.trunc(windowDays) : DEFAULT_WINDOW_DAYS
  const { Pool } = createRequire(import.meta.url)('pg')
  const pool = new Pool({ connectionString: url })
  let rows
  try {
    ;({ rows } = await pool.query(auditSql(days)))
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`scheduler-audit: 查询失败 ${msg}`)
    if (process.env.NODE_ENV !== 'test') await emitFailure('scheduler_audit:run', msg)
    return 2
  } finally {
    await pool.end().catch(() => {})
  }
  const probes = auditRows(rows, days)
  for (const p of probes) console.log(`${p.verdict}  ${p.check}  ${p.detail}`)
  const red = probes.filter((p) => p.verdict === 'ERR').length
  console.log(`SCHEDULER_AUDIT_DONE runners=${probes.length} red=${red} window=${days}d`)
  // 红由探针承担（桥 → 企微）；退出码保持 0，避免「有历史红 ⇒ job 永久失败」。
  if (process.env.NODE_ENV !== 'test') {
    for (const p of probes) {
      const r = await emitProbe(p)
      if (!r.ok) console.error(`probe-emit: 未投递（${p.check}）：${r.error ?? 'unknown'}`)
    }
  }
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(await main())
}
