// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { platformFetch } from './platform-fetch'

/**
 * platformFetch：模块用户端（web/console）唯一 API 客户端。
 * 约定（任务书锁定）：透传 globalThis.fetch；credentials 默认 same-origin（init 已带不覆盖）；
 * 响应 401 → 写 location.href = /login?next=<pathname+hash 编码> 后抛 Error('UNAUTHENTICATED')；
 * /login 页例外（Task 17 评审 fix-1）：登录页自身 401 原样返回（账密登录失败即 401+{error}）。
 */

/**
 * happy-dom 的 location.pathname 是原型上的 getter（实例只读）：
 * 用实例级 Object.defineProperty 遮蔽（configurable:true），delete 还原原型 getter——
 * 不用 vi.spyOn/replaceProperty（对 accessor 原型属性两种写法在 happy-dom 下均不稳）。
 */
function stubPathname(pathname: string): void {
  Object.defineProperty(window.location, 'pathname', { value: pathname, configurable: true })
}

afterEach(() => {
  vi.unstubAllGlobals()
  // 还原 pathname 实例级 stub（无 stub 时 delete 非 own 属性是无害 no-op）
  delete (window.location as Partial<Location> & { pathname?: string }).pathname
  location.hash = ''
})

describe('platformFetch', () => {
  it('401 → 跳 /login?next= 并抛 UNAUTHENTICATED', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })))
    location.hash = '#/tickets/42'

    await expect(platformFetch('/api/whoami')).rejects.toThrow('UNAUTHENTICATED')
    // 浏览器/happy-dom 的 location.href 读回为绝对 URL，故断言解析后的 path + search
    expect(location.pathname).toBe('/login')
    expect(location.search).toBe('?next=' + encodeURIComponent('/#/tickets/42'))
  })

  it('200 → 原样透传 Response', async () => {
    const res = new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    const fetchMock = vi.fn(async () => res)
    vi.stubGlobal('fetch', fetchMock)

    const out = await platformFetch('/api/things')
    expect(out).toBe(res)
    expect(out.status).toBe(200)
    expect(await out.json()).toEqual({ ok: true })
  })

  it('credentials 默认 same-origin；init 已带 credentials 时不覆盖', async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await platformFetch('/api/a')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: 'same-origin' })

    await platformFetch('/api/b', { credentials: 'include', method: 'POST' })
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ credentials: 'include', method: 'POST' })
  })

  // —— Task 17 评审 fix-1：/login 页 401 例外（账密登录失败也是 401，重定向会丢错误码+自旋重载）——

  it('401 且已在 /login：不跳转不抛，Response 原样返回（错误体归调用方解析）', async () => {
    // 清掉前面用例残留的重定向 URL（pushState 真实改写），再以 defineProperty 遮蔽演示 stub 用法
    window.history.pushState({}, '', '/login')
    stubPathname('/login')
    const res401 = new Response('{"error":"BAD_CREDENTIALS"}', {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
    vi.stubGlobal('fetch', vi.fn(async () => res401))

    const out = await platformFetch('/api/platform/auth/login', { method: 'POST' })

    expect(out).toBe(res401)
    expect(out.status).toBe(401)
    expect(location.pathname).toBe('/login')
    expect(location.search).toBe('') // 未发生 /login?next= 新重定向
  })

  it('401 在 /login 以外路径：跳转+抛照旧（回归不变式，深路径实证）', async () => {
    location.href = '/console/tickets' // happy-dom 同文档改写真实 URL（pathname 随之真实变化）
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })))

    await expect(platformFetch('/api/things')).rejects.toThrow('UNAUTHENTICATED')
    expect(location.pathname).toBe('/login')
    expect(location.search).toBe('?next=' + encodeURIComponent('/console/tickets'))
  })
})
