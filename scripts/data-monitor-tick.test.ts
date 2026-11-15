// scripts/data-monitor-tick.test.ts — tick 脚本的**黑盒**契约（W7-V1 Task 4）。
//
// 退出码是调度器唯一的分支依据（0=ok / 1=有 unknown / 2=不重试），纯核测试钉不住它。
// 需要 DATABASE_URL；夹具前缀 org-montick-*，空库可绿。
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyMigrations, applyPlatformMigrations } from '../modules/data/test-util.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

const ORG = `org-montick-${Math.random().toString(36).slice(2, 8)}`

function runTick(env: Record<string, string | undefined>) {
  return spawnSync('pnpm', ['exec', 'tsx', 'scripts/data-monitor-tick.mjs'], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 120_000,
  })
}

describe('data-monitor-tick · 环境缺失', () => {
  it('缺 DATABASE_URL ⇒ exit 2（不重试）', () => {
    const r = runTick({ DATABASE_URL: '' })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('DATABASE_URL')
  })
})

describePg('data-monitor-tick（黑盒）', () => {
  const { Pool } = createRequire(new URL('../apps/server/package.json', import.meta.url))('pg')
  const pool = new Pool({ connectionString: dbUrl })
  const cleanup = async (): Promise<void> => {
    await pool.query('delete from data.monitor_run where org = $1', [ORG])
    await pool.query('delete from data.monitor where org = $1', [ORG])
    await pool.query('delete from notify.event where org = $1', [ORG])
  }

  beforeAll(async () => {
    await applyPlatformMigrations(pool)
    await applyMigrations(pool)
    await cleanup()
  })

  afterAll(async () => {
    await cleanup().catch(() => {})
    await pool.end()
  })

  it('★ 无到期规则 ⇒ exit 0 且汇总行全 0', async () => {
    const r = runTick({ DATABASE_URL: dbUrl })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('monitor-tick: due=')
  })

  it('★ 到期但判不了 ⇒ exit 1，落 monitor_run、不产生 notify 事件（影子期）', async () => {
    const ins = await pool.query(
      `insert into data.monitor
         (org, name, target_kind, metric_id, verdict, window_days, cadence_secs, dry_run, recipients, created_by)
       values ($1, '黑盒夹具', 'metric', 'does.not.exist', 'missing', 1, 300, true,
               '[{"kind":"user","ref":"alice"}]'::jsonb, 'alice')
       returning id`,
      [ORG],
    )
    const id = (ins.rows[0] as { id: string }).id

    const r = runTick({ DATABASE_URL: dbUrl })
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/monitor-tick: due=\d+ .*unknown=[1-9]/)

    const runs = await pool.query(
      'select verdict, notified, dry_run, error from data.monitor_run where monitor_id = $1', [id])
    expect(runs.rowCount).toBe(1)
    expect(runs.rows[0]).toMatchObject({ verdict: 'unknown', notified: false, dry_run: true })
    expect(String(runs.rows[0].error)).toContain('metric_not_declared')

    const events = await pool.query('select count(*)::int as n from notify.event where org = $1', [ORG])
    expect(events.rows[0].n).toBe(0)

    const hb = await pool.query(
      "select 1 from platform.job_heartbeat where id = 'data.monitor_tick'")
    expect(hb.rowCount).toBe(1)
  })
})
