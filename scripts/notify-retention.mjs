#!/usr/bin/env node
// scripts/notify-retention.mjs — 通知保留期清理（openship job，每日）。
// 退出码：0 干净；1 清理失败；2 缺 DATABASE_URL / 参数非法。
// 默认：in-app 90 天 / attempt 180 天 / delivery 365 天（只删终态）。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { purgeOldNotifications } from '../modules/notify/storage.ts'

/** 读 env 天数；非法/缺省回落 */
export function retentionDays(env = process.env) {
  /** @param {string} key @param {number} dflt */
  const pick = (key, dflt) => {
    const raw = env[key]
    if (raw === undefined || raw.trim() === '') return dflt
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : dflt
  }
  return {
    inboxDays: pick('NOTIFY_INBOX_RETENTION_DAYS', 90),
    attemptDays: pick('NOTIFY_ATTEMPT_RETENTION_DAYS', 180),
    deliveryDays: pick('NOTIFY_DELIVERY_RETENTION_DAYS', 365),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('notify-retention: 缺 DATABASE_URL（从 openship 项目 env 取，勿 SSH 读机器状态）')
    process.exit(2)
  }
  const { Pool } = createRequire(import.meta.url)('pg')
  const pool = new Pool({ connectionString: url })
  try {
    const opts = retentionDays()
    const r = await purgeOldNotifications(pool, opts)
    console.log(
      `notify-retention: inbox=${r.inbox} attempts=${r.attempts} deliveries=${r.deliveries} `
      + `(inbox>${opts.inboxDays}d attempt>${opts.attemptDays}d delivery>${opts.deliveryDays}d)`)
    process.exit(0)
  } catch (e) {
    console.error('notify-retention 失败:', e instanceof Error ? e.message : e)
    process.exit(1)
  } finally {
    await pool.end()
  }
}
