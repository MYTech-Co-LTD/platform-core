// routes/links-manage.ts — 管理面身份绑定四端点（账户统一 Task 8 / 设计稿 §2 人工修正面）。
//
// 本文件**零 SQL**：platform.identity_link 的读写唯一层在宿主（apps/server/src/identity-links.ts），
// 这里只做 HTTP 形状与 ctx.identityLinks 的接线（B1）。
//   · 服务缺省（旧宿主/单测未注入）⇒ 503 IDENTITY_LINKS_UNAVAILABLE——「能力未注入」是部署
//     形态不是代码缺陷，用 503 而不是 500/404。
//   · LinkError 两码在 handler 映射（错误类型同居 SDK，见 sdk module.ts）：LINK_TARGET_MISSING
//     ⇒ 400 {error:'LINK_TARGET_MISSING'}（目标账户不存在，可改可重试）；LINK_NOT_FOUND ⇒
//     404 {error:'NOT_FOUND'}——与 rule/masterdata 的既有 404 口径一致（跨 org 同路，不泄露存在性）。
//   · audit 由服务实现与状态变更同事务落；handler 只把 identity.userId 透传为 opts.actor
//     （管理会话 sub=Casdoor 名），**不**自己写 audit。
import type { Context } from 'hono'
import { z } from 'zod'
import { LinkError } from '@platform/sdk'
import type { IdentityLinkView } from '@platform/sdk'
import { parseIdParam } from './context'
import type { ModuleHono, ModuleVars, RouteCtx } from './context'

const ConfirmBody = z.object({ casdoorName: z.string().min(1).optional() })
const RebindBody = z.object({ casdoorName: z.string().min(1) })

// 与 SDK `IdentityLinkView['status']` 四态逐字对齐（satisfies 拦「多写/写错」方向；
// SDK 侧增删状态时这里必须同步——两边各一份，改动要一起改）。
const STATUS_VALUES = ['pending', 'active', 'revoked', 'disputed'] as const satisfies readonly IdentityLinkView['status'][]

/** LinkError ⇒ 映射好的 Response；null = 不是 LinkError（交 Hono 兜 500，别在这里吞）。 */
function mappedLinkError(c: Context<{ Variables: ModuleVars }>, err: unknown): Response | null {
  if (!(err instanceof LinkError)) return null
  return err.code === 'LINK_TARGET_MISSING'
    ? c.json({ error: 'LINK_TARGET_MISSING' }, 400)
    : c.json({ error: 'NOT_FOUND' }, 404)
}

/** 四端点共用的取件三件套：503 缺省门 → id 解析（非规范 ⇒ 404）→ 消费链接好的服务。 */
function requireLinkSvc(c: Context<{ Variables: ModuleVars }>, ctx: RouteCtx):
  | { svc: NonNullable<RouteCtx['identityLinks']>; id: number }
  | { res: Response } {
  if (!ctx.identityLinks) return { res: c.json({ error: 'IDENTITY_LINKS_UNAVAILABLE' }, 503) }
  const id = parseIdParam(c.req.param('id'))
  if (id === null) return { res: c.json({ error: 'NOT_FOUND' }, 404) }
  return { svc: ctx.identityLinks, id }
}

export function registerLinksManage(r: ModuleHono, ctx: RouteCtx): void {
  // ── 列表（{items} 无 total，单页，照 approvals 页约定）─────────────────────────
  r.get('/identity-links', async (c) => {
    if (!ctx.identityLinks) return c.json({ error: 'IDENTITY_LINKS_UNAVAILABLE' }, 503)
    const raw = c.req.query('status')
    if (raw !== undefined && raw !== '' && !(STATUS_VALUES as readonly string[]).includes(raw)) {
      return c.json({ error: 'INVALID_BODY' }, 400)
    }
    const items = await ctx.identityLinks.listForOrg(
      c.get('identity').orgId,
      raw === undefined || raw === '' ? undefined : (raw as IdentityLinkView['status']),
    )
    return c.json({ items })
  })

  // ── 确认（pending/disputed ⇒ active；缺省目标 = 行上建议）─────────────────────
  r.post('/identity-links/:id/confirm', async (c) => {
    const got = requireLinkSvc(c, ctx)
    if ('res' in got) return got.res
    const parsed = ConfirmBody.safeParse(await c.req.json().catch(() => null) ?? {})
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    try {
      await got.svc.confirm(c.get('identity').orgId, got.id, parsed.data.casdoorName, {
        actor: c.get('identity').userId,
      })
    } catch (err) {
      const mapped = mappedLinkError(c, err)
      if (mapped) return mapped
      throw err
    }
    return c.json({ ok: true })
  })

  // ── 改绑（换目标账户并生效 active；casdoorName 必填）───────────────────────────
  r.post('/identity-links/:id/rebind', async (c) => {
    const got = requireLinkSvc(c, ctx)
    if ('res' in got) return got.res
    const parsed = RebindBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    try {
      await got.svc.rebind(c.get('identity').orgId, got.id, parsed.data.casdoorName, {
        actor: c.get('identity').userId,
      })
    } catch (err) {
      const mapped = mappedLinkError(c, err)
      if (mapped) return mapped
      throw err
    }
    return c.json({ ok: true })
  })

  // ── 解绑（revoked_by = identity.userId；服务层落行+audit）─────────────────────
  r.post('/identity-links/:id/revoke', async (c) => {
    const got = requireLinkSvc(c, ctx)
    if ('res' in got) return got.res
    try {
      await got.svc.revoke(c.get('identity').orgId, got.id, c.get('identity').userId)
    } catch (err) {
      const mapped = mappedLinkError(c, err)
      if (mapped) return mapped
      throw err
    }
    return c.json({ ok: true })
  })
}
