// seed-builtin.test.ts — 内置模板/通道/默认规则：按事件 defaults 派生 + 幂等
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from './test-util'
import { seedBuiltin, type EventDefaults } from './seed-builtin'

const url = process.env.DATABASE_URL
const describePg = url ? describe : describe.skip
const ORG = 'org-seed2'

const AFT = {
  recipient: 'approvers',
  template: 'aftersales_employee_approval_pending',
  channels: ['wecom_default', 'inapp_default'],
}
const STALE = {
  recipient: 'admins',
  template: 'notify_integration_stale',
  channels: ['inapp_default'],
}
const METRIC = {
  recipient: 'viewers',
  template: 'data_metric_definition_changed',
  channels: ['inapp_default'],
}
const ASSIGNED = {
  recipient: 'assignee',
  template: 'forms_form_assigned',
  channels: ['wecom_default', 'inapp_default'],
}
const REMIND = {
  recipient: 'assignee',
  template: 'forms_form_due_reminder',
  channels: ['wecom_default', 'inapp_default'],
}

const DEFAULTS: EventDefaults = {
  'aftersales.employee_approval.pending': AFT,
  'notify.integration.stale': STALE,
  'data.metric.definition.changed': METRIC,
}
const WITH_FORMS: EventDefaults = {
  ...DEFAULTS,
  'forms.form.assigned': ASSIGNED,
  'forms.form.due_reminder': REMIND,
}

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

  it('首轮按 defaults 建规则 + manual 兜底；第二轮不新增', async () => {
    const env = { NOTIFY_APPROVERS__ORG_SEED2: 'alice, bob' }
    await seedBuiltin(pool, env, [ORG], DEFAULTS)
    const first = await counts()
    // templates/revisions 5：内置文案 = 员工审批 + 集成超期 + 指标变更 + 表单指派 + 表单催办
    // rules 4：3 条 defaults 派生 + 1 条 manual
    expect(first).toEqual({ templates: 5, revisions: 5, channels: 2, rules: 4 })

    const manual = await pool.query(
      "select recipient_key, recipient_literal from notify.rule where org=$1 and id like 'manual:%'",
      [ORG],
    )
    expect(manual.rows[0]).toEqual({ recipient_key: 'approvers_manual', recipient_literal: ['alice', 'bob'] })

    await seedBuiltin(pool, env, [ORG], DEFAULTS)
    expect(await counts()).toEqual(first)
  })

  it('无 NOTIFY_APPROVERS ⇒ 只剩 defaults 派生的三条规则', async () => {
    await seedBuiltin(pool, {}, [ORG], DEFAULTS)
    expect(await counts()).toEqual({ templates: 5, revisions: 5, channels: 2, rules: 3 })
    const stale = await pool.query(
      "select channels from notify.rule where org=$1 and event_key='notify.integration.stale'", [ORG])
    // 只用 in_app：企微通道本身可能正是坏掉的那个（坏通道报坏消息 = 自欺）
    expect(stale.rows[0].channels).toEqual(['inapp_default'])
  })

  it('forms 事件按 defaults 建模板与规则（指派/催办零配置可通）', async () => {
    await seedBuiltin(pool, {}, [ORG], WITH_FORMS)
    expect(await counts()).toEqual({ templates: 5, revisions: 5, channels: 2, rules: 5 })

    const rules = await pool.query(
      `select id, recipient_key, template_key, channels
         from notify.rule where org=$1 and event_key like 'forms.%' order by event_key`,
      [ORG],
    )
    expect(rules.rows).toEqual([
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

    const tpl = await pool.query(
      "select key from notify.template where org=$1 and key like 'forms_%' order by key", [ORG])
    expect(tpl.rows.map((r) => r.key)).toEqual(['forms_form_assigned', 'forms_form_due_reminder'])
  })

  it('无 defaults ⇒ 只 seed 模板/通道，不建规则', async () => {
    await seedBuiltin(pool, {}, [ORG], {})
    expect(await counts()).toEqual({ templates: 5, revisions: 5, channels: 2, rules: 0 })
  })

  it('defaults 指向不存在的内置模板 ⇒ 跳过，不造孤儿规则', async () => {
    await seedBuiltin(pool, {}, [ORG], {
      'demo.note.created': {
        recipient: 'author', template: 'missing_template', channels: ['inapp_default'],
      },
    })
    expect((await counts()).rules).toBe(0)
  })

  it('defaults 形状非法 ⇒ 跳过', async () => {
    await seedBuiltin(pool, {}, [ORG], {
      'demo.note.created': { recipient: '', template: 'x', channels: [] },
    })
    expect((await counts()).rules).toBe(0)
  })
})
