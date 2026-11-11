// routes/scopes.ts — 数据范围 scope 管理面（spec 2026-11-10 §5.5；issue #1901）。
//
// 门 = `data:manage`（manifest api.internal 声明，宿主施加；本文件零鉴权代码）。
// 判定链在 domain/scope-admin.ts（与 MCP 写面同源的单实现原则：路由只做 HTTP 形状映射）。
// 错误码 → HTTP 的映射收在本文件（writeOutcome 是判别式的通用形状，这里带 detail，单独写）。
import type { Context } from 'hono'
import type { ModuleHono, ModuleVars, RouteCtx } from './context'
import { parseIdParam, requesterOf } from './context'
import {
  createScope, deleteScope, listScopeAudit, listScopes, previewEffective, replaceAssignments,
  updateScope, type AdminErr,
} from '../domain/scope-admin'

const orgOf = (c: Context<ModuleVars>): string => c.get('tenant').casdoor_org

/** 判别式 → HTTP。带 detail（如 VALUE_NOT_IN_DIMS 的未知值清单）——运营修配置需要它。 */
function outcome(c: Context<ModuleVars>, r: { ok: true; value: unknown } | { ok: false; code: AdminErr; detail?: string }, okStatus: 200 | 201) {
  if (r.ok) return c.json(r.value, okStatus)
  const http: Record<AdminErr, 400 | 404 | 409 | 503> = {
    INVALID_NAME: 400, INVALID_KIND: 400, INVALID_SELECTOR: 400, VALUE_NOT_IN_DIMS: 400,
    INVALID_ASSIGNMENTS: 400, DUP_NAME: 409, NOT_FOUND: 404, DIMS_UNAVAILABLE: 503,
  }
  return c.json({ error: r.code, ...(r.detail !== undefined ? { detail: r.detail } : {}) }, http[r.code])
}

/** 写操作必须能归属到人（audit 记人）；无身份 ⇒ 拒（同 POST /metrics 的口径）。 */
function actorOf(c: Context<ModuleVars>): string | null {
  const requester = requesterOf(c)
  return requester === null ? null : (requester.accountName ?? requester.userId)
}

export function registerScopes(r: ModuleHono, ctx: RouteCtx): void {
  const deps = { pool: ctx.pool, ...(ctx.warehouse !== undefined ? { warehouse: ctx.warehouse } : {}) }

  r.get('/scopes', async (c) => {
    return c.json({ scopes: await listScopes(ctx.pool, orgOf(c)) })
  })

  // 预览放 :id 之前注册（虽然方法不撞，顺序习惯保持「静态路径在前」——loader 门卫同款纪律）
  r.get('/scopes/effective', async (c) => {
    const user = (c.req.query('user') ?? '').trim()
    if (user === '') return c.json({ error: 'INVALID_QUERY' }, 400)
    const roles = (c.req.query('roles') ?? '').split(',').map((x) => x.trim()).filter((x) => x !== '')
    return c.json(await previewEffective(ctx.pool, orgOf(c), user, roles))
  })

  // 变更历史（只读）：运营改错 scope 时要能回溯「谁改了什么」。
  r.get('/scopes/audit', async (c) => {
    const limit = Number(c.req.query('limit') ?? '50')
    return c.json({ audit: await listScopeAudit(ctx.pool, orgOf(c), Number.isFinite(limit) ? limit : 50) })
  })

  r.post('/scopes', async (c) => {
    const actor = actorOf(c)
    if (actor === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const body = await c.req.json().catch(() => null)
    const input = (body ?? {}) as Record<string, unknown>
    return outcome(c, await createScope(deps, orgOf(c), actor, {
      name: input.name as string,
      kind: input.kind as never,
      selector: input.selector,
      legacyLabel: typeof input.legacyLabel === 'string' ? input.legacyLabel : undefined,
    }), 201)
  })

  r.put('/scopes/:id', async (c) => {
    const actor = actorOf(c)
    if (actor === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const id = parseIdParam(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const body = await c.req.json().catch(() => null)
    const input = (body ?? {}) as Record<string, unknown>
    return outcome(c, await updateScope(deps, orgOf(c), actor, id, {
      name: input.name as string,
      kind: input.kind as never,
      selector: input.selector,
      legacyLabel: typeof input.legacyLabel === 'string' ? input.legacyLabel : undefined,
    }), 200)
  })

  r.delete('/scopes/:id', async (c) => {
    const actor = actorOf(c)
    if (actor === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const id = parseIdParam(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    return outcome(c, await deleteScope(ctx.pool, orgOf(c), actor, id), 200)
  })

  r.put('/scopes/:id/assignments', async (c) => {
    const actor = actorOf(c)
    if (actor === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const id = parseIdParam(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const body = await c.req.json().catch(() => null)
    const assignments = (body ?? {}) as { assignments?: unknown }
    return outcome(c, await replaceAssignments(ctx.pool, orgOf(c), actor, id, assignments.assignments), 200)
  })
}
