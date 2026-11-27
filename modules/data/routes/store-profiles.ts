// routes/store-profiles.ts — 门店画像写面（#2924，`data:store`）
//
// 门 = `data:store`（manifest api.internal 声明，宿主施加；本文件零鉴权代码）。
// 判定/事务/审计在 domain/store-profile.ts（路由只做 HTTP 形状映射，与 scopes 同款分层）。
import type { Context } from 'hono'
import type { ModuleHono, ModuleVars, RouteCtx } from './context'
import { requesterOf } from './context'
import {
  createStoreLevel,
  importStoreProfiles,
  updateStoreLevel,
  updateStoreProfile,
  type StoreProfileError,
  type StoreProfileResult,
} from '../domain/store-profile'

const orgOf = (c: Context<ModuleVars>): string => c.get('tenant').casdoor_org

/** 写操作必须能归属到人（audit 记人）；无身份 ⇒ 拒（同 POST /metrics 的口径）。 */
function actorOf(c: Context<ModuleVars>): string | null {
  const requester = requesterOf(c)
  return requester === null ? null : (requester.accountName ?? requester.userId)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const HTTP: Record<StoreProfileError, 400 | 404 | 409> = {
  INVALID_BODY: 400,
  INVALID_STORE: 400,
  INVALID_BRAND: 400,
  INVALID_LEVEL: 400,
  INVALID_CODE: 400,
  NOT_FOUND: 404,
  DUP_CODE: 409,
  TOO_MANY_ROWS: 400,
}

function outcome<T>(
  c: Context<ModuleVars>, r: StoreProfileResult<T>, okStatus: 200 | 201,
) {
  if (r.ok) return c.json(r.value, okStatus)
  return c.json({ error: r.code, ...(r.detail !== undefined ? { detail: r.detail } : {}) }, HTTP[r.code])
}

/** PUT 的字段：缺省 = 保持不变；null / `__clear__` = 清空；空串/非字符串 = 400。 */
function profileField(
  body: Record<string, unknown>, key: 'brandCode' | 'levelCode',
): { present: false } | { present: true; value: string | null } | { invalid: true } {
  if (!Object.prototype.hasOwnProperty.call(body, key)) return { present: false }
  const raw = body[key]
  if (raw === null) return { present: true, value: null }
  if (typeof raw !== 'string') return { invalid: true }
  const v = raw.trim()
  if (v === '__clear__') return { present: true, value: null }
  if (v === '' || v.length > 64) return { invalid: true }
  return { present: true, value: v }
}

export function registerStoreProfiles(r: ModuleHono, ctx: RouteCtx): void {
  // 静态路径在前（loader 门卫/习惯纪律；方法不同也不会被 :storeCode 吞）
  r.post('/store-profiles/import', async (c) => {
    const actor = actorOf(c)
    if (actor === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const body = await c.req.json().catch(() => null)
    if (!isRecord(body)) return c.json({ error: 'INVALID_BODY' }, 400)
    if (typeof body.dryRun !== 'boolean') return c.json({ error: 'INVALID_BODY' }, 400)
    if (body.overrideLocked !== undefined && typeof body.overrideLocked !== 'boolean') {
      return c.json({ error: 'INVALID_BODY' }, 400)
    }
    if (!Array.isArray(body.rows)) return c.json({ error: 'INVALID_BODY' }, 400)
    return outcome(c, await importStoreProfiles({ pool: ctx.pool }, orgOf(c), actor, {
      dryRun: body.dryRun,
      overrideLocked: body.overrideLocked === true,
      rows: body.rows,
    }), 200)
  })

  r.put('/store-profiles/:storeCode', async (c) => {
    const actor = actorOf(c)
    if (actor === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const body = await c.req.json().catch(() => null)
    if (!isRecord(body)) return c.json({ error: 'INVALID_BODY' }, 400)
    const brand = profileField(body, 'brandCode')
    const level = profileField(body, 'levelCode')
    if ('invalid' in brand || 'invalid' in level) return c.json({ error: 'INVALID_BODY' }, 400)
    return outcome(c, await updateStoreProfile({ pool: ctx.pool }, orgOf(c), actor,
      c.req.param('storeCode') ?? '', {
        ...(brand.present ? { brandCode: brand.value } : {}),
        ...(level.present ? { levelCode: level.value } : {}),
      }), 200)
  })

  r.post('/store-levels', async (c) => {
    const actor = actorOf(c)
    if (actor === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const body = await c.req.json().catch(() => null)
    if (!isRecord(body)) return c.json({ error: 'INVALID_BODY' }, 400)
    return outcome(c, await createStoreLevel({ pool: ctx.pool }, orgOf(c), actor, {
      code: body.code,
      name: body.name,
      sort: body.sort,
      enabled: body.enabled,
    }), 201)
  })

  r.patch('/store-levels/:code', async (c) => {
    const actor = actorOf(c)
    if (actor === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const body = await c.req.json().catch(() => null)
    if (!isRecord(body)) return c.json({ error: 'INVALID_BODY' }, 400)
    return outcome(c, await updateStoreLevel({ pool: ctx.pool }, orgOf(c), actor,
      c.req.param('code') ?? '', {
        name: body.name,
        sort: body.sort,
        enabled: body.enabled,
      }), 200)
  })
}
