// scripts/executor-server.test.ts —— 纯函数（请求体解析 + 鉴权），不起服务器、不连库。
//
// 钉两件事：
//   ① 请求体只带排班元数据；缺字段/类型不对 ⇒ 明确报错（不静默用默认值跑一个作业）；
//   ② 鉴权只有「Bearer <token>」一种形态，token 为空一律拒绝。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { authorized, parseRunRequest } from './executor-server.mjs'

const base = {
  runId: 42, scheduleId: 7, key: 'data.dbt_tick',
  occurrence: '2026-11-20T06:00:00.000Z', attempt: 1, maxAttempts: 1, timeoutMs: 300000,
  params: {}, isRetry: false, ownerOrg: null, ownerNamespace: null, manual: false,
}

describe('executor parseRunRequest', () => {
  it('正常请求 ⇒ 还原成 ClaimedJob 形状（occurrence 是 Date）', () => {
    const r = parseRunRequest(base)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.job.runId).toBe(42)
    expect(r.job.key).toBe('data.dbt_tick')
    expect(r.job.occurrence).toBeInstanceOf(Date)
    expect(r.job.occurrence.toISOString()).toBe('2026-11-20T06:00:00.000Z')
  })

  it('★ 缺 runId / scheduleId / key ⇒ 明确报错（不拿默认值凑合跑）', () => {
    expect(parseRunRequest({ ...base, runId: undefined })).toMatchObject({ ok: false })
    expect(parseRunRequest({ ...base, scheduleId: 0 })).toMatchObject({ ok: false })
    expect(parseRunRequest({ ...base, key: '' })).toMatchObject({ ok: false })
  })

  it('★ occurrence 解析不了 ⇒ 报错', () => {
    expect(parseRunRequest({ ...base, occurrence: 'not-a-date' })).toMatchObject({ ok: false })
  })

  it('非对象请求体 ⇒ 报错', () => {
    expect(parseRunRequest(null)).toMatchObject({ ok: false })
    expect(parseRunRequest('x')).toMatchObject({ ok: false })
  })

  it('★ 请求体里带 script/args 也不生效（只认 key，脚本由本进程 registry 解析）', () => {
    const r = parseRunRequest({ ...base, script: 'scripts/evil.mjs', args: ['--rm'] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(Object.keys(r.job)).not.toContain('script')
    expect(Object.keys(r.job)).not.toContain('args')
  })
})

describe('executor authorized', () => {
  it('Bearer 命中才放行；空 token 一律拒绝', () => {
    expect(authorized('Bearer abc', 'abc')).toBe(true)
    expect(authorized('Bearer abd', 'abc')).toBe(false)
    expect(authorized('abc', 'abc')).toBe(false)
    expect(authorized('Bearer ', '')).toBe(false)
    expect(authorized(undefined, 'abc')).toBe(false)
  })
})

describe('executor 心跳接线（#2835）', () => {
  // 为什么是「读源码断言」而不是起进程：heartbeat 是进程级副作用（setInterval + 库），
  // 起真进程要连库、跑满一个周期才有观测点，成本远高于它要守的风险。
  // 它守的风险很硬：`reapStale` 会按「该 runner 心跳过期 5 分钟」回收在跑的作业——
  // **一旦这里的心跳被删/被改名**，活着的执行器作业会被当成死 runner 误杀（5 分钟后判 timeout）。
  it('★ 本进程必须周期写 platform.job_heartbeat（否则 reapStale 会误杀活作业）', () => {
    const src = readFileSync(new URL('./executor-server.mjs', import.meta.url), 'utf8')
    expect(src).toMatch(/import \{[^}]*\bbeat\b[^}]*\} from '\.\.\/apps\/server\/src\/scheduler\/store\.ts'/)
    expect(src).toMatch(/beat\(pool, new Date\(\), instanceId\)/)
    expect(src).toMatch(/setInterval\(heartbeat, 10_000\)/)
  })
})
