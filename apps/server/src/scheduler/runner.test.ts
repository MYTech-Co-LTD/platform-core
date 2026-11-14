import { describe, expect, it } from 'vitest'
import { classify, defaultSpawn, envFor, paramsStdin } from './runner'
import type { ClaimedJob } from './store'

const job: ClaimedJob = {
  scheduleId: 7, key: 'notify.reconcile', occurrence: new Date('2026-11-14T02:07:00Z'),
  attempt: 1, params: { a: 1 }, timeoutMs: 1000, maxAttempts: 2, isRetry: false,
  ownerOrg: null, ownerNamespace: null, runId: 42,
}

describe('envFor', () => {
  it('小标量进 env；params/runId 不进 env（params 走 stdin）', () => {
    const e = envFor(job)
    expect(e.JOB_KEY).toBe('notify.reconcile')
    expect(e.JOB_SCHEDULE_ID).toBe('7')
    expect(e.JOB_OCCURRENCE).toBe('2026-11-14T02:07:00.000Z')
    expect(e.JOB_PARAMS).toBeUndefined()
    expect(e.JOB_OWNER_ORG).toBeUndefined()
    // runId 是台账行 id，不是排班 id；JOB_SCHEDULE_ID 只放排班 id。
    expect(e.JOB_RUN_ID).toBeUndefined()
  })

  it('有 owner 时才写 owner 变量（父进程遗留的空值会被清掉）', () => {
    const e = envFor({ ...job, ownerOrg: 'shanhaiyiguo-org', ownerNamespace: 'demo' })
    expect(e.JOB_OWNER_ORG).toBe('shanhaiyiguo-org')
    expect(e.JOB_OWNER_NAMESPACE).toBe('demo')
  })
})

describe('paramsStdin', () => {
  it('params 序列化为一行 JSON', () => {
    expect(paramsStdin(job)).toBe('{"a":1}')
  })
})

describe('classify', () => {
  it('exit 0 ⇒ ok', () => expect(classify({ code: 0, signal: null, timedOut: false, outputTail: '', durationMs: 1 }).status).toBe('ok'))
  it('★ exit 2 ⇒ failed 且不重试（判不了不重试）', () => {
    const r = classify({ code: 2, signal: null, timedOut: false, outputTail: '', durationMs: 1 })
    expect(r.status).toBe('failed')
    expect(r.retryable).toBe(false)
  })
  it('其他非 0 ⇒ failed 且可重试', () => {
    const r = classify({ code: 1, signal: null, timedOut: false, outputTail: '', durationMs: 1 })
    expect(r.retryable).toBe(true)
  })
  it('★ 超时 ⇒ timeout 且可重试（即使进程被信号杀掉）', () => {
    const r = classify({ code: null, signal: 'SIGKILL', timedOut: true, outputTail: '', durationMs: 1000 })
    expect(r.status).toBe('timeout')
    expect(r.retryable).toBe(true)
  })
})

// 真子进程用例：不注入假 spawn，验证 defaultSpawn 的退出码/杀进程行为在真机上成立。
// 用 process.execPath 而非字面量 `node`：CI 里 node 可能不在 PATH，但跑 vitest 的这个二进制一定在。
const opts = (script: string, timeoutMs: number) => ({
  command: process.execPath, args: ['-e', script], env: { ...process.env },
  stdin: '', timeoutMs, cwd: process.cwd(),
})

describe('defaultSpawn（真子进程）', () => {
  it('exit 0 ⇒ classify 得 ok', async () => {
    const r = await defaultSpawn(opts('process.exit(0)', 5000))
    expect(r.code).toBe(0)
    expect(r.timedOut).toBe(false)
    expect(classify(r).status).toBe('ok')
  }, 10_000)

  it('exit 2 ⇒ failed 且 retryable=false', async () => {
    const r = await defaultSpawn(opts('process.exit(2)', 5000))
    expect(r.code).toBe(2)
    expect(r.timedOut).toBe(false)
    const c = classify(r)
    expect(c.status).toBe('failed')
    expect(c.retryable).toBe(false)
  }, 10_000)

  it('子进程不读 stdin 就退出 ⇒ EPIPE 被吞掉，仍按退出码收尾', async () => {
    const big = 'x'.repeat(256 * 1024) // 超过管道缓冲（64KB），父进程写时子进程已退出
    const r = await defaultSpawn({ ...opts('process.exit(0)', 5000), stdin: big })
    expect(r.code).toBe(0)
    expect(classify(r).status).toBe('ok')
  }, 10_000)

  it('★ 到点 SIGTERM 杀掉 ⇒ timedOut=true 且耗时落在 [200,2000)ms', async () => {
    const r = await defaultSpawn(opts('setTimeout(() => {}, 10000)', 200))
    expect(r.timedOut).toBe(true)
    // 下界证明「不是自然结束」（脚本要 10s）；上界证明 kill 真的生效、没等到进程自己退出。
    expect(r.durationMs).toBeGreaterThanOrEqual(200)
    expect(r.durationMs).toBeLessThan(2000)
  }, 10_000)
})
