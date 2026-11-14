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
  /** 超时后 SIGTERM → SIGKILL 的宽限期；默认 5000ms（测试可缩短，免得等 5s）。 */
  killGraceMs?: number
}
export interface SpawnResult {
  code: number | null
  signal: string | null
  timedOut: boolean
  outputTail: string
  durationMs: number
}
export type SpawnFn = (o: SpawnOpts) => Promise<SpawnResult>

/** 台账口径是 4KB：这里按**字节**保留尾部（不是字符——CJK 3 字节/字，按字符会到 12KB）。 */
const TAIL_BYTES = 4096
const DEFAULT_KILL_GRACE_MS = 5000

/** 只留尾部 TAIL_BYTES 字节；从中间切开时丢掉开头半个 UTF-8 字符，避免 U+FFFD 吃掉汉字。 */
function capTail(b: Buffer): Buffer {
  if (b.length <= TAIL_BYTES) return b
  const cut = b.subarray(b.length - TAIL_BYTES)
  let i = 0
  while (i < cut.length && (cut[i] & 0xc0) === 0x80) i += 1 // 跳过被切开的字符的续字节
  return cut.subarray(i)
}

export const defaultSpawn: SpawnFn = (o) => new Promise((resolve) => {
  const started = Date.now()
  const child = nodeSpawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] })
  let tail = Buffer.alloc(0)
  let timedOut = false
  // 按 Buffer 累积、结束时才解码：跨 chunk 的 UTF-8 字符不会被切成 U+FFFD。
  const append = (chunk: Buffer): void => { tail = capTail(tail.length === 0 ? chunk : Buffer.concat([tail, chunk])) }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  const killer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
    setTimeout(() => child.kill('SIGKILL'), o.killGraceMs ?? DEFAULT_KILL_GRACE_MS).unref()
  }, o.timeoutMs)
  killer.unref()
  child.on('error', (e) => {
    clearTimeout(killer)
    // spawn 级错误信息也进同一个尾部上限（否则 ENOENT 长消息能绕过 4KB）。
    const withErr = capTail(Buffer.concat([tail, Buffer.from(`\n${e.message}`, 'utf8')]))
    resolve({ code: null, signal: null, timedOut, outputTail: withErr.toString('utf8'), durationMs: Date.now() - started })
  })
  child.on('close', (code, signal) => {
    clearTimeout(killer)
    resolve({ code, signal: signal ?? null, timedOut, outputTail: tail.toString('utf8'), durationMs: Date.now() - started })
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
  delete env.JOB_RUN_ID
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
  // 到这里 code=null 即 spawn 级错误（ENOENT/EACCES…）：配置错，重试也不会好（与 exit 2 同档）。
  const configError = r.code === null
  return {
    status: 'failed', exitCode: r.code, durationMs: r.durationMs, outputTail: r.outputTail,
    error: configError ? 'spawn error' : r.signal ? `signal ${r.signal}` : `exit ${String(r.code)}`,
    retryable: !configError && r.code !== 2,
  }
}
