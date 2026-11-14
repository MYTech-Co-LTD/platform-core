// runner.ts — 子进程执行器：注入契约、超时 kill、退出码分类。
//
// 为什么 argv 数组 spawn 且 params 走 stdin：argv/环境在网络与进程列表里都可见，把「参数」写成
// 命令行或 env 等于把业务参数广播给同机所有人。stdin 只有父子进程知道，且没有长度上限问题。
import { spawn as nodeSpawn } from 'node:child_process'
import type { ClaimedJob, RunOutcome } from './store'

export interface SpawnOpts {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  stdin: string
  timeoutMs: number
  cwd: string
}
export interface SpawnResult {
  code: number | null
  signal: string | null
  timedOut: boolean
  outputTail: string
  durationMs: number
}
export type SpawnFn = (o: SpawnOpts) => Promise<SpawnResult>

const TAIL_BYTES = 4096

export const defaultSpawn: SpawnFn = (o) => new Promise((resolve) => {
  const started = Date.now()
  const child = nodeSpawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] })
  let tail = ''
  let timedOut = false
  const append = (chunk: Buffer): void => {
    tail += chunk.toString('utf8')
    if (tail.length > TAIL_BYTES) tail = tail.slice(-TAIL_BYTES)
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  const killer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
    setTimeout(() => child.kill('SIGKILL'), 5000).unref()
  }, o.timeoutMs)
  killer.unref()
  child.on('error', (e) => {
    clearTimeout(killer)
    resolve({ code: null, signal: null, timedOut, outputTail: `${tail}\n${e.message}`, durationMs: Date.now() - started })
  })
  child.on('close', (code, signal) => {
    clearTimeout(killer)
    resolve({ code, signal: signal ?? null, timedOut, outputTail: tail, durationMs: Date.now() - started })
  })
  if (child.stdin) {
    child.stdin.on('error', () => {}) // 子进程不读 stdin 时 EPIPE 不算失败
    child.stdin.end(o.stdin)
  }
})

/** 只放小标量；`params` 必须走 stdin。`runId` 是台账行 id，不进 env。 */
export function envFor(job: ClaimedJob): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  env.JOB_KEY = job.key
  env.JOB_SCHEDULE_ID = String(job.scheduleId)
  env.JOB_OCCURRENCE = job.occurrence.toISOString()
  delete env.JOB_PARAMS
  if (job.ownerOrg) env.JOB_OWNER_ORG = job.ownerOrg; else delete env.JOB_OWNER_ORG
  if (job.ownerNamespace) env.JOB_OWNER_NAMESPACE = job.ownerNamespace; else delete env.JOB_OWNER_NAMESPACE
  return env
}

export function paramsStdin(job: ClaimedJob): string {
  const s = JSON.stringify(job.params ?? {})
  if (Buffer.byteLength(s, 'utf8') > 16 * 1024) throw new Error('JOB_PARAMS 超过 16KB')
  return s
}

export function classify(r: SpawnResult): RunOutcome & { retryable: boolean } {
  if (r.timedOut) {
    return { status: 'timeout', exitCode: r.code, durationMs: r.durationMs, outputTail: r.outputTail, error: 'timeout', retryable: true }
  }
  if (r.code === 0) {
    return { status: 'ok', exitCode: 0, durationMs: r.durationMs, outputTail: r.outputTail, retryable: false }
  }
  return {
    status: 'failed', exitCode: r.code, durationMs: r.durationMs, outputTail: r.outputTail,
    error: r.signal ? `signal ${r.signal}` : `exit ${String(r.code)}`,
    retryable: r.code !== 2,
  }
}
