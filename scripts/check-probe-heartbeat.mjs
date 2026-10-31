#!/usr/bin/env node
// scripts/check-probe-heartbeat.mjs — 元级看门狗（spec 2026-10-31 §2.4）。
//
// 用法：tsx scripts/check-probe-heartbeat.mjs
// 契约：探针在跑 → exit 0，stdout 一行 `probe-heartbeat: OK (...)`；
//       探针停/从未跑 → exit 1，stderr 一行说明（openship job 据此报「job 失败」，属基建层）。
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('probe-heartbeat: 缺 DATABASE_URL（从 openship 项目 env 取，勿 SSH 读机器状态）')
    process.exit(2)
  }
  const { Pool } = createRequire(import.meta.url)('pg')
  const pool = new Pool({ connectionString: url })
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
      process.exit(1)
    }
    // DISABLED 不算故障：本实例就没开探针（例如测试/本地），但要明说，别让「没监控」看起来像「健康」。
    console.log(`probe-heartbeat: ${verdict.verdict}（${verdict.reason}）`)
  } finally {
    await pool.end()
  }
}
