// scripts/notify-emit-job.test.ts — 调度器 notify.emit handler 的**黑盒**契约测试（W6-P2）。
//
// 全部走真入口 spawn：退出码是调度器唯一的分支依据（0=成功 / 1=可重试 / 2=不重试），
// 纯核测试钉不住它。参数走 stdin（进程 env 对同机可见 ⇒ 契约禁止把 params 放 env），
// 故这里也按生产形状喂 stdin，而不是 import 内部函数。
//
// 需要 DATABASE_URL（与 apps/server 同约定：没有就整体跳过）。
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyMigrations } from '../modules/notify/test-util.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

/** 夹具前缀统一 `org-p2-emit-`：清理/断言都只碰自己这一族 org。 */
const PREFIX = 'org-p2-emit-'
const OCCURRENCE = '2026-11-14T02:07:00.000Z'
const SCHEDULE_ID = '42'

describePg('notify-emit-job.mjs（黑盒）', () => {
  // pg 只在 apps/server 的依赖里（与 scripts/*.mjs 同款解析）。
  const { Pool } = createRequire(new URL('../apps/server/package.json', import.meta.url))('pg')
  const pool = new Pool({ connectionString: dbUrl })
  const cleanup = async (): Promise<void> => {
    await pool.query('delete from notify.event where org like $1', [`${PREFIX}%`])
  }

  beforeAll(async () => {
    // 自足：先应用 notify 迁移（幂等），不依赖「别的套件恰好先跑过」。
    await applyMigrations(pool)
    await cleanup()
  })

  afterAll(async () => {
    await cleanup().catch(() => {})
    await pool.end()
  })

  /**
   * 按生产形状跑一次 handler：params 走 stdin，JOB_* 走 env。
   * 用 `pnpm exec tsx`（与调度器 `runner.ts` 同形）而不是裸 node：handler import 了 `.ts`
   * （notify/storage），裸 node 要靠 Node 22.18+ 默认的类型剥离，而 CI 只钉 `node-version: 22`
   * ——小版本不确定就意味着「本机能过、CI 红」。tsx 是线上真实执行形态，无此耦合。
   */
  const runJob = (org: string, stdin: string, env: Record<string, string> = {}) =>
    spawnSync('pnpm', ['exec', 'tsx', 'scripts/notify-emit-job.mjs'], {
      cwd: repoRoot,
      input: stdin,
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: dbUrl,
        JOB_KEY: 'notify.emit',
        JOB_SCHEDULE_ID: SCHEDULE_ID,
        JOB_OCCURRENCE: OCCURRENCE,
        JOB_OWNER_ORG: org,
        ...env,
      },
    })

  const rowsOf = async (org: string) => {
    const { rows } = await pool.query(
      `select event_id, event_key, scope, payload, producer from notify.event where org = $1 order by event_id`,
      [org],
    )
    return rows as { event_id: string; event_key: string; scope: string; payload: Record<string, unknown>; producer: string }[]
  }

  it('合法参数 ⇒ exit 0，入队一行且 event_id 是缺省格式', async () => {
    const org = `${PREFIX}legal`
    const r = runJob(org, JSON.stringify({ eventKey: 'report.due', payload: { report: 'r-1' } }))
    expect(r.status).toBe(0)

    const rows = await rowsOf(org)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      event_id: `schedule:${SCHEDULE_ID}:${OCCURRENCE}`,
      event_key: 'report.due',
      scope: '*',
      payload: { report: 'r-1' },
      producer: 'scheduler',
    })
  })

  it('同一 occurrence 重跑 ⇒ 仍 exit 0（duplicate）且只有一行', async () => {
    const org = `${PREFIX}dup`
    const stdin = JSON.stringify({ eventKey: 'report.due', payload: { n: 1 } })

    expect(runJob(org, stdin).status).toBe(0)
    const second = runJob(org, stdin)
    expect(second.status).toBe(0)
    // 只断言「0 + 一行」会被「第二次静默空转」蒙混过关：必须能看见它走的是 duplicate 分支。
    expect(second.stdout).toContain('duplicate')

    expect(await rowsOf(org)).toHaveLength(1)
  })

  it('eventKey 两端空白 ⇒ 入库是去空白形态（否则规则永远匹配不到）', async () => {
    const org = `${PREFIX}trim`
    const r = runJob(org, JSON.stringify({ eventKey: '  report.due  ' }))
    expect(r.status).toBe(0)

    const rows = await rowsOf(org)
    expect(rows).toHaveLength(1)
    expect(rows[0].event_key).toBe('report.due')
  })

  it('缺 eventKey ⇒ exit 2（不重试）且不入队', async () => {
    const org = `${PREFIX}missing-key`
    const r = runJob(org, JSON.stringify({ payload: { n: 1 } }))
    expect(r.status).toBe(2)
    expect(await rowsOf(org)).toHaveLength(0)
  })

  it('payload 序列化超 16KB ⇒ exit 2（不重试）且不入队', async () => {
    const org = `${PREFIX}oversize`
    const r = runJob(org, JSON.stringify({ eventKey: 'report.due', payload: { blob: 'x'.repeat(17 * 1024) } }))
    expect(r.status).toBe(2)
    expect(await rowsOf(org)).toHaveLength(0)
  })

  it('JOB_OWNER_ORG 为空 ⇒ exit 2（归属判不了就不入队）', async () => {
    const org = `${PREFIX}no-org`
    const r = runJob(org, JSON.stringify({ eventKey: 'report.due' }), { JOB_OWNER_ORG: '' })
    expect(r.status).toBe(2)
    expect(await rowsOf(org)).toHaveLength(0)
  })
})
