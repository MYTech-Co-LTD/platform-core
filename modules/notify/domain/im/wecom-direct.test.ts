// wecom-direct.test.ts — 企微直连：token 缓存 / 单飞 / errcode 分类（spec §3.1/§3.3）
import { beforeEach, describe, it, expect } from 'vitest'
import { __resetTokenCache, accessToken, classifyErrcode, probeDirect, sendDirect } from './wecom-direct'

const cred = { corpId: 'ww1234567890abcd', agentId: '1000009', secret: 's' }
const API = 'https://api.test'

/** 假 fetch：按 order 依次返回；记录调用次数。 */
function fakeFetch(responses: Array<() => Response>) {
  let i = 0
  const calls: string[] = []
  const f = (async (url: string) => {
    calls.push(String(url))
    const r = responses[Math.min(i, responses.length - 1)]!
    i += 1
    return r()
  }) as unknown as typeof fetch
  return { f, calls, count: () => i }
}
const tokenOk = () => new Response(JSON.stringify({ errcode: 0, access_token: 'tok', expires_in: 7200 }))
const sendOk = () => new Response(JSON.stringify({ errcode: 0 }))
const sendCode = (errcode: number) => () => new Response(JSON.stringify({ errcode, errmsg: `e${errcode}` }))

beforeEach(() => __resetTokenCache())

describe('accessToken', () => {
  it('★ 缓存：第二次不再请求', async () => {
    const { f, count } = fakeFetch([tokenOk])
    const a = await accessToken(cred, { fetchImpl: f, apiBase: API })
    const b = await accessToken(cred, { fetchImpl: f, apiBase: API })
    expect(a.token).toBe('tok')
    expect(b.token).toBe('tok')
    expect(count()).toBe(1)
  })

  it('★ 单飞：并发只打一次', async () => {
    const { f, count } = fakeFetch([tokenOk])
    const [a, b] = await Promise.all([
      accessToken(cred, { fetchImpl: f, apiBase: API }),
      accessToken(cred, { fetchImpl: f, apiBase: API }),
    ])
    expect(a.token).toBe('tok')
    expect(b.token).toBe('tok')
    expect(count()).toBe(1)
  })

  it('gettoken 失败 ⇒ 抛错并带 errcode', async () => {
    const { f } = fakeFetch([() => new Response(JSON.stringify({ errcode: 40013, errmsg: 'invalid corpid' }))])
    await expect(accessToken(cred, { fetchImpl: f, apiBase: API })).rejects.toMatchObject({ errcode: 40013 })
  })
})

describe('sendDirect', () => {
  it('errcode 0 ⇒ ok，且请求体带 touser/agentid/markdown', async () => {
    let body = ''
    const f = (async (_u: string, init?: RequestInit) => {
      if (String(_u).includes('gettoken')) return tokenOk()
      body = String(init?.body ?? '')
      return sendOk()
    }) as unknown as typeof fetch
    const r = await sendDirect({ cred, to: 'ZhangDuo', content: 'hi', fetchImpl: f, apiBase: API })
    expect(r).toEqual({ ok: true })
    expect(JSON.parse(body)).toMatchObject({ touser: 'ZhangDuo', agentid: 1000009, markdown: { content: 'hi' } })
  })

  it('★ 42001（token 过期）⇒ 刷新一次后重试成功', async () => {
    let n = 0
    const f = (async (u: string) => {
      if (String(u).includes('gettoken')) return tokenOk()
      n += 1
      return n === 1 ? sendCode(42001)() : sendOk()
    }) as unknown as typeof fetch
    const r = await sendDirect({ cred, to: 'u', content: 'x', fetchImpl: f, apiBase: API })
    expect(r).toEqual({ ok: true })
    expect(n).toBe(2)
  })

  it('★ 81013（用户不存在）⇒ 永久失败（重试无用）', async () => {
    const f = (async (u: string) => (String(u).includes('gettoken') ? tokenOk() : sendCode(81013)())) as unknown as typeof fetch
    const r = await sendDirect({ cred, to: 'nobody', content: 'x', fetchImpl: f, apiBase: API })
    expect(r).toMatchObject({ ok: false, kind: 'permanent', code: '81013' })
  })

  it('★ 45009（频率超限）⇒ 可重试', async () => {
    const f = (async (u: string) => (String(u).includes('gettoken') ? tokenOk() : sendCode(45009)())) as unknown as typeof fetch
    const r = await sendDirect({ cred, to: 'u', content: 'x', fetchImpl: f, apiBase: API })
    expect(r).toMatchObject({ ok: false, kind: 'retryable', code: '45009' })
  })
})

describe('classifyErrcode', () => {
  it('token/频率类可重试，其余永久', () => {
    for (const c of [40001, 42001, 40014, 45009, 45033, -1, undefined]) expect(classifyErrcode(c)).toBe('retryable')
    for (const c of [81013, 60020, 40013, 301002]) expect(classifyErrcode(c)).toBe('permanent')
  })
})

describe('probeDirect', () => {
  it('能取到 token ⇒ ok；取不到 ⇒ 带 detail 的失败', async () => {
    const ok = fakeFetch([tokenOk])
    expect(await probeDirect(cred, { fetchImpl: ok.f, apiBase: API })).toEqual({ ok: true })
    __resetTokenCache()
    const bad = fakeFetch([() => new Response(JSON.stringify({ errcode: 40013, errmsg: 'invalid corpid' }))])
    const r = await probeDirect(cred, { fetchImpl: bad.f, apiBase: API })
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('40013')
  })
})
