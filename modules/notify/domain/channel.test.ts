// channel.test.ts — bridge healthz 映射（fetch 注入）
import { describe, it, expect, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import { checkWecomDirectHealth, checkWecomHealth, checkWebhookHealth } from './channel'
import { __resetTokenCache } from './im/wecom-direct'

/** 没有 DB 凭据行的最小 pool：走 env 兜底。 */
const emptyPool = { query: async () => ({ rowCount: 0, rows: [] }) } as unknown as Pool

const BRIDGE = 'https://push.example/wecom/woke?t=tok'

describe('checkWecomHealth', () => {
  it('200 ⇒ ok；URL 取 host 根 /healthz', async () => {
    let seen = ''
    const f = (async (url: string) => {
      seen = String(url)
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch
    expect(await checkWecomHealth(BRIDGE, f)).toEqual({ ok: true })
    expect(seen).toBe('https://push.example/healthz')
  })

  it('非 200 ⇒ detail HTTP 状态', async () => {
    const f = (async () => new Response('bad', { status: 503 })) as unknown as typeof fetch
    expect(await checkWecomHealth(BRIDGE, f)).toEqual({ ok: false, detail: 'HTTP 503' })
  })

  it('网络异常 ⇒ detail 错误信息', async () => {
    const f = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    expect(await checkWecomHealth(BRIDGE, f)).toMatchObject({ ok: false, detail: 'ECONNREFUSED' })
  })
})

describe('checkWebhookHealth', () => {
  const ok = async () => new Response(null, { status: 204 })
  const safe = async () => ['93.184.216.34']

  it('2xx ⇒ ok', async () => {
    expect(await checkWebhookHealth({
      url: 'https://hooks.example.com/x', key: 'k',
      fetchImpl: ok as unknown as typeof fetch, resolveHost: safe,
    })).toEqual({ ok: true })
  })

  it('非 2xx ⇒ detail 带码与摘要', async () => {
    const bad = async () => new Response('x', { status: 500 })
    expect(await checkWebhookHealth({
      url: 'https://hooks.example.com/x', key: 'k',
      fetchImpl: bad as unknown as typeof fetch, resolveHost: safe,
    })).toMatchObject({ ok: false, detail: '500: webhook HTTP 500' })
  })

  it('不安全 URL ⇒ 不探测直接失败', async () => {
    let called = false
    const spy = async () => { called = true; return new Response(null, { status: 204 }) }
    const r = await checkWebhookHealth({
      url: 'https://10.0.0.7/x', key: 'k', fetchImpl: spy as unknown as typeof fetch,
    })
    expect(r.ok).toBe(false)
    expect(called).toBe(false)
  })
})

describe('checkWecomDirectHealth（直连判据 = 能取到 token）', () => {
  beforeEach(() => __resetTokenCache())

  it('无 DB 行且 env 缺凭据 ⇒ credential_missing（不再报 bridge_url 未配置）', async () => {
    expect(await checkWecomDirectHealth({
      pool: emptyPool, org: 'acme', env: {},
    })).toEqual({ ok: false, detail: 'credential_missing' })
  })

  it('env 凭据能换 token ⇒ ok', async () => {
    const f = (async () => new Response(JSON.stringify({
      errcode: 0, access_token: 'tok', expires_in: 7200,
    }))) as unknown as typeof fetch
    expect(await checkWecomDirectHealth({
      pool: emptyPool, org: 'acme',
      env: { WECOM_DIRECT__ACME: 'corp|1|secret' },
      fetchImpl: f,
    })).toEqual({ ok: true })
  })

  it('env 凭据换不到 token ⇒ 带 detail 的失败', async () => {
    const f = (async () => new Response(JSON.stringify({
      errcode: 40013, errmsg: 'invalid corpid',
    }))) as unknown as typeof fetch
    const r = await checkWecomDirectHealth({
      pool: emptyPool, org: 'acme',
      env: { WECOM_DIRECT__ACME: 'corp|1|secret' },
      fetchImpl: f,
    })
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('40013')
  })
})
