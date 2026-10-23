// run-source.ts —— 运行记录的**真实来源**：duckle console workspace 的 `runs/` 目录（只读挂载）。
//
// 目录形状（2026-10-23 在 shanhai 控制面实测）：
//   <dir>/<pipeline_id>.json       JSON 数组，每管线保留 50 条；
//                                  status 的真实词汇是 ok / error / interrupted / cancelled
//   <dir>/receipts/<runId>.json    单次收据，带 `nodes` 逐节点明细
//
// 为什么要挂载而不是走 HTTP：console 的 /api/runs 不带 runId、只覆盖已登记管线，
// 且端口只绑回环（跨 compose 项目不可达）。详见 runs.ts 顶部与 #1001。
//
// 纪律（与 defs.ts 读面同规）：
//   · **不抛**：坏文件进 warnings，目录读不到进 unreadable——读不到 ≠ 空。
//   · **用户输入永不拼路径**：pipelineId 由调用方先过 PIPELINE_ID_RE，runId 过 RUN_ID_RE，
//     本文件再兜一次；非法值在触盘前就拒绝。
//   · **同一 pipeline_id 可在多个账套各有一份**（3120 / 64188）⇒ 每条记录带 `source`，
//     不合并、不判重（合并了就分不清是谁家跑的）。
//   · 截断信号：任一被扫描文件达到 MAX_PER_PIPELINE ⇒ `truncated`（list）/ `absenceProven=false`（get）。
//     收据的保留量**不参与**「缺席可证」判定：收据是明细缓存，且实测保留量（>5000）与
//     README 写的 200 不符（待核实）；若某次运行在所有可读证据里都不存在，
//     「查不到」就是关于现有记录的事实，口径写在这里，不在代码里猜保留策略。
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PIPELINE_ID_RE, RUN_ID_RE } from './defs'
import type {
  PipelineRunRecord,
  PipelineRunSource,
  RunGetResult,
  RunListQuery,
  RunListResult,
  RunSourceIssue,
} from './types'

/** per-管线保留量（console 实测：文件恰好停在 50 条）。到达即「更早的看不到」。 */
export const MAX_PER_PIPELINE = 50
/** `<账套名>=<runs 目录>`，逗号分隔。缺省/空白 ⇒ 不接通（seam 语义不变）。 */
export const RUN_DIRS_ENV = 'DATA_RUN_DIRS'

interface Workspace { name: string; dir: string }

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number | undefined =>
  (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

type Parsed = { ok: true; value: unknown } | { ok: false; detail: string }
const readJson = (p: string): Parsed => {
  try {
    return { ok: true, value: JSON.parse(readFileSync(p, 'utf8')) as unknown }
  } catch (err) {
    return { ok: false, detail: errText(err) }
  }
}

/**
 * 解析 `DATA_RUN_DIRS`。畸形条目**不静默丢弃**：整份配置作废并回报 config 错误——
 * 少一个账套而当成正常，会让「另一个账套的管线」静默消失（最危险的一类假绿）。
 */
function parseDirs(raw: string): { workspaces: Workspace[]; errors: string[] } {
  const workspaces: Workspace[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  for (const part of raw.split(',')) {
    const item = part.trim()
    if (item === '') continue
    const i = item.indexOf('=')
    if (i <= 0) { errors.push(`条目缺少 <账套名>=<目录>：${item}`); continue }
    const name = item.slice(0, i).trim()
    const dir = item.slice(i + 1).trim()
    if (!/^[A-Za-z0-9_-]+$/.test(name)) { errors.push(`账套名非法：${name}`); continue }
    if (!dir.startsWith('/')) { errors.push(`目录必须是绝对路径：${name}=${dir}`); continue }
    if (seen.has(name)) { errors.push(`账套名重复：${name}`); continue }
    seen.add(name)
    workspaces.push({ name, dir: dir.replace(/\/+$/, '') || '/' })
  }
  return { workspaces, errors }
}

/** 引擎词汇 → 记录词汇。`error` 归一到 `failed`，其余原样；未知值不折叠成 failed（那是编造）。 */
const STATUS_MAP: Record<string, PipelineRunRecord['status']> = {
  ok: 'ok', running: 'running', cancelled: 'cancelled', interrupted: 'interrupted', error: 'failed',
}
function normalizeStatus(raw: string): { status: PipelineRunRecord['status']; rawStatus?: string } {
  const s = raw.trim().toLowerCase()
  const mapped = STATUS_MAP[s]
  if (mapped !== undefined) return { status: mapped, ...(s === 'error' ? { rawStatus: raw } : {}) }
  return { status: 'unknown', ...(raw === '' ? {} : { rawStatus: raw }) }
}

function recordFromListEntry(e: Record<string, unknown>, pipelineId: string, source: string): PipelineRunRecord | null {
  const runId = str(e.run_id)
  if (runId === '') return null
  const { status, rawStatus } = normalizeStatus(str(e.status))
  return {
    runId, pipelineId, startedAt: str(e.at), status,
    ...(rawStatus === undefined ? {} : { rawStatus }),
    ...(num(e.rows) === undefined ? {} : { rows: num(e.rows) }),
    ...(str(e.error) === '' ? {} : { error: str(e.error) }),
    ...(num(e.duration_ms) === undefined ? {} : { durationMs: num(e.duration_ms) }),
    ...(str(e.trigger) === '' ? {} : { trigger: str(e.trigger) }),
    source,
  }
}

function recordFromReceipt(r: Record<string, unknown>, source: string): PipelineRunRecord | null {
  const runId = str(r.runId)
  if (runId === '') return null
  const path = str(r.pipelinePath)
  const fromPath = path === '' ? '' : path.slice(path.lastIndexOf('/') + 1).replace(/\.json$/, '')
  const { status, rawStatus } = normalizeStatus(str(r.status))
  return {
    runId, pipelineId: str(r.pipelineName) || fromPath,
    // 收据的 `at` 是入队时刻；`startedAt` 才是真实开始时间（README「今天跑没跑」节）。
    startedAt: str(r.startedAt) || str(r.at),
    status,
    ...(rawStatus === undefined ? {} : { rawStatus }),
    ...(num(r.rows) === undefined ? {} : { rows: num(r.rows) }),
    ...(str(r.error) === '' ? {} : { error: str(r.error) }),
    ...(num(r.durationMs) === undefined ? {} : { durationMs: num(r.durationMs) }),
    ...(str(r.trigger) === '' ? {} : { trigger: str(r.trigger) }),
    source,
  }
}

const byRecency = (a: PipelineRunRecord, b: PipelineRunRecord): number =>
  a.startedAt === b.startedAt ? a.runId.localeCompare(b.runId) : (a.startedAt < b.startedAt ? 1 : -1)

/** 全量收集（list 与 get 的回退扫描共用）。`limit` 由调用方裁剪，这里只负责「读全、排序」。 */
function collect(workspaces: Workspace[], pipelineId: string | undefined): RunListResult {
  const runs: PipelineRunRecord[] = []
  const unreadable: RunSourceIssue[] = []
  const warnings: string[] = []
  let truncatedByCap = false
  for (const ws of workspaces) {
    let names: string[]
    try {
      names = readdirSync(ws.dir)
    } catch (err) {
      unreadable.push({ workspace: ws.name, detail: errText(err) })
      continue
    }
    const files = pipelineId === undefined
      ? names.filter((f) => f.endsWith('.json') && PIPELINE_ID_RE.test(f.slice(0, -'.json'.length))).sort()
      : names.filter((f) => f === `${pipelineId}.json`)
    for (const f of files) {
      const pid = f.slice(0, -'.json'.length)
      const parsed = readJson(join(ws.dir, f))
      if (!parsed.ok) { warnings.push(`${ws.name}/${f} 不可解析：${parsed.detail}`); continue }
      if (!Array.isArray(parsed.value)) { warnings.push(`${ws.name}/${f} 不是记录数组`); continue }
      const entries = parsed.value.filter(isObj)
      if (entries.length >= MAX_PER_PIPELINE) truncatedByCap = true
      let skipped = 0
      for (const e of entries) {
        const rec = recordFromListEntry(e, pid, ws.name)
        if (rec === null) { skipped += 1; continue }
        runs.push(rec)
      }
      if (skipped > 0) warnings.push(`${ws.name}/${f} 有 ${skipped} 条缺 run_id 的记录已跳过`)
    }
  }
  runs.sort(byRecency)
  return { runs, truncated: truncatedByCap, unreadable, warnings, scanned: runs.length }
}

async function listRuns(workspaces: Workspace[], q: RunListQuery): Promise<RunListResult> {
  if (q.pipelineId !== undefined && !PIPELINE_ID_RE.test(q.pipelineId)) {
    return {
      runs: [], truncated: false, warnings: [], scanned: 0,
      unreadable: [{ workspace: '(param)', detail: 'invalid_pipeline_id' }],
    }
  }
  const all = collect(workspaces, q.pipelineId)
  const limited = all.runs.slice(0, q.limit)
  return { ...all, runs: limited, truncated: all.truncated || all.scanned > limited.length }
}

async function getRun(workspaces: Workspace[], runId: string): Promise<RunGetResult> {
  if (!RUN_ID_RE.test(runId)) {
    return {
      run: null, absenceProven: false, warnings: [], scanned: 0,
      unreadable: [{ workspace: '(param)', detail: 'invalid_run_id' }],
    }
  }
  const unreadable: RunSourceIssue[] = []
  const warnings: string[] = []
  // ① 直读收据：这是唯一能证明「这条运行存在」的单点证据，且不受 50 条窗口影响。
  for (const ws of workspaces) {
    const p = join(ws.dir, 'receipts', `${runId}.json`)
    let raw: string
    try {
      raw = readFileSync(p, 'utf8')
    } catch (err) {
      // ENOENT = 这个来源没有这条收据（正常）；其余（EACCES 等）= 读不到，缺席不可证。
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      unreadable.push({ workspace: ws.name, detail: errText(err) })
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch (err) {
      warnings.push(`${ws.name}/receipts/${runId}.json 不可解析：${errText(err)}`)
      continue
    }
    if (!isObj(parsed)) { warnings.push(`${ws.name}/receipts/${runId}.json 不是对象`); continue }
    const rec = recordFromReceipt(parsed, ws.name)
    if (rec === null) { warnings.push(`${ws.name}/receipts/${runId}.json 缺 runId`); continue }
    return { run: rec, absenceProven: false, receipt: parsed, unreadable, warnings, scanned: 1 }
  }
  // ② 回退：收据被裁掉、但 per-管线记录还在 ⇒ 仍算命中。
  const all = collect(workspaces, undefined)
  const hit = all.runs.find((r) => r.runId === runId)
  const issues = [...unreadable, ...all.unreadable]
  const mergedWarnings = [...warnings, ...all.warnings]
  if (hit !== undefined) {
    return { run: hit, absenceProven: false, unreadable: issues, warnings: mergedWarnings, scanned: all.scanned }
  }
  return {
    run: null,
    // 只有「全部来源读通 + 没有被截断的窗口」才敢说这条运行不存在。
    absenceProven: issues.length === 0 && !all.truncated,
    unreadable: issues,
    warnings: mergedWarnings,
    scanned: all.scanned,
  }
}

/** 配置畸形时的来源：每次调用都回报 config 错误（⇒ 工具回 unknown），不抛、也不伪装成「未接通」。 */
const misconfigured = (detail: string): PipelineRunSource => ({
  list: async () => ({
    runs: [], truncated: false, warnings: [], scanned: 0,
    unreadable: [{ workspace: '(config)', detail }],
  }),
  get: async () => ({
    run: null, absenceProven: false, warnings: [], scanned: 0,
    unreadable: [{ workspace: '(config)', detail }],
  }),
})

/**
 * env → 来源。**未配置返回 null**（seam：`runs_source_not_wired` 一字不改）；
 * 配置畸形返回「会报错的来源」（可辨，不静默降级）。
 */
export function runSourceFromEnv(env: Record<string, string | undefined>): PipelineRunSource | null {
  const raw = (env[RUN_DIRS_ENV] ?? '').trim()
  if (raw === '') return null
  const { workspaces, errors } = parseDirs(raw)
  if (errors.length > 0) return misconfigured(errors.join('；'))
  if (workspaces.length === 0) return misconfigured('未解析出任何账套目录')
  return {
    list: (q) => listRuns(workspaces, q),
    get: (runId) => getRun(workspaces, runId),
  }
}
