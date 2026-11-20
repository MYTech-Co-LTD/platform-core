// scripts/probe-emit.test.ts —— 纯逻辑（env 取值 / 鉴权头 / 投递成功与降级），注入 fetch。
//
// 钉三件事：
//   ① 三元组两套命名都认（应用单元 OO_READ_*，数据单元 OO_BASE/OO_ORG/OO_AUTH）；
//   ② 缺凭据 ⇒ skipped（不抛、不发请求）；
//   ③ 投递失败只返回 {ok:false}——**绝不改变调用方的判定与退出码**。
import { describe, expect, it } from 'vitest'
import { authHeader, emitFailure, emitProbe, ooEnv } from './probe-emit.mjs'

describe('probe-emit ooEnv / authHeader', () => {
  it('两套命名都认，只读三元组优先', () => {
    expect(ooEnv({ OO_READ_URL: 'https://a', OO_READ_ORG: 'o1', OO_READ_TOKEN: 't1', OO_BASE: 'https://b' }))
      .toEqual({ base: 'https://a', org: 'o1', token: 't1' })
    expect(ooEnv({ OO_BASE: 'https://b/', OO_ORG: 'o2', OO_AUTH: 't2' }))
      .toEqual({ base: 'https://b', org: 'o2', token: 't2' })
  })

  it('裸 base64 补 Basic；已带前缀原样', () => {
    expect(authHeader('abc')).toBe('Basic abc')
    expect(authHeader('Bearer x')).toBe('Bearer x')
  })
})

describe('probe-emit emitProbe', () => {
  it('★ 缺凭据 ⇒ skipped，且不发请求', async () => {
    let called = 0
    const r = await emitProbe({ check: 'c', verdict: 'ERR' }, {
      env: {}, fetchImpl: async () => { called += 1; return new Response('', { status: 200 }) },
    })
    expect(r).toMatchObject({ ok: false, skipped: true })
    expect(called).toBe(0)
  })

  it('★ 200 且回执 successful:1 ⇒ ok', async () => {
    const seen: string[] = []
    const r = await emitProbe({ check: 'verify_x', verdict: 'ERR', detail: 'boom' }, {
      env: { OO_READ_URL: 'https://oo', OO_READ_ORG: 'org', OO_READ_TOKEN: 't' },
      fetchImpl: async (url, init) => {
        seen.push(String(url)); seen.push(String((init as { headers?: Record<string, string> }).headers?.Authorization))
        return new Response('{"code":200,"status":[{"successful":1,"failed":0}]}', { status: 200 })
      },
    })
    expect(r.ok).toBe(true)
    expect(seen[0]).toBe('https://oo/api/org/data_plane_probes/_json')
    expect(seen[1]).toBe('Basic t')
  })

  it('★ 投递失败只返回 ok:false（不抛）', async () => {
    const r = await emitProbe({ check: 'c', verdict: 'ERR' }, {
      env: { OO_READ_URL: 'https://oo', OO_READ_ORG: 'org', OO_READ_TOKEN: 't' },
      fetchImpl: async () => { throw new Error('network down') },
    })
    expect(r).toMatchObject({ ok: false })
    expect(String(r.error)).toMatch(/network down/)
  })
})

describe('probe-emit emitFailure', () => {
  it('永不抛：fetch 抛错也只返回结果', async () => {
    await expect(emitFailure('c', 'd', {
      env: { OO_READ_URL: 'https://oo', OO_READ_ORG: 'org', OO_READ_TOKEN: 't' },
      fetchImpl: async () => { throw new Error('x') },
    })).resolves.toMatchObject({ ok: false })
  })
})
