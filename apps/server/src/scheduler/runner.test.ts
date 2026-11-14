import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classify, defaultSpawn, envFor, paramsStdin } from './runner'
import type { ClaimedJob } from './store'

const job: ClaimedJob = {
  scheduleId: 7, key: 'notify.reconcile', occurrence: new Date('2026-11-14T02:07:00Z'),
  attempt: 1, params: { a: 1 }, timeoutMs: 1000, maxAttempts: 2, isRetry: false,
  ownerOrg: null, ownerNamespace: null, runId: 42,
}

/** 在父进程里种上「不该继承」的变量再调用 envFor——不种的话 delete 断言恒真。 */
function withStaleEnv<T>(fn: () => T): T {
  const keys = ['JOB_PARAMS', 'JOB_OWNER_ORG', 'JOB_OWNER_NAMESPACE', 'JOB_RUN_ID'] as const
  const saved = keys.map((k) => [k, process.env[k]] as const)
  for (const k of keys) process.env[k] = 'SHOULD_NOT_LEAK'
  try {
    return fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

describe('envFor', () => {
  it('小标量进 env；继承来的 params/runId/owner 一律清掉（params 走 stdin）', () => {
    const e = withStaleEnv(() => envFor(job))
    expect(e.JOB_KEY).toBe('notify.reconcile')
    expect(e.JOB_SCHEDULE_ID).toBe('7')
    expect(e.JOB_OCCURRENCE).toBe('2026-11-14T02:07:00.000Z')
    expect(e.JOB_PARAMS).toBeUndefined()
    expect(e.JOB_OWNER_ORG).toBeUndefined()
    expect(e.JOB_OWNER_NAMESPACE).toBeUndefined()
    // runId 是台账行 id，不是排班 id；JOB_SCHEDULE_ID 只放排班 id。
    expect(e.JOB_RUN_ID).toBeUndefined()
  })

  it('有 owner 时才写 owner 变量（覆盖继承值）', () => {
    const e = withStaleEnv(() => envFor({ ...job, ownerOrg: 'shanhaiyiguo-org', ownerNamespace: 'demo' }))
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
  it('★ spawn 级错误（code=null、非超时）⇒ failed 且不重试', () => {
    const r = classify({ code: null, signal: null, timedOut: false, outputTail: '', durationMs: 1 })
    expect(r.status).toBe('failed')
    expect(r.retryable).toBe(false)
  })
  it('★ 超时 ⇒ timeout 且可重试（即使进程被信号杀掉）', () => {
    const r = classify({ code: null, signal: 'SIGKILL', timedOut: true, outputTail: '', durationMs: 1000 })
    expect(r.status).toBe('timeout')
    expect(r.retryable).toBe(true)
  })
})

// 真子进程用例：不注入假 spawn，验证 defaultSpawn 的退出码/杀进程行为在真机上成立。
// 用 process.execPath 而非字面量 `node`：CI 里 node 可能不在 PATH，但跑 vitest 的这个二进制一定在。
const opts = (script: string, timeoutMs: number, killGraceMs?: number) => ({
  command: process.execPath, args: ['-e', script], env: { ...process.env },
  stdin: '', timeoutMs, cwd: process.cwd(), ...(killGraceMs === undefined ? {} : { killGraceMs }),
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

  it('command 不存在（ENOENT）⇒ failed 且 retryable=false', async () => {
    const r = await defaultSpawn({ ...opts('', 5000), command: '/nonexistent/x' })
    expect(r.code).toBeNull()
    expect(r.timedOut).toBe(false)
    expect(classify(r).retryable).toBe(false)
    expect(r.outputTail).toContain('ENOENT')
  }, 10_000)

  it('★ 被外部信号杀死（自杀 SIGKILL）⇒ failed 但 retryable=true', async () => {
    const r = await defaultSpawn(opts("process.kill(process.pid, 'SIGKILL')", 5000))
    expect(r.code).toBeNull()
    expect(r.signal).toBe('SIGKILL')
    expect(r.timedOut).toBe(false)
    const c = classify(r)
    expect(c.status).toBe('failed')
    expect(c.retryable).toBe(true)
  }, 10_000)

  it('outputTail 按字节截到 4KB，且不把汉字切成 U+FFFD', async () => {
    // 12000 字节 CJK；从尾部切 4096 字节必然落在某个三字节字符中间。
    const r = await defaultSpawn(opts("process.stdout.write('中'.repeat(4000) + 'END')", 5000))
    expect(r.code).toBe(0)
    expect(Buffer.byteLength(r.outputTail, 'utf8')).toBeLessThanOrEqual(4096)
    expect(r.outputTail).not.toContain('�')
    expect(r.outputTail.endsWith('END')).toBe(true) // 保留的是尾部
  }, 10_000)

  it('★ 子进程忽略 SIGTERM ⇒ 宽限期后 SIGKILL 兜底杀掉', async () => {
    const r = await defaultSpawn(opts("process.on('SIGTERM', () => {}); setTimeout(() => {}, 10000)", 200, 100))
    expect(r.timedOut).toBe(true)
    expect(r.signal).toBe('SIGKILL')
    expect(r.durationMs).toBeGreaterThanOrEqual(200)
    expect(r.durationMs).toBeLessThan(5000)
  }, 10_000)

  it('★ 超时按进程组 kill：孙进程也死，且落定不依赖 close', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-kill-'))
    const pidFile = join(dir, 'grandchild.pid')
    // 父脚本与孙进程都忽略 SIGTERM；孙进程继承 stdout（模拟「孙进程握着管道」）。
    const script = `
      const { spawn } = require('node:child_process')
      const fs = require('node:fs')
      process.on('SIGTERM', () => {})
      const g = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setTimeout(()=>{},60000)"], { stdio: 'inherit' })
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid))
      setTimeout(() => {}, 60000)
    `
    try {
      const t0 = Date.now()
      const r = await defaultSpawn(opts(script, 500, 200))
      const elapsed = Date.now() - t0
      expect(r.timedOut).toBe(true)
      expect(r.signal).toBe('SIGKILL')
      // timeout 500 + grace 200 + exit 后 100ms 兜底 + ε：远小于脚本自己的 60s。
      expect(elapsed).toBeLessThan(3000)
      const pid = Number(readFileSync(pidFile, 'utf8'))
      const deadline = Date.now() + 2000
      let alive = true
      while (Date.now() < deadline) {
        try { process.kill(pid, 0) } catch { alive = false; break }
        await new Promise((res) => setTimeout(res, 50))
      }
      expect(alive).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  it('★ 宽限期内自行退出 ⇒ settle 后不再补发进程组 SIGKILL（哨兵存活）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-grace-'))
    const sentinelFile = join(dir, 'sentinel.pid')
    // 时间线：timeout 800 发 SIGTERM（父与哨兵都忽略）；父进程约 1.25s 自行 exit(0)；
    // grace 1000 ⇒ 宽限期 SIGKILL 本该在 ~1.8s 对整组触发。settle（~1.35s）必须清掉它。
    // timeout 给到 800ms 是为了让**嵌套启动的哨兵**有时间装好 SIGTERM handler（200ms 会太紧）。
    const script = `
      const { spawn } = require('node:child_process')
      const fs = require('node:fs')
      process.on('SIGTERM', () => {})
      const s = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setTimeout(()=>{},10000)"], { stdio: 'ignore' })
      fs.writeFileSync(${JSON.stringify(sentinelFile)}, String(s.pid))
      setTimeout(() => process.exit(0), 1200)
    `
    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
    let sentinel: number | null = null
    try {
      const r = await defaultSpawn(opts(script, 800, 1000))
      expect(r.timedOut).toBe(true)
      sentinel = Number(readFileSync(sentinelFile, 'utf8'))
      // ① settle 后（已越过 800ms 的 SIGTERM）哨兵应仍活着——排除「死于 SIGTERM」。
      expect(alive(sentinel)).toBe(true)
      // ② 越过宽限期 SIGKILL 本该触发的时刻（800 + 1000 = 1800ms）。
      await new Promise((res) => setTimeout(res, 900))
      expect(alive(sentinel)).toBe(true)
    } finally {
      if (sentinel !== null) { try { process.kill(sentinel, 'SIGKILL') } catch { /* 已退出 */ } }
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  it('★ 到点 SIGTERM 杀掉 ⇒ timedOut=true 且耗时落在 [200,5000)ms', async () => {
    const r = await defaultSpawn(opts('setTimeout(() => {}, 10000)', 200))
    expect(r.timedOut).toBe(true)
    // 下界证明「不是自然结束」（脚本要 10s）；上界证明 kill 真的生效、没等到进程自己退出。
    expect(r.durationMs).toBeGreaterThanOrEqual(200)
    expect(r.durationMs).toBeLessThan(5000)
  }, 10_000)
})
