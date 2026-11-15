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
    // templates/revisions 6：员工登记审批 + 集成活性超期 + 审批待处理 + 指标定义变更
    //   + 表单指派/表单催办
    // rules 7：derived(aftersales/stale/approval/metric/forms×2) + manual
    expect(first).toEqual({ templates: 6, revisions: 6, channels: 2, rules: 7 })

    const manual = await pool.query(
      "select recipient_key, recipient_literal from notify.rule where org=$1 and id like 'manual:%'",
      [ORG],
    )
    expect(manual.rows[0]).toEqual({ recipient_key: 'approvers_manual', recipient_literal: ['alice', 'bob'] })

    await seedBuiltin(pool, env, [ORG])
    expect(await counts()).toEqual(first)
  })

  it('无 NOTIFY_APPROVERS ⇒ 只剩六条 derived 规则（aftersales/集成健康/审批/指标变更/表单两条）', async () => {
    await seedBuiltin(pool, {}, [ORG])
    expect((await counts()).rules).toBe(6)
    const stale = await pool.query(
      "select channels from notify.rule where org=$1 and event_key='notify.integration.stale'", [ORG])
    // 只用 in_app：企微通道本身可能正是坏掉的那个（坏通道报坏消息 = 自欺）
    expect(stale.rows[0].channels).toEqual(['inapp_default'])
  })
})

describePg('seedBuiltin：声明了 defaults 的事件必须真的有派生规则（Wave 2.3）', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await applyMigrations(pool)
  })
  afterAll(async () => { await pool.end() })

  it('forms 两个事件各有一条 derived 规则，template/recipient 与 defaults 一致', async () => {
    const org = `${ORG}-forms`
    await pool.query('delete from notify.rule where org=$1', [org])
    await pool.query('delete from notify.template_revision where org=$1', [org])
    await pool.query('delete from notify.template where org=$1', [org])
    try {
      await seedBuiltin(pool, {}, [org])
      const r = await pool.query(
        `select id, recipient_key, template_key, channels from notify.rule
          where org=$1 and event_key like 'forms.%' order by event_key`,
        [org],
      )
      expect(r.rows).toEqual([
        {
          id: 'derived:forms:forms.form.assigned:*',
          recipient_key: 'assignee',
          template_key: 'forms_form_assigned',
          channels: ['wecom_default', 'inapp_default'],
        },
        {
          id: 'derived:forms:forms.form.due_reminder:*',
          recipient_key: 'assignee',
          template_key: 'forms_form_due_reminder',
          channels: ['wecom_default', 'inapp_default'],
        },
      ])
      // 模板也真的落库了（有模板但没规则 = 同样投不出去）
      const tpl = await pool.query(
        "select key, event_key from notify.template where org=$1 and key like 'forms_%' order by key",
        [org],
      )
      expect(tpl.rows).toEqual([
        { key: 'forms_form_assigned', event_key: 'forms.form.assigned' },
        { key: 'forms_form_due_reminder', event_key: 'forms.form.due_reminder' },
      ])
    } finally {
      await pool.query('delete from notify.rule where org=$1', [org])
      await pool.query('delete from notify.channel where org=$1', [org])
      await pool.query('delete from notify.template_revision where org=$1', [org])
      await pool.query('delete from notify.template where org=$1', [org])
    }
  })
})
