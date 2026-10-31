// integration-probe.test.ts — 探针编排（spec 2026-10-31 §2.2/§2.3）
//
// 关键断言只有三个方向：
//   ① registry 写错要**启动即炸**（kind/source/sla/id 重复）；
//   ② `sql` 查回 NULL 是「确实没动静」（判 STALE），**不是**探针失败（判 PROBE_FAILED）；
//   ③ 证据写回与判定用的是**刚采到的新证据**（不是旧行——那会慢一整个周期）。
import { describe, it, expect } from 'vitest'
import type { Pool } from 'pg'
import { existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { parseRegistry, probeEverySeconds, REGISTRY_PATH, runProbes } from './integration-probe'

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'x', kind: 'channel', source: 'http-healthz:BRIDGE', slaSeconds: 600, ...over,
})

describe('REGISTRY_PATH', () => {
  it('★ 指向仓根 deploy/ 且文件真实存在（生产实测踩过两层 ../ 的 ENOENT 坑）', () => {
    expect(REGISTRY_PATH.replace(/\\/g, '/')).toMatch(/platform-core[^/]*\/deploy\/integration-registry\.json$|\/deploy\/integration-registry\.json$/)
    expect(existsSync(REGISTRY_PATH)).toBe(true)
    // 顺带：真 registry 必须能通过严格校验（它自己就是被守卫的对象）
    expect(() => parseRegistry(JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')))).not.toThrow()
  })

  it('★ app.ts 只能引 REGISTRY_PATH 常量（不许再内联相对路径——#1205 第一版修复就栽在替换静默失败）', () => {
    const app = readFileSync(new URL('./app.ts', import.meta.url), 'utf8')
    expect(app).toContain('REGISTRY_PATH, startIntegrationProbeLoop')
    expect(app).not.toMatch(/new URL\(['"]\.\.\/.*integration-registry/)
  })
})

describe('parseRegistry', () => {
  it('合法条目通过，org 缺省为空串', () => {
    expect(parseRegistry({ integrations: [entry()] })).toEqual([
      { id: 'x', org: '', kind: 'channel', source: 'http-healthz:BRIDGE', slaSeconds: 600, note: undefined },
    ])
  })

  it('★ 写错就炸（而不是悄悄永远探不到）', () => {
    expect(() => parseRegistry({})).toThrow(/integrations/)
    expect(() => parseRegistry({ integrations: [entry({ kind: 'webhook' })] })).toThrow(/kind/)
    expect(() => parseRegistry({ integrations: [entry({ source: 'nonsense' })] })).toThrow(/source/)
    expect(() => parseRegistry({ integrations: [entry({ slaSeconds: 0 })] })).toThrow(/slaSeconds/)
    expect(() => parseRegistry({ integrations: [entry(), entry()] })).toThrow(/重复/)
  })
})

describe('probeEverySeconds', () => {
  it('SLA/4 并夹在 [60, 3600]', () => {
    expect(probeEverySeconds(300)).toBe(75)
    expect(probeEverySeconds(60)).toBe(60)
    expect(probeEverySeconds(93600)).toBe(3600)
  })
})

/** 极简假 pool：只认本文件用到的三条 SQL 形状。 */
function fakePool(state: {
  rows: Array<Record<string, unknown>>
  updates: Array<unknown[]>
  sqlValues?: Record<string, unknown>
}) {
  return {
    async query(sql: string, params?: unknown[]) {
      if (/insert into platform\.integration/.test(sql)) return { rows: [] }
      if (/^\s*select id, org, kind/.test(sql)) return { rows: state.rows }
      if (/^\s*update platform\.integration/.test(sql)) {
        state.updates.push(params ?? [])
        return { rows: [] }
      }
      if (/^\s*select /.test(sql)) {
        const key = String(sql).trim()
        const v = state.sqlValues?.[key] ?? null
        return { rows: [{ at: v }] }
      }
      return { rows: [] }
    },
  } as unknown as Pool
}

const baseRow = (over: Record<string, unknown> = {}) => ({
  id: 'x', org: '', kind: 'callback', source: 'sql:select max(t)', sla_seconds: 600,
  enabled: true, last_ok_at: null, last_probe_at: null, last_error: null, note: null, ...over,
})

describe('runProbes', () => {
  const now = () => new Date('2026-10-31T12:00:00Z')

  it('★ sql 查回 NULL ⇒ 判 STALE（不是 PROBE_FAILED）；写回 last_error=null', async () => {
    const state = { rows: [baseRow()], updates: [] as Array<unknown[]> }
    const r = await runProbes(
      { pool: fakePool(state), env: {}, fetchImpl: fetch, casdoorGetUser: async () => null, now },
      [],
    )
    expect(r.stale).toEqual(['x'])
    expect(r.probeFailed).toEqual([])
    expect(state.updates[0]?.[4]).toBeNull()   // last_error 保持 null
  })

  it('★ sql 查回时间 ⇒ OK，且 last_ok_at 用这条新证据', async () => {
    const state = {
      rows: [baseRow()], updates: [] as Array<unknown[]>,
      // 2026-10-31T11:59:00Z（1 分钟前，SLA 600s 内）。注意 fake 的键是**去掉 scheme 后**的 SQL
      sqlValues: { 'select max(t)': 1793447940 },
    }
    const r = await runProbes(
      { pool: fakePool(state), env: {}, fetchImpl: fetch, casdoorGetUser: async () => null, now },
      [],
    )
    expect(r.ok).toEqual(['x'])
    expect(state.updates[0]?.[3]).toBe(new Date(1793447940 * 1000).toISOString())
  })

  it('★ env 未配 ⇒ PROBE_FAILED 且点名缺哪个键（空壳通道就这么暴露）', async () => {
    const state = { rows: [baseRow({ kind: 'channel', source: 'http-healthz:BRIDGE' })], updates: [] as Array<unknown[]> }
    const r = await runProbes(
      { pool: fakePool(state), env: {}, fetchImpl: fetch, casdoorGetUser: async () => null, now },
      [],
    )
    expect(r.probeFailed).toEqual(['x'])
    expect(String(state.updates[0]?.[4])).toContain('BRIDGE')
  })

  it('未到探测间隔 ⇒ 跳过（不重复打外部系统）', async () => {
    const state = {
      rows: [baseRow({ last_probe_at: '2026-10-31T11:59:30Z' })], updates: [] as Array<unknown[]>,
    }
    const r = await runProbes(
      { pool: fakePool(state), env: {}, fetchImpl: fetch, casdoorGetUser: async () => null, now },
      [],
    )
    expect(r.probed).toBe(0)
    expect(state.updates).toHaveLength(0)
  })

  it('停用的行不探（也不进任何结论）', async () => {
    const state = { rows: [baseRow({ enabled: false })], updates: [] as Array<unknown[]> }
    const r = await runProbes(
      { pool: fakePool(state), env: {}, fetchImpl: fetch, casdoorGetUser: async () => null, now },
      [],
    )
    expect(r).toEqual({ probed: 0, staleTransitions: [], stale: [], probeFailed: [], ok: [] })
  })

  it('★ sql 两列 {at,error} 且 error 非空 ⇒ PROBE_FAILED 并带上原因（不是 STALE）', async () => {
    // 「证据由别的进程写出、它明说这次没探成」：如企微直连换不到 token。
    // 若把它当 NULL（没动静）判，会变成「沉默很久」——而真相是「凭据死了」，处置完全不同。
    const pool = {
      async query(sql: string) {
        if (/insert into platform\.integration/.test(sql)) return { rows: [] }
        if (/^\s*select id, org, kind/.test(sql)) {
          return { rows: [baseRow({ kind: 'token', source: 'sql:select last_ok_at as at, last_error as error from t' })] }
        }
        if (/^\s*update platform\.integration/.test(sql)) return { rows: [] }
        return { rows: [{ at: '2026-10-31T11:00:00Z', error: 'wecom gettoken errcode=40013 invalid corpid' }] }
      },
    } as unknown as Pool
    let lastError: unknown = null
    const recording = {
      async query(sql: string, params?: unknown[]) {
        if (/^\s*update platform\.integration/.test(sql)) lastError = params?.[4]
        return (pool as unknown as { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }).query(sql, params)
      },
    } as unknown as Pool
    const r = await runProbes(
      { pool: recording, env: {}, fetchImpl: fetch, casdoorGetUser: async () => null, now },
      [],
    )
    expect(r.probeFailed).toEqual(['x'])
    expect(String(lastError)).toContain('40013')
  })
})
