// seed-builtin.test.ts — 内置模板/通道/默认规则 seed 幂等 + literal 兜底
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from './test-util'
import { seedBuiltin } from './seed-builtin'

const url = process.env.DATABASE_URL
const describePg = url ? describe : describe.skip
const ORG = 'org-seed2'

describePg('seedBuiltin', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await applyMigrations(pool)
  })
  afterAll(async () => {
    await cleanup()
    await pool.end()
  })
  beforeEach(cleanup)

  async function cleanup() {
    await pool.query('delete from notify.rule where org=$1', [ORG])
    await pool.query('delete from notify.channel where org=$1', [ORG])
    await pool.query('delete from notify.template_revision where org=$1', [ORG])
    await pool.query('delete from notify.template where org=$1', [ORG])
  }

  const counts = async () => {
    const q = async (table: string) => {
      const r = await pool.query(`select count(*)::int n from notify.${table} where org=$1`, [ORG])
      return r.rows[0].n as number
    }
    return {
      templates: await q('template'),
      revisions: await q('template_revision'),
      channels: await q('channel'),
      rules: await q('rule'),
    }
  }

  it('首轮建模板/通道/derived+manual 规则；第二轮不新增', async () => {
    const env = { NOTIFY_APPROVERS__ORG_SEED2: 'alice, bob' }
    await seedBuiltin(pool, env, [ORG])
    const first = await counts()
    // templates/revisions 2：内置文案 = 员工登记审批 + 集成活性超期（Phase 2b）
    // rules 3：derived(aftersales) + derived(notify.integration.stale) + manual
    expect(first).toEqual({ templates: 2, revisions: 2, channels: 2, rules: 3 })

    const manual = await pool.query(
      "select recipient_key, recipient_literal from notify.rule where org=$1 and id like 'manual:%'",
      [ORG],
    )
    expect(manual.rows[0]).toEqual({ recipient_key: 'approvers_manual', recipient_literal: ['alice', 'bob'] })

    await seedBuiltin(pool, env, [ORG])
    expect(await counts()).toEqual(first)
  })

  it('无 NOTIFY_APPROVERS ⇒ 只剩两条 derived 规则（含集成健康那条）', async () => {
    await seedBuiltin(pool, {}, [ORG])
    expect((await counts()).rules).toBe(2)
    const stale = await pool.query(
      "select channels from notify.rule where org=$1 and event_key='notify.integration.stale'", [ORG])
    // 只用 in_app：企微通道本身可能正是坏掉的那个（坏通道报坏消息 = 自欺）
    expect(stale.rows[0].channels).toEqual(['inapp_default'])
  })
})
