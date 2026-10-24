// sandbox-runner.ts —— 沙箱**执行面**的客户端（#1002 / D-W3-4）。
//
// 执行面是单元 A 的 `sandbox-console`（`duckle-runner serve`，无宿主端口），
// 决策与全部口径在 `docs/architecture.md` §2.8。下面每条 HTTP 形状都在真机容器里实测过（2026-10-23）：
//   · `POST /api/run` 体 `{"file":"<工作区相对路径>"}`，`Authorization: Bearer $DUCKLE_TOKEN`；
//     **同步**：挂到整条跑完才回，响应体 `{id,runId,status,durationMs,error,nodes:[…]}`；
//   · 草案解析不过 ⇒ 同步立即 `400`，body 是引擎原话（`missing field …`）；
//   · 客户端断开**不取消**运行（实测：10s 断开、引擎仍跑到 71.4s 并落回执）；
//   · `<workspace>/runs/receipts/*.json` 由引擎自产，只在「我们不等了」时用来捡结果。
//
// 三条纪律：
//   · **不抛业务错误**：跑失败（管线红了）是正常产出，走 `status: 'failed'`；
//     只有「根本连不上 / 鉴权不过 / 回的不是 JSON」才抛 `SandboxUnreachableError`——
//     「跑不了」和「跑失败」是两件事，混在一起会让人去改草案（错的方向）。
//   · **不谎报 running**：等不到终态就是 `timeout`（不知道），由上层说「不知道」，不说「还在跑」。
//   · **回执读不到不算失败**：它只是超时后的补救来源（尽力而为）。
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface SandboxRunnerConfig {
  /** `DATA_SANDBOX_URL`，如 `http://sandbox-console:18090` */
  baseUrl: string
  /** `DATA_SANDBOX_TOKEN`（= console 的 `DUCKLE_TOKEN`） */
  token: string
  /** `DATA_SANDBOX_DIR`：server 侧看到的共享卷路径（写草案、读回执） */
  dir: string
  /**
   * `DATA_SANDBOX_TIMEOUT_MS`：**愿意为一次试跑持有多久**（不是轮询上限）。
   * 到点只是我们不等了——引擎侧仍在跑（实测断连不取消）。
   */
  timeoutMs: number
  /**
   * 试跑结束后保留最近多少份草案（`sandbox/<runId>.json`）；`<1` = 不清理。
   * 清理是尽力而为：只碰符合 runId 模式的文件，失败不影响本次结果（§2.8「并发与清理」）。
   */
  keepDrafts?: number
}

export interface SandboxOutcome {
  /** `timeout` = 没拿到终态（不知道跑完没）；`parse_error` = 引擎不认这份草案，一个节点都没跑。 */
  status: 'ok' | 'failed' | 'timeout' | 'parse_error'
  /** 我们为这次试跑写的文件名主干 */
  runId: string
  /** 工作区相对路径 `sandbox/<runId>.json` */
  file: string
  /** 引擎自己的 runId（同步响应带；超时/回执路径可能没有） */
  engineRunId?: string
  durationMs?: number
  /** sink 节点行数之和（拿得到时） */
  rows?: number
  error?: string
  /** 逐节点结果（同步响应是数组，回执是 map——形状随来源，原样透传） */
  nodes?: unknown
}

export interface SandboxRunner {
  run(draft: unknown, runId: string): Promise<SandboxOutcome>
}

/** 执行面不可达（网络 / 非 2xx（400 除外）/ 非 JSON）。**不是**管线跑失败。 */
export class SandboxUnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SandboxUnreachableError'
  }
}

/** 与 compose 里 `server` 的挂载点一致（`sandbox-workspace:/run/duckle-sandbox`）。 */
export const SANDBOX_DEFAULT_DIR = '/run/duckle-sandbox'
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_KEEP_DRAFTS = 20
/** 回执 mtime 与我们的开始时刻之间允许的时钟毛刺。 */
const CLOCK_SKEW_MS = 2_000
/** runId 会变成文件名主干 ⇒ 只收安全字符，路径注入在触盘前就挡掉。 */
const RUN_ID_RE = /^[a-z0-9][a-z0-9-]*$/
/** 保留策略只碰自己写的草案（`<runId>.json`）；别的文件一律不动。 */
const DRAFT_FILE_RE = /^[a-z0-9][a-z0-9-]*\.json$/

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number | undefined =>
  (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** 引擎状态词汇（实测 `ok / error / interrupted / cancelled`）→ 三态；空串 = 认不出。 */
const normalizeStatus = (raw: string): 'ok' | 'failed' | 'running' | null => {
  if (raw === 'ok' || raw === 'success') return 'ok'
  if (raw === 'running' || raw === 'queued' || raw === 'pending') return 'running'
  if (raw === '') return null
  // error / interrupted / cancelled / failed / 任何没见过的词 ⇒ 按失败报，并保留原文
  return 'failed'
}

const intOf = (raw: string | undefined, fallback: number): number => {
  const n = Number.parseInt((raw ?? '').trim(), 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** 保留份数与 `intOf` 不同：`0`/负数是合法语义（= 不清理），要原样通过。 */
const keepOf = (raw: string | undefined, fallback: number): number => {
  const n = Number.parseInt((raw ?? '').trim(), 10)
  return Number.isFinite(n) ? n : fallback
}

/** 400 的 body 是引擎原话（JSON `{error}` 或纯文本）——两种都要能读出来。 */
const engineError = (text: string): string => {
  const trimmed = text.trim()
  if (trimmed === '') return '引擎拒绝解析这份草案（400，无正文）'
  try {
    const doc: unknown = JSON.parse(trimmed)
    if (isObj(doc) && str(doc.error) !== '') return str(doc.error)
  } catch {
    // 不是 JSON：原样用
  }
  return trimmed
}

/** 超时/中止：`AbortSignal.timeout` 抛 TimeoutError，手工 abort 抛 AbortError。 */
const isAbort = (err: unknown): boolean =>
  err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')

export interface SandboxRunnerIo {
  /** 注入用（测试不连网） */
  fetchImpl?: typeof fetch
  /** 注入用（测试推进假时钟） */
  now?: () => number
}

export const createSandboxRunner = (cfg: SandboxRunnerConfig, io: SandboxRunnerIo = {}): SandboxRunner => {
  const fetchImpl = io.fetchImpl ?? fetch
  const now = io.now ?? Date.now
  const receiptsDir = join(cfg.dir, 'runs', 'receipts')

  /**
   * §2.8「并发与清理」：草案不许无限增长。只认自己写的 `<runId>.json`（runId 模式已在写入前挡过
   * 路径注入），按 mtime 保留最近 keep 份；单飞（`sandbox.ts`）保证同一 workspace 没有并发试跑，
   * 不会与在写的草案互踩。全程尽力而为——任何一步失败都静默跳过，调用方不受影响。
   */
  const cleanupDrafts = async (draftsDir: string, keep: number): Promise<void> => {
    if (keep < 1) return
    let names: string[]
    try {
      names = await readdir(draftsDir)
    } catch {
      return
    }
    const drafts: { name: string; mtimeMs: number }[] = []
    for (const name of names) {
      if (!DRAFT_FILE_RE.test(name)) continue
      try {
        const st = await stat(join(draftsDir, name))
        drafts.push({ name, mtimeMs: st.mtimeMs })
      } catch {
        // 正被写/已被清：下一轮再看
      }
    }
    drafts.sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const { name } of drafts.slice(keep)) {
      await rm(join(draftsDir, name), { force: true }).catch(() => {})
    }
  }

  /** 回执目录快照；读不到就返回空集（不是错误——回执只是兜底来源）。 */
  const listReceipts = async (): Promise<string[]> => {
    try {
      return (await readdir(receiptsDir)).filter((n) => n.endsWith('.json'))
    } catch {
      return []
    }
  }

  /**
   * 找**本次**试跑新产生的回执。靠「开始前快照里没有 + mtime 不早于开始时刻」认领——
   * 回执文件名不含我们写的 `file`，这是唯一可靠的认领方式；单飞（`sandbox.ts`）保证同一 workspace
   * 同一时刻只有一次试跑，所以新回执不会认错人。
   */
  const freshReceipt = async (seen: string[], startedAt: number): Promise<SandboxOutcome | null> => {
    const names = await listReceipts()
    const fresh: { name: string; mtimeMs: number }[] = []
    for (const name of names) {
      if (seen.includes(name)) continue
      try {
        const st = await stat(join(receiptsDir, name))
        if (st.mtimeMs >= startedAt - CLOCK_SKEW_MS) fresh.push({ name, mtimeMs: st.mtimeMs })
      } catch {
        // 回执可能正被引擎写入后删改：读不到就下一轮再看
      }
    }
    fresh.sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const { name } of fresh) {
      let doc: unknown
      try {
        doc = JSON.parse(await readFile(join(receiptsDir, name), 'utf8')) as unknown
      } catch {
        continue
      }
      const outcome = receiptOutcome(doc, name)
      if (outcome !== null) return outcome
    }
    return null
  }

  const receiptOutcome = (doc: unknown, name: string): SandboxOutcome | null => {
    if (!isObj(doc)) return null
    const status = normalizeStatus(str(doc.status))
    if (status === null || status === 'running') return null
    const nodes = doc.nodes
    const sinkRows = isObj(nodes) && isObj(nodes.sink) ? num((nodes.sink as Record<string, unknown>).rows) : undefined
    const durationMs = num(doc.durationMs) ?? spanMs(doc.startedAt, doc.finishedAt)
    const error = str(doc.error)
    const base = { runId: '', file: name, ...(durationMs === undefined ? {} : { durationMs }), ...(sinkRows === undefined ? {} : { rows: sinkRows }) }
    if (status === 'failed') return { ...base, status, ...(error === '' ? {} : { error }) }
    return { ...base, status, nodes }
  }

  /** 同步响应的形状：`{id,runId,status,durationMs,error,nodes:[…]}`。 */
  const syncOutcome = (body: unknown, draft: unknown, runId: string, file: string): SandboxOutcome => {
    if (!isObj(body)) throw new SandboxUnreachableError('/api/run 返回的不是 JSON 对象')
    const status = normalizeStatus(str(body.status))
    if (status === null) throw new SandboxUnreachableError('/api/run 响应缺 status')
    const engineRunId = str(body.runId) || undefined
    const durationMs = num(body.durationMs)
    const nodes = body.nodes
    const base = {
      runId, file,
      ...(engineRunId === undefined ? {} : { engineRunId }),
      ...(durationMs === undefined ? {} : { durationMs }),
    }
    // 同步接口只该回终态；真回了 running（异常形状）就按「没拿到终态」处理，不谎报在跑。
    if (status === 'running') return { ...base, status: 'timeout' }
    const rows = sinkRows(draft, nodes)
    const withRows = { ...base, ...(rows === undefined ? {} : { rows }) }
    if (status === 'ok') return { ...withRows, status, ...(nodes === undefined ? {} : { nodes }) }
    const error = str(body.error)
    return { ...withRows, status, ...(error === '' ? {} : { error }), ...(nodes === undefined ? {} : { nodes }) }
  }

  /** sink 节点的行数：按草案里 `type:'sink'` 的节点 id 到响应里取，避免把源/中间节点重复计。 */
  const sinkRows = (draft: unknown, nodes: unknown): number | undefined => {
    if (!Array.isArray(nodes) || !isObj(draft) || !Array.isArray(draft.nodes)) return undefined
    const sinkIds = new Set<string>()
    for (const n of draft.nodes) {
      if (!isObj(n)) continue
      if (str(n.type) === 'sink' && str(n.id) !== '') sinkIds.add(str(n.id))
    }
    if (sinkIds.size === 0) return undefined
    let total: number | undefined
    for (const n of nodes) {
      if (!isObj(n)) continue
      if (!sinkIds.has(str(n.id))) continue
      const rows = num(n.rows)
      if (rows === undefined) continue
      total = (total ?? 0) + rows
    }
    return total
  }

  const run = async (draft: unknown, runId: string): Promise<SandboxOutcome> => {
    if (!RUN_ID_RE.test(runId)) throw new Error(`非法 runId：${runId}`)
    const file = `sandbox/${runId}.json`
    const absDir = join(cfg.dir, 'sandbox')
    await mkdir(absDir, { recursive: true })
    await writeFile(join(absDir, `${runId}.json`), `${JSON.stringify(draft, null, 2)}\n`, 'utf8')

    const startedAt = now()
    const seen = await listReceipts()

    const runOnce = async (): Promise<SandboxOutcome> => {

    let res: Response
    try {
      res = await fetchImpl(`${cfg.baseUrl}/api/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
        body: JSON.stringify({ file }),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      })
    } catch (err) {
      if (!isAbort(err)) throw new SandboxUnreachableError(`/api/run 不可达：${errText(err)}`)
      // 预算耗尽 ≠ 失败：引擎侧仍在跑（实测断连不取消）⇒ 先捡一次回执，捡不到就说「不知道」。
      const receipt = await freshReceipt(seen, startedAt)
      if (receipt !== null) return { ...receipt, runId, file }
      return { status: 'timeout', runId, file }
    }

    // 400 是引擎的原话（解析不过），不是执行面坏了。
    if (res.status === 400) {
      const text = await res.text().catch(() => '')
      return { status: 'parse_error', runId, file, error: engineError(text) }
    }
    if (!res.ok) throw new SandboxUnreachableError(`/api/run → HTTP ${res.status}`)
    const text = await res.text().catch(() => '')
    let body: unknown
    try {
      body = JSON.parse(text) as unknown
    } catch {
      throw new SandboxUnreachableError('/api/run 返回的不是 JSON')
    }
    return syncOutcome(body, draft, runId, file)
    }

    // 草案清理挂在所有出口上（ok / failed / parse_error / timeout / 不可达）：
    // 本次草案是最新一份，必在保留集内 ⇒ 「用 runId 对应的草案继续追」的口径不受影响。
    try {
      return await runOnce()
    } finally {
      await cleanupDrafts(absDir, cfg.keepDrafts ?? DEFAULT_KEEP_DRAFTS).catch(() => {})
    }
  }

  return { run }
}

const spanMs = (from: unknown, to: unknown): number | undefined => {
  const a = typeof from === 'string' ? Date.parse(from) : Number.NaN
  const b = typeof to === 'string' ? Date.parse(to) : Number.NaN
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : undefined
}

/**
 * 未配 `DATA_SANDBOX_URL` ⇒ `null`：seam 语义不变，工具回 `not_executed / sandbox_runner_unconfigured`。
 * 配了 URL 但没配 token 也算「配了」：真会 401 ⇒ 报 `unknown / sandbox_unreachable`（显式失败，不静默降级）。
 */
export const sandboxRunnerFromEnv = (env: Record<string, string | undefined>): SandboxRunner | null => {
  const baseUrl = (env.DATA_SANDBOX_URL ?? '').trim().replace(/\/+$/, '')
  if (baseUrl === '') return null
  const dir = (env.DATA_SANDBOX_DIR ?? '').trim() || SANDBOX_DEFAULT_DIR
  return createSandboxRunner({
    baseUrl,
    token: (env.DATA_SANDBOX_TOKEN ?? '').trim(),
    dir,
    timeoutMs: intOf(env.DATA_SANDBOX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    keepDrafts: keepOf(env.DATA_SANDBOX_KEEP_DRAFTS, DEFAULT_KEEP_DRAFTS),
  })
}
