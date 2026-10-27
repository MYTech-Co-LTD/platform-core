#!/usr/bin/env node
// scripts/notify-health.mjs — 薄 CLI；判定与查询在 modules/notify/health.ts。
// 退出码：0 干净；1 有 dead / pending > 10min / worker 心跳 > 2min；2 查不成账。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { checkHealth, healthVerdict } from '../modules/notify/health.ts'

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('notify-health: 缺 DATABASE_URL（从 openship 项目 env 取，勿 SSH 读机器状态）')
    process.exit(2)
  }
  const { Pool } = createRequire(import.meta.url)('pg')
  const pool = new Pool({ connectionString: url })
  try {
    const r = await checkHealth(pool)
    console.log(
      `notify-health: dead=${r.dead} stale=${r.stale} workers=${r.workers} `
      + `oldestPending=${r.oldestPendingSeconds}s failedLastHour=${r.failedLastHour} `
      + `channelErrors=${r.channelErrors}`)
    process.exit(healthVerdict(r))
  } catch (e) {
    console.error('notify-health 查不成账:', e instanceof Error ? e.message : e)
    process.exit(2)
  } finally {
    await pool.end()
  }
}
