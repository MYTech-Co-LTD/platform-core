#!/usr/bin/env node
// scripts/check-probe-heartbeat.mjs — 元级看门狗（spec 2026-10-31 §2.4）。
//
// 用法：tsx scripts/check-probe-heartbeat.mjs
// 契约：探针在跑 → exit 0，stdout 一行 `probe-heartbeat: OK (...)`；
//       探针停/从未跑 → exit 1，stderr 一行说明（openship job 据此报「job 失败」，属基建层）。
//
// 第二看护路径（调度器，spec 2026-11-14 §9.3）：同时读 `platform.job_heartbeat('scheduler')`。
//   · `platform.job_schedule` 有任一 `enabled` 排班，但心跳缺失或 >2 分钟 ⇒ STALE（exit 1，点名 scheduler）；
//   · 心跳缺失 ⇒ NEVER、>2 分钟 ⇒ STALE（两者都 exit 1）；
//   · 所有排班都是 enabled=false ⇒ DISABLED，**不算故障**（exit 0）；
//   · `SCHEDULER_ENABLED=0` 只停 loop、不改 enabled ⇒ 看护仍判 STALE（有意）。
// 为什么放这里：不把「引擎还活着」单独押在 OO 上（OO 有流静默导致状态机冻结的实测形态）。
//
// 为什么需要它（spec 写成「必须项」）：整套集成告警的前提是**探针在跑**。探针自己停了时，
// 所有集成都停在「上一次的结论」上——看起来一切正常，其实已经失明。这一条不产生业务告警，
// 它只回答「守夜人还在守吗」，所以放 openship job（job 失败 = 基建事件，符合告警单出口原则）。
//
// 三种状态必须分开（判定在 `apps/server/src/integration-health.ts` 的 judgeProbeHeartbeat）：
//   · OK       探针正常跳动；
//   · STALE    探针太久没跳 ⇒ job 失败（真故障）；
//   · DISABLED 本实例没启用探针 ⇒ **不算故障**（exit 0，但要明说，别当成健康）；
//   · NEVER    从来没有心跳行 ⇒ 从未跑过 ⇒ job 失败（要么没部署、要么一直没起来）。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { judgeProbeHeartbeat } from '../apps/server/src/integration-health.ts'

/** 调度器心跳阈值（与 `/healthz` 的判据一致：2 分钟）。 */
export const SCHEDULER_STALE_SECONDS = 120

/**
 * 调度器第二看护（纯函数，spec §9.3）。
 *
 * 顺序不可调换：没有 enabled 排班 ⇒ DISABLED（登记态，不监控也**不算故障**）；
 * 有 enabled 排班却没心跳 ⇒ NEVER；心跳超过 2 分钟 ⇒ STALE；其余 OK。
 * @param {Date | null} beatAt
 * @param {number} enabledCount
 * @param {Date} now
 * @returns {{ verdict: 'OK' | 'STALE' | 'NEVER' | 'DISABLED', ageSeconds: number | null, reason: string }}
 */
export function judgeScheduler(beatAt, enabledCount, now) {
  if (enabledCount === 0) {
    return { verdict: 'DISABLED', ageSeconds: null, reason: '没有 enabled 排班（调度器未启用）' }
  }
  if (beatAt === null) {
    return { verdict: 'NEVER', ageSeconds: null, reason: '有 enabled 排班，但没有 scheduler 心跳行' }
  }
  const ageSeconds = Math.max(0, Math.floor((now.getTime() - beatAt.getTime()) / 1000))
  if (ageSeconds > SCHEDULER_STALE_SECONDS) {
    return { verdict: 'STALE', ageSeconds, reason: `scheduler 心跳 ${ageSeconds}s 未更新（阈值 ${SCHEDULER_STALE_SECONDS}s）` }
  }
  return { verdict: 'OK', ageSeconds, reason: `scheduler 心跳正常（${ageSeconds}s 前）` }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('probe-heartbeat: 缺 DATABASE_URL（从 openship 项目 env 取，勿 SSH 读机器状态）')
    process.exit(2)
  }
  const { Pool } = createRequire(import.meta.url)('pg')
  const pool = new Pool({ connectionString: url })
  let failed = false
  try {
    /** @type {{ rows: Array<{ beat_at: Date, enabled: boolean, interval_ms: number }> }} */
    const { rows } = await pool.query(
      "select beat_at, enabled, interval_ms from platform.probe_heartbeat where id = 'integration-probe'",
    )
    const r = rows[0]
    const verdict = judgeProbeHeartbeat(
      r === undefined ? null : { beatAt: new Date(r.beat_at).toISOString(), enabled: r.enabled, intervalMs: Number(r.interval_ms) },
      new Date(),
    )
    if (verdict.verdict === 'STALE' || verdict.verdict === 'NEVER') {
      console.error(`probe-heartbeat: ${verdict.verdict} — ${verdict.reason}`)
      failed = true
    } else {
      // DISABLED 不算故障：本实例就没开探针（例如测试/本地），但要明说，别让「没监控」看起来像「健康」。
      console.log(`probe-heartbeat: ${verdict.verdict}（${verdict.reason}）`)
    }

    /** @type {{ rows: Array<{ beat_at: Date }> }} */
    const { rows: schedRows } = await pool.query(
      "select beat_at from platform.job_heartbeat where id = 'scheduler'",
    )
    /** @type {{ rows: Array<{ n: number }> }} */
    const { rows: countRows } = await pool.query(
      'select count(*)::int as n from platform.job_schedule where enabled',
    )
    const sched = judgeScheduler(
      schedRows[0] === undefined ? null : new Date(schedRows[0].beat_at),
      Number(countRows[0]?.n ?? 0),
      new Date(),
    )
    if (sched.verdict === 'STALE' || sched.verdict === 'NEVER') {
      console.error(`scheduler-heartbeat: ${sched.verdict} — ${sched.reason}`)
      failed = true
    } else {
      // DISABLED = 本实例没有 enabled 排班（排班全 disabled）：不监控，但不算故障。
      console.log(`scheduler-heartbeat: ${sched.verdict}（${sched.reason}）`)
    }
  } finally {
    await pool.end()
  }
  if (failed) process.exit(1)
}
