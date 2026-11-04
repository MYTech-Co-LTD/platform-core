#!/usr/bin/env node
// scripts/verify-ingest.mjs — W1 Task 5：平台侧摄入（OO 只读拉取 → 重放基线 → verified_questions）。
//
// 链路：bot 侧 `verify.py`（Task 4）把强/弱/负信号写进 OO 流 `askdata_verified`；本脚本用
// **新增的只读凭据**（`OO_READ_URL` / `OO_READ_ORG` / `OO_READ_TOKEN`）拉新事件，按事件里的
// `org`（租户隔离键）重放一次 `runQuery`，用 `summarize(QueryOk)` 生成基线后调 Task 1 的
// `upsertCandidate` 落库。**事件本身不带结果**（轨迹回包可能被截断/格式化，不可当基线）——
// 基线一律由摄入侧重放产生；重放失败则落 candidate + `last_check_result='error'`，不猜。
//
// 信号映射（计划 2026-11-04-amd-w1-verified-questions）：
//   · negative ⇒ 丢弃（不入集，只计数）；
//   · strong   ⇒ source='auto' / strength='strong'（Task 1 写入即 verified）；
//   · weak     ⇒ source='auto' / strength='weak'（candidate，等人工确认）。
//
// 水位（`ASK_VERIFY_INGEST_WM`；默认**按流一份** `/var/lib/askdata/verify-ingest.<stream>.watermark`）：
//   流名由 `ASK_VERIFY_STREAM` 决定（缺省 `askdata_verified`，与 bot 侧 `verify.py` 同名），
//   同时用于 `_search` 与默认水位文件名——换流时两边必须一起换，否则读到空流却以为「没新事件」。
//   · 值是 OO 命中的 `_timestamp`（微秒整数）。查询用 **`_timestamp >= 水位`** 取新记录：
//     OO 的 `_search` 时间窗是微秒 epoch（`start_time`/`end_time`），事件里的 `at`（RFC3339 UTC）
//     是**事件时间**，不能当摄入游标——迟到入库的事件 `at` 可能更早，用 `at` 会漏。
//     `_timestamp` 是 OO 的**入库时间**，单调向前。用 `>=`（不是 `>`）是为了**不丢同一微秒的
//     记录**（同一批入库的多条可能共享 `_timestamp`；边界组会在下一轮再读一次，靠唯一索引幂等
//     吸收）。排序加 `seq, sessionId` 次级键，避免同微秒组跨页重排导致漏读。
//   · **整轮成功后才写水位**（HTTP 失败、DB 写入失败都不前进）；写入为临时文件 + rename。
//   · `--since <ts>` 显式指定本次读取起点（RFC3339 或 epoch 秒/毫秒/微秒）。**晚于已存水位时
//     拒绝运行（exit 2）**：那会静默跳过 [水位, since) 区间；确需跳过先移走水位文件。
//   · 水位仍只前进不回退。
//
// 幂等：Task 1 的唯一索引 `(org, metric_id, md5(question), md5(params::text), md5(slicing::text))`
// 吸收重复投递（OO 重放、水位回退、batched 重评估都靠它）。
//
// 租户隔离：**只取事件里的 `org`**，不猜、不回落 `OO_READ_ORG`（那是 OO 自己的组织名，与平台
// 租户键不是同一命名空间）。`org` 为空 / 事件形状不合契约 ⇒ 跳过并计数；事件里的 org 解析不到
// 平台租户（`loadAdoptedSources` 抛「未知租户」）⇒ 也只跳过该条并计数，不炸其他租户。
//
// 部署前置（**新增 secret 需用户在部署时点名确认**）：server 服务行新增
// `OO_READ_URL` / `OO_READ_ORG` / `OO_READ_TOKEN`（**只读**）；取值位置 = 控制面 OO 凭据管理，
// 本仓/本文不写值。`DATABASE_URL` 沿用项目 env（`--dry-run` 不需要）。
//
// 用法：
//   npx tsx scripts/verify-ingest.mjs [--once] [--dry-run] [--since <RFC3339|epoch>]
//
// `--dry-run`：不重放、不落库、不写水位。`DATABASE_URL` **可选**——有则建池并做租户源校验
// （未知租户计入 skipped），没有则只做事件解析预览（不访问 DB）。
//
// 退出码：0 = 整轮跑完（含跳过/重放失败——那些是数据状态，已逐条计数与落库）；
//         2 = 环境/链路问题（缺 OO_READ_* / 非 dry-run 缺 DATABASE_URL、参数错、OO HTTP 失败、
//             DB 写入失败、`--since` 晚于已存水位）。
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runQuery } from '../modules/data/domain/query-service.ts'
import {
  recordCheck,
  upsertCandidate,
} from '../modules/data/domain/verified-questions.ts'
import { regressionRequester, summarize } from '../modules/data/domain/verified-regression.ts'
import { isUnknownTenantError, loadAdoptedSources } from './tenant-sources.ts'

export const STREAM = 'askdata_verified'
export const DEFAULT_WM_DIR = '/var/lib/askdata'
/** 水位**按流一份**：换流（或未来多流）时路径自动分开，不会互踩。
 * @param {string} [stream]
 * @returns {string}
 */
export function defaultWmPath(stream = STREAM) {
  return `${DEFAULT_WM_DIR}/verify-ingest.${stream}.watermark`
}
export const DEFAULT_WM_PATH = defaultWmPath()
/** 单页条数（OO `_search` 的 `size`）；翻页靠 `from` 偏移，整轮成功后才落水位。 */
const PAGE_SIZE = 1000
/** 翻页安全阀：防止 OO 忽略 `from` 时无限循环（不是业务上限）。 */
const MAX_PAGES = 1000

/** 空哨兵基线：重放失败时**不猜数值**，只落一个结构上空的基线并把结果标 error。 */
export const EMPTY_BASELINE = { columns: [], rowCount: 0, summary: {} }

/** @typedef {import('../modules/data/domain/verified-questions.ts').Baseline} Baseline */

/**
 * 事件契约（Task 4 写出；`params`/`slicing` 在 OO 里是 **JSON 字符串**）。
 * 只有 strong/weak 会走到 parseEvent；negative 在 ingest 里先被丢弃。
 *
 * @typedef {object} IngestEvent
 * @property {'strong'|'weak'} signal
 * @property {string} org
 * @property {string} question
 * @property {string} metricId
 * @property {Record<string, unknown>} params
 * @property {Record<string, unknown>} slicing
 * @property {string|null} sessionId
 */

/**
 * @typedef {object} SearchPage
 * @property {Record<string, any>[]} hits
 * @property {number} [total]
 */

/**
 * @typedef {(req: {cursorUs: number|null, endUs: number, from: number, size: number}) => Promise<SearchPage>} SearchFn
 */

/**
 * @typedef {object} IngestOpts
 * @property {string} url
 * @property {string} ooOrg
 * @property {string} token
 * @property {string} [wmPath]
 * @property {string} [stream]
 * @property {boolean} [dryRun]
 * @property {number|null} [sinceUs]
 */

/**
 * @typedef {object} IngestDeps
 * @property {any} [pool]
 * @property {typeof fetch} [fetch]
 * @property {SearchFn} [search]
 * @property {(deps: any, org: string, requester: any, metricId: string, params: Record<string, unknown>, slicing: Record<string, unknown>) => Promise<any>} [replay]
 * @property {(ok: any) => Baseline} [summarize]
 * @property {(pool: any, org: string, input: any) => Promise<number>} [upsert]
 * @property {(pool: any, org: string, id: number, result: 'error') => Promise<void>} [recordCheck]
 * @property {(exec: any, org: string) => Promise<ReadonlySet<string>>} [loadSources]
 * @property {(org: string) => any} [requester]
 * @property {() => number} [now]
 * @property {(path: string) => number|null} [readWm]
 * @property {(path: string, value: number) => void} [writeWm]
 * @property {(message: string) => void} [log]
 */

/**
 * @typedef {object} Counters
 * @property {number} fetched
 * @property {number} strong
 * @property {number} weak
 * @property {number} negative
 * @property {number} written
 * @property {number} replayError
 * @property {number} skippedOrg
 * @property {number} skippedBadEvent
 * @property {number} skippedUnknownTenant
 * @property {number} skippedBadTimestamp
 * @property {number} defaultedParams
 * @property {number} defaultedSlicing
 * @property {number} wouldIngest
 */

/**
 * @typedef {object} IngestResult
 * @property {Counters} counters
 * @property {{before: number|null, after: number|null, candidate: number|null, written: boolean}} watermark
 * @property {boolean} dryRun
 */

/** 事件字段不合约时抛它；`code=BAD_ORG` 单独计数（org 是隔离键，不能猜）。 */
export class BadEventError extends Error {
  /**
   * @param {string} message
   * @param {'BAD_EVENT'|'BAD_ORG'} [code]
   */
  constructor(message, code = 'BAD_EVENT') {
    super(message)
    this.name = 'BadEventError'
    this.code = code
  }
}

/**
 * OO 鉴权头。宿主既有 `OO_AUTH` 是**裸 base64**、由调用方补 `Basic ` 前缀（attribute.py）；
 * 本脚本对 `OO_READ_TOKEN` 双向兼容：裸值补 `Basic `，已带 `Basic/Bearer ` 前缀原样用。
 *
 * @param {string} token
 * @returns {string}
 */
export function authHeader(token) {
  const t = String(token ?? '').trim()
  if (t === '') throw new Error('verify-ingest: 缺 OO_READ_TOKEN')
  return /^(basic|bearer)\s+/i.test(t) ? t : `Basic ${t}`
}

/**
 * `--since`：RFC3339（UTC）或 epoch 秒/毫秒/微秒，统一成 OO 的微秒。
 * 数字按量级判：>=1e15 已是微秒、>=1e12 毫秒、否则秒（2026 年的秒 ≈ 1.79e9）。
 *
 * @param {string|number} raw
 * @returns {number} 微秒
 */
export function parseSince(raw) {
  const s = String(raw ?? '').trim()
  if (s === '') throw new Error('--since 缺值')
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    if (!Number.isSafeInteger(n)) throw new Error(`--since 数值超出安全范围: '${String(raw)}'`)
    if (n >= 1e15) return n
    if (n >= 1e12) return n * 1000
    return n * 1_000_000
  }
  const ms = Date.parse(s)
  if (!Number.isFinite(ms)) throw new Error(`--since 必须是 RFC3339 或 epoch 秒/毫秒/微秒: '${String(raw)}'`)
  return ms * 1000
}

/**
 * 解析 `--once`（默认）/ `--dry-run` / `--since <ts>`。未知键与位置参数直接抛错（拼错不静默）。
 *
 * @param {string[]} argv
 * @returns {{once: boolean, dryRun: boolean, sinceUs?: number}}
 */
export function parseArgs(argv) {
  /** @type {{once: boolean, dryRun: boolean, sinceUs?: number}} */
  const out = { once: true, dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (arg === '--once') continue
    if (arg === '--dry-run') {
      out.dryRun = true
      continue
    }
    if (arg === '--since' || arg.startsWith('--since=')) {
      const raw = arg === '--since' ? argv[i + 1] : arg.slice('--since='.length)
      if (raw === undefined || raw === '' || raw.startsWith('--')) throw new Error('--since 缺值')
      out.sinceUs = parseSince(raw)
      if (arg === '--since') i += 1
      continue
    }
    throw new Error(`无法识别的参数: ${arg}`)
  }
  return out
}

/**
 * `params` / `slicing`：Task 4 写的是 JSON 字符串；容忍已经是对象（不同 OO 版本/回读路径），
 * 但**不接受**数组/标量/坏 JSON——那是契约坏了，跳过并计数，不猜。
 *
 * @param {unknown} raw
 * @param {string} field
 * @returns {Record<string, unknown>}
 */
export function parseJsonObject(raw, field) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return /** @type {Record<string, unknown>} */ (raw)
  }
  if (typeof raw !== 'string') throw new BadEventError(`${field} 不是 JSON 字符串/对象`)
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new BadEventError(`${field} 不是合法 JSON`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BadEventError(`${field} 必须是 JSON 对象`)
  }
  return /** @type {Record<string, unknown>} */ (parsed)
}

/**
 * params/slicing 是否缺省（undefined/null/空白串）。缺省会按 `{}` 继续，但**必须计数并打日志**：
 * 静默默认会让「事件契约坏了」看起来像「参数本来就是空」。
 *
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isMissingJsonField(raw) {
  return raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')
}

/**
 * OO 命中 → 事件（strong/weak）。负信号由 `ingest` 在调用前丢弃，不经过本函数。
 *
 * @param {Record<string, any>} hit
 * @returns {IngestEvent}
 */
export function parseEvent(hit) {
  if (hit === null || typeof hit !== 'object' || Array.isArray(hit)) {
    throw new BadEventError('事件不是对象')
  }
  const signal = typeof hit.signal === 'string' ? hit.signal.trim() : ''
  if (signal !== 'strong' && signal !== 'weak') {
    throw new BadEventError(`未知 signal '${String(hit.signal)}'`)
  }
  const org = typeof hit.org === 'string' ? hit.org.trim() : ''
  if (org === '') throw new BadEventError('缺 org', 'BAD_ORG')
  const question = typeof hit.question === 'string' ? hit.question.trim() : ''
  if (question === '') throw new BadEventError('缺 question')
  const metricId = typeof hit.metricId === 'string' ? hit.metricId.trim() : ''
  if (metricId === '') throw new BadEventError('缺 metricId')
  const sessionId = typeof hit.sessionId === 'string' && hit.sessionId.trim() !== ''
    ? hit.sessionId.trim()
    : null
  return {
    signal,
    org,
    question,
    metricId,
    params: parseJsonObject(hit.params, 'params'),
    slicing: parseJsonObject(hit.slicing, 'slicing'),
    sessionId,
  }
}

/**
 * OO `_search` 客户端（`POST {url}/api/{org}/{stream}/_search`，Basic 鉴权）。
 *
 * 请求体按 OpenObserve v1.0.4 形状：`{query: {sql, start_time, end_time, from, size}}`，
 * 时间是**微秒 epoch**（UTC 窗口）。SQL 用 **`_timestamp >= 游标`**：同一微秒入库的多条记录
 * 可能被分页截断，严格 `>` 会漏掉边界组；`>=` 让下一轮重读该组（唯一索引幂等吸收）。
 * 次级排序 `seq, "sessionId"` 固定同微秒组内的顺序，避免跨页重排导致漏读。
 * **`"sessionId"` 必须加双引号**：OO 对未加引号的标识符按小写解析（实测 `order by fooBar`
 * ⇒ 400 `unknown field 'foobar'`），而 Task 4 写入的键是 camelCase `sessionId`；不加引号会让
 * 真流每次 `_search` 都 400。实测 OO v1.0.4 支持引号且**区分大小写**（`"session_id"` 可用、
 * `"SESSION_ID"` ⇒ 400 `unknown field`）。
 *
 * @param {IngestOpts} opts
 * @param {typeof fetch} fetchImpl
 * @returns {SearchFn}
 */
export function searchClient(opts, fetchImpl) {
  /** @type {SearchFn} */
  const search = async (req) => {
    const base = String(opts.url ?? '').replace(/\/+$/, '')
    if (base === '') throw new Error('verify-ingest: 缺 OO_READ_URL')
    const org = String(opts.ooOrg ?? '').trim()
    if (org === '') throw new Error('verify-ingest: 缺 OO_READ_ORG')
    const stream = opts.stream ?? STREAM
    const header = authHeader(opts.token)
    const cursorSql = req.cursorUs === null ? '' : ` where _timestamp >= ${Math.trunc(req.cursorUs)}`
    const body = {
      query: {
        sql: `select * from "${stream}"${cursorSql} order by _timestamp asc, seq asc, "sessionId" asc`,
        start_time: req.cursorUs ?? 0,
        end_time: req.endUs,
        from: req.from,
        size: req.size,
      },
    }
    // ⚠️ 真机事实（2026-11-04，OO v1.0.4 @ observe.hookflow.cn）：**stream 级 `_search` 恒 404**
    // （连既有 `askdata_stuck` 也 404），只有**组织级** `/api/{org}/_search` 可用，流由 SQL 指定。
    // 故这里不带 stream 进路径；`stream` 只出现在 SQL 的 `from "<stream>"` 里。
    const res = await fetchImpl(
      `${base}/api/${encodeURIComponent(org)}/_search`,
      {
        method: 'POST',
        headers: { Authorization: header, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    )
    if (!res.ok) {
      let text = ''
      try {
        text = await res.text()
      } catch {
        // 响应体读不出不掩盖状态码
      }
      throw new Error(`verify-ingest: OO _search HTTP ${res.status}${text === '' ? '' : ` — ${text.slice(0, 300)}`}`)
    }
    const data = await res.json()
    if (data === null || typeof data !== 'object' || !Array.isArray(data.hits)) {
      throw new Error('verify-ingest: OO _search 响应缺 hits 数组（不静默当空结果）')
    }
    return {
      hits: data.hits,
      ...(typeof data.total === 'number' ? { total: data.total } : {}),
    }
  }
  return search
}

/**
 * 读水位（非负整数微秒）。文件不存在 ⇒ null（首跑 = 全量窗口）；内容损坏 ⇒ 抛错（不静默归零）。
 *
 * @param {string} path
 * @returns {number|null}
 */
export function readWatermark(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    if (typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT') return null
    throw e
  }
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (!/^\d+$/.test(trimmed)) throw new Error(`verify-ingest: 水位文件内容不是非负整数: ${path}`)
  const n = Number(trimmed)
  if (!Number.isSafeInteger(n)) throw new Error(`verify-ingest: 水位超出安全整数范围: ${path}`)
  return n
}

/**
 * 写水位（建目录 + 临时文件 + rename 原子替换）。**调用方保证只在整轮成功后调用。**
 *
 * @param {string} path
 * @param {number} value
 */
export function writeWatermark(path, value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`verify-ingest: 拒绝写入非法水位 ${String(value)}`)
  }
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, `${value}\n`, 'utf8')
  renameSync(tmp, path)
}

/** @param {Record<string, any>} hit @returns {number|null} OO 入库时间（微秒）；不合法 ⇒ null */
function timestampOrNull(hit) {
  const raw = hit._timestamp
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.trunc(n)
}

/** @param {string} message */
function logLine(message) {
  console.log(message)
}

/**
 * 核心摄入（可注入全部副作用；单测不连网/不连库）。
 *
 * 顺序：读水位 → 分页拉 `_search` → 逐条处理 → **全部成功后才写水位**。
 * 分页边界用 `_timestamp >=` 游标（同微秒组下一轮重读、唯一索引吸收）；`--since` 只影响
 * 本轮读取起点，水位仍只前进；`--since` 晚于已存水位直接拒绝（不静默跳过区间）。
 *
 * @param {IngestOpts} opts
 * @param {IngestDeps} [overrides]
 * @returns {Promise<IngestResult>}
 */
export async function ingest(opts, overrides = {}) {
  const stream = opts.stream ?? STREAM
  const wmPath = opts.wmPath ?? defaultWmPath(stream)
  /** @type {typeof fetch} */
  const fetchImpl = overrides.fetch ?? globalThis.fetch
  /** @type {() => number} */
  const now = overrides.now ?? (() => Date.now())
  /** @type {(path: string) => number|null} */
  const readWm = overrides.readWm ?? readWatermark
  /** @type {(path: string, value: number) => void} */
  const writeWm = overrides.writeWm ?? writeWatermark
  /** @type {(message: string) => void} */
  const log = overrides.log ?? logLine
  /** @type {NonNullable<IngestDeps['replay']>} */
  const replay = overrides.replay ?? runQuery
  /** @type {(ok: any) => Baseline} */
  const summarizeOk = overrides.summarize ?? summarize
  /** @type {(pool: any, org: string, input: any) => Promise<number>} */
  const upsert = overrides.upsert ?? upsertCandidate
  /** @type {(pool: any, org: string, id: number, result: 'error') => Promise<void>} */
  const record = overrides.recordCheck ?? recordCheck
  /** @type {(exec: any, org: string) => Promise<ReadonlySet<string>>} */
  const loadSources = overrides.loadSources ?? loadAdoptedSources
  /** @type {(org: string) => any} */
  const requester = overrides.requester ?? regressionRequester
  const search = overrides.search ?? searchClient(opts, fetchImpl)
  const pool = overrides.pool

  const storedWm = readWm(wmPath)
  // `--since` 晚于已存水位 ⇒ 拒绝运行：否则 [storedWm, since) 区间被**静默跳过**（review Important 5）。
  // 确实要跳区间应先移走水位文件，而不是在参数上悄悄制造一个洞。
  if (opts.sinceUs !== undefined && opts.sinceUs !== null
    && storedWm !== null && opts.sinceUs > storedWm) {
    throw new Error(
      `verify-ingest: --since ${opts.sinceUs} 晚于已存水位 ${storedWm}，拒绝跳过区间；`
      + `若确实要跳，先移走水位文件 ${wmPath}`,
    )
  }
  // `--since` 显式覆盖本轮读取起点；水位本身只前进（见末尾写水位条件）。
  const cursorUs = opts.sinceUs ?? storedWm
  const endUs = now() * 1000

  /** @type {Record<string, any>[]} */
  const hits = []
  let from = 0
  let pageNo = 0
  for (;;) {
    if (pageNo >= MAX_PAGES) {
      throw new Error(`verify-ingest: 分页超过 ${MAX_PAGES} 页（OO 可能忽略 from，停止而非无限循环）`)
    }
    const page = await search({ cursorUs, endUs, from, size: PAGE_SIZE })
    if (page === null || typeof page !== 'object' || !Array.isArray(page.hits)) {
      throw new Error('verify-ingest: OO _search 响应缺 hits 数组（不静默当空结果）')
    }
    const batch = page.hits
    hits.push(...batch)
    from += batch.length
    pageNo += 1
    if (batch.length < PAGE_SIZE) break
    if (typeof page.total === 'number' && from >= page.total) break
  }

  /** @type {Counters} */
  const counters = {
    fetched: hits.length,
    strong: 0,
    weak: 0,
    negative: 0,
    written: 0,
    replayError: 0,
    skippedOrg: 0,
    skippedBadEvent: 0,
    skippedUnknownTenant: 0,
    skippedBadTimestamp: 0,
    defaultedParams: 0,
    defaultedSlicing: 0,
    wouldIngest: 0,
  }

  // 有效命中的入库时间 = 候选水位。缺 `_timestamp` 的毒丸记录**只跳过该条并计数**：
  // 不能让一条坏记录把整轮抛错、水位永远不动（review Minor 8）。
  /** @type {{hit: Record<string, any>, ts: number}[]} */
  const entries = []
  for (const hit of hits) {
    const ts = timestampOrNull(hit)
    if (ts === null) {
      counters.skippedBadTimestamp += 1
      log(`verify-ingest: 跳过缺合法 _timestamp 的记录（收到 ${String(hit._timestamp)}）`)
      continue
    }
    entries.push({ hit, ts })
  }
  // **只认实际取到的有效命中**：空轮不前进（避免把 --since 或一次探测读成「已经处理到那里」）。
  /** @type {number|null} */
  let maxCursor = null
  for (const { ts } of entries) {
    if (maxCursor === null || ts > maxCursor) maxCursor = ts
  }

  /** @type {Map<string, ReadonlySet<string>>} */
  const sourceCache = new Map()
  /** @param {string} org @returns {Promise<ReadonlySet<string>>} */
  const sourcesFor = async (org) => {
    const cached = sourceCache.get(org)
    if (cached !== undefined) return cached
    const loaded = await loadSources(pool, org)
    sourceCache.set(org, loaded)
    return loaded
  }

  for (const { hit } of entries) {
    const rawSignal = typeof hit.signal === 'string' ? hit.signal.trim() : ''
    // 负信号：不入集、不重放，只计数（信号本身已是结论；其它字段缺失也不改变这一点）。
    if (rawSignal === 'negative') {
      counters.negative += 1
      continue
    }

    /** @type {IngestEvent} */
    let event
    try {
      event = parseEvent(hit)
    } catch (e) {
      if (e instanceof BadEventError && e.code === 'BAD_ORG') counters.skippedOrg += 1
      else counters.skippedBadEvent += 1
      log(`verify-ingest: 跳过事件（${e instanceof Error ? e.message : String(e)}）`)
      continue
    }

    // params/slicing 缺失按 {} 继续，但**必须计数并在日志里可见**（不静默吞契约缺口）。
    if (isMissingJsonField(hit.params)) {
      counters.defaultedParams += 1
      log(`verify-ingest: params 缺省按 {} 处理 org=${event.org} ${event.metricId}`)
    }
    if (isMissingJsonField(hit.slicing)) {
      counters.defaultedSlicing += 1
      log(`verify-ingest: slicing 缺省按 {} 处理 org=${event.org} ${event.metricId}`)
    }

    /** @type {ReadonlySet<string>|null} */
    let sources = null
    // `!= null` 同时挡 undefined：`overrides.pool` 缺省是 undefined（不是 null），
    // 用 `!== null` 会把它当成有池 ⇒ `loadSources(undefined)` TypeError（review 第 2 轮 Minor）。
    if (pool != null) {
      try {
        sources = await sourcesFor(event.org)
      } catch (e) {
        // 未知租户 = 事件不属于本平台租户（配置/数据不一致）⇒ 跳过该条，别的租户照常。
        // 其它错误（池断开等）必须炸整轮：静默跳过会让水位越过没处理的数据。
        // 判类用类型化错误（review Minor 6），**不再匹配文案**。
        if (isUnknownTenantError(e)) {
          counters.skippedUnknownTenant += 1
          log(`verify-ingest: 跳过未知租户 org='${event.org}'`)
          continue
        }
        throw e
      }
    } else if (opts.dryRun !== true) {
      // main 已保证非 dry-run 一定有 pool；走到这里说明装配坏了，响亮失败。
      throw new Error('verify-ingest: 非 dry-run 缺少数据库执行器（内部装配错误）')
    }

    if (opts.dryRun === true) {
      counters.wouldIngest += 1
      counters[event.signal] += 1
      log(`verify-ingest[dry-run]: ${event.signal} org=${event.org} ${event.metricId} — ${event.question}`)
      continue
    }
    if (sources === null) {
      throw new Error('verify-ingest: 非 dry-run 未取到 adoptedSources（内部装配错误）')
    }

    /** @type {string|null} */
    let failure = null
    /** @type {any} */
    let outcome
    try {
      outcome = await replay(
        { pool, adoptedSources: sources },
        event.org,
        requester(event.org),
        event.metricId,
        event.params,
        event.slicing,
      )
      if (outcome === null || typeof outcome !== 'object' || outcome.status !== 'ok') {
        const status = outcome !== null && typeof outcome === 'object'
          ? String(outcome.status ?? 'unknown')
          : 'no-outcome'
        const reason = outcome !== null && typeof outcome === 'object' ? String(outcome.reason ?? '') : ''
        const detail = outcome !== null && typeof outcome === 'object' && outcome.detail !== undefined
          ? `（${String(outcome.detail)}）`
          : ''
        failure = `${status}${reason === '' ? '' : `/${reason}`}${detail}`
      }
    } catch (e) {
      failure = `exception: ${e instanceof Error ? e.message : String(e)}`
    }

    if (failure === null) {
      // 重放成功：基线**只**由 summarize(QueryOk) 生成（Task 3 的唯一生产者）。
      const baseline = summarizeOk(outcome)
      await upsert(pool, event.org, {
        question: event.question,
        metricId: event.metricId,
        params: event.params,
        slicing: event.slicing,
        baseline,
        source: 'auto',
        strength: event.signal,
        sessionId: event.sessionId,
      })
      counters[event.signal] += 1
      counters.written += 1
      continue
    }

    // 重放失败：不猜基线（空哨兵）+ 强制 candidate（强信号也不冒充 verified）+ 记 error。
    // `preserveBaseline`：既有 verified 行的好基线/切面/容差恒保留（空哨兵只用于新行 insert，
    // review Critical 1 —— 否则 strong 信号会把已验证基线换成空基线）。
    const id = await upsert(pool, event.org, {
      question: event.question,
      metricId: event.metricId,
      params: event.params,
      slicing: event.slicing,
      baseline: EMPTY_BASELINE,
      source: 'auto',
      strength: event.signal,
      sessionId: event.sessionId,
      forceCandidate: true,
      preserveBaseline: true,
    })
    await record(pool, event.org, id, 'error')
    counters.replayError += 1
    counters.written += 1
    log(`verify-ingest: 重放失败 org=${event.org} ${event.metricId} — ${failure}`)
  }

  // 水位只在**整轮成功**（没有异常逃逸）且确实看到了更晚的记录时前进；不改写更旧的水位。
  const advanced = opts.dryRun !== true && maxCursor !== null
    && (storedWm === null || maxCursor > storedWm)
  if (advanced && maxCursor !== null) writeWm(wmPath, maxCursor)

  return {
    counters,
    watermark: {
      before: storedWm,
      after: advanced ? maxCursor : storedWm,
      candidate: maxCursor,
      written: advanced,
    },
    dryRun: opts.dryRun === true,
  }
}

/**
 * CLI 入口。返回退出码（便于单测）；文件直跑时由底层 `process.exit`。
 *
 * @param {string[]} argv
 * @param {Record<string, string|undefined>} [env]
 * @param {IngestDeps} [overrides]
 * @returns {Promise<number>}
 */
export async function main(argv, env = process.env, overrides = {}) {
  const missing = ['OO_READ_URL', 'OO_READ_ORG', 'OO_READ_TOKEN']
    .filter((key) => String(env[key] ?? '').trim() === '')
  if (missing.length > 0) {
    console.error(`verify-ingest: 缺 ${missing.join(' / ')}（只读 OO 凭据；从 openship 项目 env 取，勿写值）`)
    return 2
  }

  /** @type {{once: boolean, dryRun: boolean, sinceUs?: number}} */
  let args
  try {
    args = parseArgs(argv)
  } catch (e) {
    console.error(`verify-ingest: ${e instanceof Error ? e.message : String(e)}`)
    return 2
  }

  const databaseUrl = String(env.DATABASE_URL ?? '').trim()
  const haveDb = databaseUrl !== ''
  if (args.dryRun !== true && !haveDb) {
    console.error('verify-ingest: 缺 DATABASE_URL（从 openship 项目 env 取；--dry-run 可不需要）')
    return 2
  }

  let pool = overrides.pool ?? null
  // 只要有 DATABASE_URL 就建池（**含 dry-run**）：dry-run 也做租户源校验；
  // 没有 DATABASE_URL 的 dry-run 只做事件预览（不访问 DB）。
  const ownPool = pool === null && haveDb
  if (ownPool) {
    const { Pool } = createRequire(import.meta.url)('pg')
    pool = new Pool({ connectionString: databaseUrl })
  }
  const stream = String(env.ASK_VERIFY_STREAM ?? '').trim() || STREAM
  const wmPath = String(env.ASK_VERIFY_INGEST_WM ?? '').trim() || defaultWmPath(stream)

  try {
    const result = await ingest({
      url: String(env.OO_READ_URL ?? ''),
      ooOrg: String(env.OO_READ_ORG ?? ''),
      token: String(env.OO_READ_TOKEN ?? ''),
      stream,
      wmPath,
      dryRun: args.dryRun,
      ...(args.sinceUs !== undefined ? { sinceUs: args.sinceUs } : {}),
    }, { ...overrides, pool })

    const c = result.counters
    console.log(
      `verify-ingest${result.dryRun ? '[dry-run]' : ''}: fetched=${c.fetched} strong=${c.strong} `
      + `weak=${c.weak} negative=${c.negative} written=${c.written} replay_error=${c.replayError} `
      + `skipped_org=${c.skippedOrg} skipped_bad_event=${c.skippedBadEvent} `
      + `skipped_bad_timestamp=${c.skippedBadTimestamp} `
      + `skipped_unknown_tenant=${c.skippedUnknownTenant} `
      + `defaulted_params=${c.defaultedParams} defaulted_slicing=${c.defaultedSlicing}`
      + (result.dryRun ? ` would_ingest=${c.wouldIngest}` : ''),
    )
    const w = result.watermark
    console.log(
      `verify-ingest: watermark ${w.before === null ? '(none)' : w.before} -> `
      + `${w.after === null ? '(none)' : w.after}${w.written ? '' : '（未前进）'}`,
    )
    return 0
  } catch (e) {
    console.error(`verify-ingest 跑不成: ${e instanceof Error ? e.message : String(e)}`)
    return 2
  } finally {
    if (ownPool && pool !== null && typeof pool.end === 'function') await pool.end()
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)))
}
