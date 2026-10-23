// sandbox-runner.ts —— 沙箱**执行面**的客户端（#1002 / D-W3-4）。
//
// 执行面是单元 A 的 `sandbox-console`（`duckle-runner serve`，无宿主端口），
// 决策与全部口径在 `docs/architecture.md` §2.8。下面每条 HTTP 形状都在真机容器里实测过（2026-10-23）：
//   · `POST /api/run/async` 体 `{"file":"<工作区相对路径>"}`，`Authorization: Bearer $DUCKLE_TOKEN`；
//   · `GET  /api/runs`      汇总（status / durationMs / rows / error），**没有**唯一 runId；
//   · `<workspace>/runs/receipts/*.json` 由引擎自产，逐节点明细只在这里。
//
// 两条纪律：
//   · **不抛业务错误**：跑失败（管线红了）是正常产出，走 `status: 'failed'`；
//     只有「根本连不上 / 鉴权不过 / 回的不是 JSON」才抛 `SandboxUnreachableError`——
//     「跑不了」和「跑失败」是两件事，混在一起会让人去改草案（错的方向）。
//   · **回执读不到不算失败**：它只是明细来源（尽力而为），终态判定不依赖它。
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface SandboxRunnerConfig {
  /** `DATA_SANDBOX_URL`，如 `http://sandbox-console:18090` */
  baseUrl: string
  /** `DATA_SANDBOX_TOKEN`（= console 的 `DUCKLE_TOKEN`） */
  token: string
  /** `DATA_SANDBOX_DIR`：server 侧看到的共享卷路径（写草案、读回执） */
  dir: string
  /** `DATA_SANDBOX_TIMEOUT_MS`：等一次试跑的上限，超时返回 `running`（不判失败） */
  timeoutMs: number
  /** 轮询间隔（测试注入小值） */
  intervalMs?: number
}

export interface SandboxOutcome {
  status: 'ok' | 'failed' | 'running'
  /** 我们为这次试跑写的文件名主干（引擎的 `/api/runs` 汇总不带唯一 id） */
  runId: string
  /** 工作区相对路径 `sandbox/<runId>.json` */
  file: string
  durationMs?: number
  rows?: number
  error?: string
  nodes?: Record<string, unknown>
}

export interface SandboxRunner {
  run(draft: unknown, runId: string): Promise<SandboxOutcome>
}

/** 执行面不可达（网络 / 非 2xx / 非 JSON）。**不是**管线跑失败。 */
export class SandboxUnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SandboxUnreachableError'
  }
}

/** 与 compose 里 `server` 的挂载点一致（`sandbox-workspace:/run/duckle-sandbox`）。 */
export const SANDBOX_DEFAULT_DIR = '/run/duckle-sandbox'
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_INTERVAL_MS = 1_000
/** 单个 HTTP 请求的超时（与整次试跑的 `timeoutMs` 是两回事）。 */
const REQUEST_TIMEOUT_MS = 10_000
/** 回执 mtime 与我们的开始时刻之间允许的时钟毛刺。 */
const CLOCK_SKEW_MS = 2_000
/** runId 会变成文件名主干 ⇒ 只收安全字符，路径注入在触盘前就挡掉。 */
const RUN_ID_RE = /^[a-z0-9][a-z0-9-]*$/

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number | undefined =>
  (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** 引擎状态词汇（实测 `ok / error / interrupted / cancelled`，另见 running/queued）→ 三态。 */
const normalizeStatus = (raw: string): SandboxOutcome['status'] | null => {
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

export interface SandboxRunnerIo {
  /** 注入用（测试不连网） */
  fetchImpl?: typeof fetch
  /** 注入用（测试不想真等） */
  sleep?: (ms: number) => Promise<void>
  /** 注入用（测试推进假时钟） */
  now?: () => number
}

export const createSandboxRunner = (cfg: SandboxRunnerConfig, io: SandboxRunnerIo = {}): SandboxRunner => {
  const fetchImpl = io.fetchImpl ?? fetch
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = io.now ?? Date.now
  const intervalMs = cfg.intervalMs !== undefined && cfg.intervalMs >= 0 ? cfg.intervalMs : DEFAULT_INTERVAL_MS
  const receiptsDir = join(cfg.dir, 'runs', 'receipts')

  const call = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    let res: Response
    try {
      res = await fetchImpl(`${cfg.baseUrl}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      throw new SandboxUnreachableError(`${path} 不可达：${errText(err)}`)
    }
    if (!res.ok) throw new SandboxUnreachableError(`${path} → HTTP ${res.status}`)
    // 空体合法（`/api/run/async` 可能只回 202）——空 ≠ 坏。
    const text = await res.text().catch(() => '')
    if (text.trim() === '') return null
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new SandboxUnreachableError(`${path} 返回的不是 JSON`)
    }
  }

  /** 回执目录快照；读不到就返回空集（不是错误——回执只是明细来源）。 */
  const listReceipts = async (): Promise<string[]> => {
    try {
      return (await readdir(receiptsDir)).filter((n) => n.endsWith('.json'))
    } catch {
      return []
    }
  }

  /**
   * 找**本次**试跑新产生的回执。靠「开始前快照里没有 + mtime 不早于开始时刻」认领——
   * 回执文件名不含我们写的 `file`，这是唯一可靠的认领方式；单飞（Task 3）保证同一 workspace
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
    if (status === null) return null
    const nodes = isObj(doc.nodes) ? doc.nodes : undefined
    const sinkRows = nodes !== undefined && isObj(nodes.sink) ? num((nodes.sink as Record<string, unknown>).rows) : undefined
    const durationMs = num(doc.durationMs) ?? spanMs(doc.startedAt, doc.finishedAt)
    const error = str(doc.error)
    const base = { runId: '', file: name, ...(durationMs === undefined ? {} : { durationMs }), ...(sinkRows === undefined ? {} : { rows: sinkRows }) }
    if (status === 'running') return { ...base, status }
    if (status === 'failed') return { ...base, status, ...(error === '' ? {} : { error }) }
    return { ...base, status, ...(nodes === undefined ? {} : { nodes }) }
  }

  /** `GET /api/runs` 里找本次条目；没有 / 仍在跑 ⇒ `null`（继续轮询）。 */
  const findRun = async (file: string, name: string): Promise<SandboxOutcome | null> => {
    const body = await call('/api/runs')
    const runs = Array.isArray(body) ? body : isObj(body) && Array.isArray(body.runs) ? body.runs : []
    const matches = runs.filter((r) => {
      if (!isObj(r)) return false
      return str(r.file) === file || (name !== '' && str(r.name) === name)
    })
    for (const r of matches.reverse()) {
      if (!isObj(r)) continue
      const status = normalizeStatus(str(r.status))
      if (status === null || status === 'running') continue
      const durationMs = num(r.durationMs)
      const rows = num(r.rows)
      const error = str(r.error)
      return {
        status,
        runId: '',
        file,
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(rows === undefined ? {} : { rows }),
        ...(status === 'failed' && error !== '' ? { error } : {}),
      }
    }
    return null
  }

  const run = async (draft: unknown, runId: string): Promise<SandboxOutcome> => {
    if (!RUN_ID_RE.test(runId)) throw new Error(`非法 runId：${runId}`)
    const file = `sandbox/${runId}.json`
    const absDir = join(cfg.dir, 'sandbox')
    await mkdir(absDir, { recursive: true })
    await writeFile(join(absDir, `${runId}.json`), `${JSON.stringify(draft, null, 2)}\n`, 'utf8')

    const startedAt = now()
    const seen = await listReceipts()
    const name = isObj(draft) ? str(draft.name) : ''
    // 先起跑再轮询：/api/run/async 立即返回，跑完的证据来自回执或 /api/runs。
    await call('/api/run/async', { method: 'POST', body: JSON.stringify({ file }) })

    const deadline = startedAt + cfg.timeoutMs
    for (;;) {
      const receipt = await freshReceipt(seen, startedAt)
      if (receipt !== null && receipt.status !== 'running') return { ...receipt, runId, file }
      const summary = await findRun(file, name)
      if (summary !== null) return { ...summary, runId, file }
      // 超时 ≠ 失败：引擎可能还在跑。如实报 running + runId，让人用 get/list 去追。
      if (now() >= deadline) return { status: 'running', runId, file }
      await sleep(intervalMs)
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
  })
}
