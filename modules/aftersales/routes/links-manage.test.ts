// routes/links-manage.test.ts — 管理面身份绑定四端点（账户统一 Task 8，纯 HTTP 层）。
//
// 服务层语义（状态机/audit 同事务/LINK_* 抛错条件）已在 apps/server/src/identity-links.test.ts
// 用真 PG 验过——本文件用**替身**只验 handler 的接线：
//   ① GET 形状（{items} 无 total）与 ?status 透传/校验（含空串=不过滤）
//   ② confirm/rebind 的参数与 actor 透传（audit actor = identity.userId；handler 自身零 SQL，
//     pool 传 null 就是这条断言的结构化写法——写不出 audit 行）
//   ③ LinkError 两码映射：LINK_TARGET_MISSING ⇒ 400、LINK_NOT_FOUND ⇒ 404 NOT_FOUND
//   ④ identityLinks 缺省 ⇒ 503 IDENTITY_LINKS_UNAVAILABLE（四端点一致）
//   ⑤ parseIdParam 口径（非规范 id ⇒ 404，不进服务）
import { Hono } from 'hono'
import { LinkError } from '@platform/sdk'
import type { Identity, IdentityLinkView, IdentityLinks } from '@platform/sdk'
import { describe, expect, it, vi } from 'vitest'
import { registerLinksManage } from './links-manage'

const ORG = 'test-t8-manage'

const VIEWS: IdentityLinkView[] = [
  {
    id: 7, provider: 'wechat-oa', externalId: 'oX', casdoorName: 'grace',
    status: 'pending', phoneMasked: '138****11', boundVia: null, createdAt: '2026-10-10T00:00:00.000Z',
  },
  {
    id: 8, provider: 'wecom', externalId: 'ww:corp', casdoorName: 'heidi',
    status: 'active', phoneMasked: null, boundVia: 'manual', createdAt: '2026-10-10T00:00:00.000Z',
  },
]

function buildApp(links?: IdentityLinks) {
  const r = new Hono<{ Variables: { identity: Identity } }>()
  r.use('*', async (c, next) => {
    // 管理会话形状：sub=userId=Casdoor 名（spec §3.1 修订后），actor 断言锚在 userId 上
    c.set('identity', {
      userId: 'admin1', orgId: ORG, displayName: '管理员', accountName: 'admin1',
      scopes: [], hasScope: () => true,
    })
    await next()
  })
  // pool 传 null：四端点的数据面全在 identityLinks，handler 碰 pool 即炸（结构性断言零 SQL）
  registerLinksManage(r, { pool: null as never, identityLinks: links })
  return r
}

/** #11：替身形状收严到 SDK 接口本身（全方法）；关心的方法换成 spy，其余保持无操作默认。 */
function linksStub(spy: Partial<IdentityLinks> = {}): IdentityLinks {
  return {
    matchOnApplication: async () => {
      throw new Error('links-manage 不消费 matchOnApplication')
    },
    describeOwn: async () => null,
    listForOrg: async () => [],
    confirm: async () => {},
    rebind: async () => {},
    revoke: async () => {},
    dispute: async () => false,
    ...spy,
  }
}

const get = (links: IdentityLinks | undefined, url: string) => buildApp(links).request(url)

const post = (links: IdentityLinks | undefined, url: string, body?: unknown) =>
  buildApp(links).request(url, {
    method: 'POST',
    ...(body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  })

describe('GET /identity-links', () => {
  it('回 {items}（无 total，单页），行形状透传服务视图', async () => {
    const listForOrg = vi.fn(async () => VIEWS)
    const res = await get(linksStub({ listForOrg }), '/identity-links')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: IdentityLinkView[]; total?: unknown }
    expect(body.items).toEqual(VIEWS)
    expect('total' in body).toBe(false)
    expect(listForOrg).toHaveBeenCalledWith(ORG, undefined)
  })

  it('?status=pending 透传服务；?status= 空串视同不过滤', async () => {
    const listForOrg = vi.fn(async () => VIEWS)
    const stub = linksStub({ listForOrg })
    await get(stub, '/identity-links?status=pending')
    expect(listForOrg).toHaveBeenCalledWith(ORG, 'pending')
    await get(stub, '/identity-links?status=')
    expect(listForOrg).toHaveBeenLastCalledWith(ORG, undefined)
  })

  it('?status 不是四态之一 ⇒ 400 INVALID_BODY，不进服务', async () => {
    const listForOrg = vi.fn(async () => VIEWS)
    const res = await get(linksStub({ listForOrg }), '/identity-links?status=weird')
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('INVALID_BODY')
    expect(listForOrg).not.toHaveBeenCalled()
  })
})

describe('POST /identity-links/:id/confirm', () => {
  it('★ 带目标 ⇒ confirm(org, id, 目标, {actor:"admin1"})，200 {ok:true}', async () => {
    const confirm = vi.fn(async () => {})
    const res = await post(linksStub({ confirm }), '/identity-links/7/confirm', { casdoorName: 'grace' })
    expect(res.status).toBe(200)
    expect(confirm).toHaveBeenCalledWith(ORG, 7, 'grace', { actor: 'admin1' })
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true)
  })

  it('空体 ⇒ 缺省目标（casdoorName=undefined），actor 照传', async () => {
    const confirm = vi.fn(async () => {})
    const res = await post(linksStub({ confirm }), '/identity-links/7/confirm')
    expect(res.status).toBe(200)
    expect(confirm).toHaveBeenCalledWith(ORG, 7, undefined, { actor: 'admin1' })
  })

  it('casdoorName 空串/非串 ⇒ 400，不进服务', async () => {
    const confirm = vi.fn(async () => {})
    for (const bad of [{ casdoorName: '' }, { casdoorName: 3 }, { casdoorName: null }]) {
      const res = await post(linksStub({ confirm }), '/identity-links/7/confirm', bad)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe('INVALID_BODY')
    }
    expect(confirm).not.toHaveBeenCalled()
  })

  it('LINK_TARGET_MISSING ⇒ 400（客户端给的目标不存在，可改可重试）', async () => {
    const confirm = vi.fn(async () => {
      throw new LinkError('LINK_TARGET_MISSING')
    })
    const res = await post(linksStub({ confirm }), '/identity-links/7/confirm', {})
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('LINK_TARGET_MISSING')
  })
})

describe('POST /identity-links/:id/rebind', () => {
  it('★ 带 casdoorName ⇒ rebind(org, id, 目标, {actor:"admin1"})', async () => {
    const rebind = vi.fn(async () => {})
    const res = await post(linksStub({ rebind }), '/identity-links/8/rebind', { casdoorName: 'lily' })
    expect(res.status).toBe(200)
    expect(rebind).toHaveBeenCalledWith(ORG, 8, 'lily', { actor: 'admin1' })
  })

  it('★ 缺参（无 body / casdoorName 缺失/空串）⇒ 400，不进服务', async () => {
    const rebind = vi.fn(async () => {})
    for (const body of [undefined, {}, { casdoorName: '' }]) {
      const res = await post(linksStub({ rebind }), '/identity-links/8/rebind', body)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe('INVALID_BODY')
    }
    expect(rebind).not.toHaveBeenCalled()
  })
})

describe('POST /identity-links/:id/revoke', () => {
  it('★ 无 body ⇒ revoke(org, id, "admin1")（revoked_by=identity.userId 由服务落）', async () => {
    const revoke = vi.fn(async () => {})
    const res = await post(linksStub({ revoke }), '/identity-links/8/revoke')
    expect(res.status).toBe(200)
    expect(revoke).toHaveBeenCalledWith(ORG, 8, 'admin1')
  })

  it('LINK_NOT_FOUND ⇒ 404 NOT_FOUND（他 org/已删 id 同路，不泄露存在性）', async () => {
    const revoke = vi.fn(async () => {
      throw new LinkError('LINK_NOT_FOUND')
    })
    const res = await post(linksStub({ revoke }), '/identity-links/8/revoke')
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toBe('NOT_FOUND')
  })
})

describe('公共守卫', () => {
  it('★ identityLinks 缺省 ⇒ 四端点一律 503 IDENTITY_LINKS_UNAVAILABLE', async () => {
    for (const hit of [
      get(undefined, '/identity-links'),
      post(undefined, '/identity-links/7/confirm', {}),
      post(undefined, '/identity-links/7/rebind', { casdoorName: 'x' }),
      post(undefined, '/identity-links/7/revoke'),
    ]) {
      const res = await hit
      expect(res.status).toBe(503)
      expect(((await res.json()) as { error: string }).error).toBe('IDENTITY_LINKS_UNAVAILABLE')
    }
  })

  it('非规范 id（1e5/0）⇒ 404，不进服务（parseIdParam 口径：只收十进制正整数字面量）', async () => {
    const confirm = vi.fn(async () => {})
    const revoke = vi.fn(async () => {})
    const stub = linksStub({ confirm, revoke })
    for (const url of ['/identity-links/1e5/confirm', '/identity-links/0/confirm', '/identity-links/1e5/revoke']) {
      const res = await post(stub, url, {})
      expect(res.status).toBe(404)
      expect(((await res.json()) as { error: string }).error).toBe('NOT_FOUND')
    }
    expect(confirm).not.toHaveBeenCalled()
    expect(revoke).not.toHaveBeenCalled()
  })
})
