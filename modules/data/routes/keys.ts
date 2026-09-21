// keys.ts — 个人问数 Key 管理：GET /keys（列自己的）、POST /keys（建，明文 token 只回这一次）、
// DELETE /keys/:id（吊销自己的）。**门禁由宿主施加**（manifest 的 api.internal，scope=data:query），
// 本文件不写 requireScope——Key 是每个人管自己的，用 data:manage 会让只能问数的人生成不了 Key。
//
// 归属钉死：casdoorUser 一律取 requesterOf(c).userId（三通道统一的 Casdoor 用户名：
// 会话 sub / PAT casdoorUser / 企微 userid），客户端传什么都不认；org 一律取
// `c.get('tenant').casdoor_org`（text）——不是数字 id。
import { z } from 'zod'
import type { ModuleHono, RouteCtx } from './context'
import { parseIdParam, requesterOf } from './context'
import { createPatKey, listPatKeys, MAX_KEY_NAME_LEN, revokePatKey } from '../domain/key-store'

// 先 trim 再校验：纯空白名别漏给存储层（那边虽也拦，但抛的是 Error ⇒ 路由变 500）
const KeyBody = z.object({ name: z.string().trim().min(1).max(MAX_KEY_NAME_LEN) })

export function registerKeys(r: ModuleHono, ctx: RouteCtx): void {
  r.get('/keys', async (c) => {
    const requester = requesterOf(c)
    // M3 守卫拒掉的请求者：对其「看不见」（约束 3）——空列表，不是报错（口径同 GET /metrics）
    if (requester === null) return c.json({ keys: [] })
    // PatKeyRow 里没有 token 字段，明文不可能从这里漏（库里只有 sha256）
    const keys = await listPatKeys(ctx.pool, c.get('tenant').casdoor_org, requester.userId)
    return c.json({ keys })
  })

  r.post('/keys', async (c) => {
    const requester = requesterOf(c)
    // 写面 fail-closed：身份不成立就不许建 Key（建了也无法归属）
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const parsed = KeyBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const { id, token } = await createPatKey(
      ctx.pool, c.get('tenant').casdoor_org, requester.userId, parsed.data.name,
    )
    // 明文 token **只在此一次**回包（约束 5）。此后任何端点不再返回它，也不进日志/审计/LLM 上下文。
    return c.json({ id, name: parsed.data.name, token }, 201)
  })

  r.delete('/keys/:id', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    // query_keys.id 是 bigint 主键——这里用数字解析器是对的（指标 id 是 text，别混）
    const id = parseIdParam(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    // revokePatKey 的 WHERE 带 casdoor_user：别人的 id 查不中 → false → 404。
    // 404 而不是 403 是有意的：403 会变成「这个 id 存在」的存在性探针。
    const gone = await revokePatKey(ctx.pool, c.get('tenant').casdoor_org, requester.userId, id)
    return gone ? c.body(null, 204) : c.json({ error: 'NOT_FOUND' }, 404)
  })
}
