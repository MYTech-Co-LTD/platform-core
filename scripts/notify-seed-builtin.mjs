#!/usr/bin/env node
// scripts/notify-seed-builtin.mjs — 薄 CLI；seed 逻辑在 modules/notify/seed-builtin.ts。
// 幂等：重复执行不新增模板 revision / 通道；derived 规则 upsert；manual 兜底按 env 覆盖。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { seedBuiltin } from '../modules/notify/seed-builtin.ts'

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('notify-seed-builtin: 缺 DATABASE_URL（从 openship 项目 env 取，勿 SSH 读机器状态）')
    process.exit(2)
  }
  const { Pool } = createRequire(import.meta.url)('pg')
  const pool = new Pool({ connectionString: url })
  try {
    // B1：租户清单在 scripts/ 查（platform schema），模块只收 orgs
    /** @type {{ rows: Array<{ casdoor_org: string }> }} */
    const { rows } = await pool.query('select casdoor_org from platform.tenant order by casdoor_org')
    const s = await seedBuiltin(pool, process.env, rows.map((r) => r.casdoor_org))
    console.log(JSON.stringify(s))
  } catch (e) {
    console.error('notify-seed-builtin 失败:', e instanceof Error ? e.message : e)
    process.exit(1)
  } finally {
    await pool.end()
  }
}
