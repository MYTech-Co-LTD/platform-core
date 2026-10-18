// routes.ts — notify 端点薄壳：identity → storage/pipeline，错误码映射状态码。
// 模块零认证代码：权限门禁由宿主按 manifest.api.internal 声明施加（没声明 = 不可达）。
// 主体（org）只来自 identity.orgId——**绝不读请求参数**（§2.6 鉴权钉死④）。
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { Pool } from 'pg'
import type { Identity } from '@platform/sdk'
import type { NovuConfig } from './domain/novu'
import { deriveApprovalRule, deriveReminderRule } from './domain/derive'
import { validateRule, type Channel, type RecipientKind } from './domain/rules'
import { emit } from './pipeline'
import { registerNotifyMcpManage } from './mcp'
import { deleteRule, listDeliveries, listRules, setRuleEnabled, upsertRule } from './storage'

/** 机检错误码 → HTTP 状态（不解析 message）。 */
function statusOf(code: string): 400 | 404 | 500 {
  if (code === 'NOT_FOUND') return 404
  if (code.startsWith('RULE_')) return 400
  return 500
}

export function createNotifyRouter({ pool, novu = null }: { pool: Pool; novu?: NovuConfig | null }) {
  const r = new Hono<{ Variables: { identity: Identity } }>()
  const org = (c: { get: (k: 'identity') => unknown }) => (c.get('identity') as Identity).orgId

  // ── 规则登记 ──
  r.get('/rules', async (c) => c.json({ rules: await listRules(pool, org(c)) }))

  r.post('/rules', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      id?: string
      eventType?: string
      mount?: string
      templateId?: string
      recipient?: RecipientKind
      recipientArg?: string | null
      channels?: Channel[]
      cooldownMinutes?: number | null
      enabled?: boolean
    } | null
    if (!body || !body.eventType || !body.mount || !body.templateId || !body.recipient) {
      return c.json({ error: 'RULE_INVALID_BODY' }, 400)
    }
    const bad = validateRule({
      eventType: body.eventType,
      mount: body.mount,
      recipient: body.recipient,
      recipientArg: body.recipientArg ?? null,
    })
    if (bad) return c.json({ error: bad.code }, statusOf(bad.code))

    const ruleId = body.id ?? `rule:${randomUUID()}`
    await upsertRule(
      pool,
      org(c),
      {
        id: ruleId,
        org: org(c),
        enabled: body.enabled ?? true,
        eventType: body.eventType,
        mount: body.mount,
        templateId: body.templateId,
        recipient: body.recipient,
        recipientArg: body.recipientArg ?? null,
        channels: body.channels ?? ['wechat_work', 'in_app'],
        cooldownMinutes: body.cooldownMinutes ?? null,
        origin: 'manual', // 人工/AI 显式创建（derived 只由声明派生写入）
        createdAt: new Date().toISOString(),
      },
      (c.get('identity') as Identity).userId,
    )
    return c.json({ id: ruleId }, 201)
  })

  r.put('/rules/:id/enabled', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { enabled?: boolean } | null
    if (!body || typeof body.enabled !== 'boolean') return c.json({ code: 'RULE_INVALID_BODY' }, 400)
    const n = await setRuleEnabled(pool, org(c), c.req.param('id'), body.enabled)
    if (n === 0) return c.json({ error: 'NOT_FOUND' }, 404)
    return c.json({ ok: true })
  })

  r.delete('/rules/:id', async (c) => {
    const n = await deleteRule(pool, org(c), c.req.param('id'))
    if (n === 0) return c.json({ error: 'NOT_FOUND' }, 404)
    return c.json({ ok: true })
  })

  r.get('/deliveries', async (c) => c.json({ deliveries: await listDeliveries(pool, org(c)) }))

  // ── 声明派生（取舍②「零配置默认就通」的写入面）──
  // 声明方（forms 发布带催办策略 / case-engine 落 approval: single）在**声明落地时**调此端点，
  // 由 notify 幂等派生默认规则（确定性 id ⇒ 重算即 no-op，不重复生效）。派生规则标 origin=derived，
  // 在 console 可见、可覆盖（同 mount+event 的 manual 规则优先）。
  // 调用方接缝（in-platform 模块 / 跨服务）另定——本端点只负责「给我声明，我派生」这一半。
  r.post('/derive', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      kind?: 'approval' | 'reminder'
      mount?: string
      templateId?: string
    } | null
    if (!body || !body.mount || (body.kind !== 'approval' && body.kind !== 'reminder')) {
      return c.json({ error: 'DERIVE_INVALID_BODY' }, 400)
    }
    const now = new Date().toISOString()
    const rule =
      body.kind === 'approval'
        ? deriveApprovalRule(org(c), { mount: body.mount, approvers: [], templateId: body.templateId }, now)
        : deriveReminderRule(org(c), { mount: body.mount, templateId: body.templateId }, now)
    await upsertRule(pool, org(c), rule, 'system')
    return c.json({ id: rule.id, eventType: rule.eventType, origin: rule.origin }, 201)
  })

  // ── emit（入口 A 事件驱动；入口 B 定时驱动同调 pipeline.emit）──
  // fail-open：**任何**失败不让调用方受阻——边界一律 202，失败落回执（§2.6 取舍④）。
  r.post('/emit', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      eventId?: string
      eventType?: string
      mount?: string
      payload?: Record<string, unknown>
    } | null
    if (!body || !body.eventId || !body.eventType || !body.mount) {
      return c.json({ error: 'EMIT_INVALID_BODY' }, 400)
    }
    try {
      const result = await emit(
        { pool, novu },
        {
          org: org(c),
          eventId: body.eventId,
          eventType: body.eventType,
          mount: body.mount,
          payload: body.payload ?? {},
        },
      )
      return c.json(result, 202)
    } catch (e) {
      // 兜底：通知链异常不得阻塞业务（fail-open）。
      console.error('[notify] emit failed', e instanceof Error ? e.message : e)
      return c.json({ matched: 0, delivered: 0, failed: 0, error: 'EMIT_FAILED' }, 202)
    }
  })

  // 管理面 MCP 端点（AI 建规则；**无模板/发布类工具**，§2.6 门禁分层）。
  registerNotifyMcpManage(r, { pool })

  return r
}
