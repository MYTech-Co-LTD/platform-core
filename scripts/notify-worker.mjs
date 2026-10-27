#!/usr/bin/env node
// scripts/notify-worker.mjs — 薄 CLI；组合根在 modules/notify/worker-deps.ts。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { runOnceCli } from '../modules/notify/worker-deps.ts'

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('notify-worker: 缺 DATABASE_URL（从 openship 项目 env 取，勿 SSH 读机器状态）')
    process.exit(2)
  }
  const { Pool } = createRequire(import.meta.url)('pg')
  const pool = new Pool({ connectionString: url })
  const once = process.argv.includes('--once')

  try {
    do {
      try {
        const s = await runOnceCli(pool, process.env)
        console.log(JSON.stringify({ ts: new Date().toISOString(), ...s }))
      } catch (e) {
        console.error('notify-worker 本轮失败:', e instanceof Error ? e.message : e)
        if (once) process.exitCode = 1
      }
      if (once) break
      await new Promise((r) => setTimeout(r, 2000))
    } while (true)
  } finally {
    await pool.end()
  }
}
