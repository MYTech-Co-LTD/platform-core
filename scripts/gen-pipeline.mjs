#!/usr/bin/env node
// gen-pipeline.mjs — 从「源清单 manifest」生成 duckle 管线 JSON + 排班/owner/告警片段。
//
// 定位（P0）：让**不写代码**的人只填一张 manifest，机械部分由本脚本生成：
//   管线 JSON（src.rest → code.sql → qa.contract → snk.minio）
//   排班条目 / owners 条目 / alerts 条目（片段，人工按 SOP 原子合并）
//
// 用法：
//   tsx scripts/gen-pipeline.mjs deploy/duckle/manifests/<id>.json
//   tsx scripts/gen-pipeline.mjs deploy/duckle/manifests/<id>.json --check   # 只比不写，CI 用
//   --out <dir>  管线输出目录（默认 deploy/duckle/console/pipelines）
//
// 判据：manifest 不合法 → exit 1，逐条打印违规；--check 发现生成物与仓内不一致 → exit 1。
// 生成物**不自动上线**：validate / canary / catalog / 排班合并仍走
// team-harness `docs/standards/agent-add-pipeline-without-restart.md` 的闸。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** @typedef {{ name: string, type: string }} SchemaCol */
/** @typedef {{
 *   id: string,
 *   domain: string,
 *   account?: string,
 *   accounts?: string[],
 *   source: {
 *     connectionRef: string,
 *     url: string,
 *     method: string,
 *     headers?: Record<string, string>,
 *     body: string,
 *     responsePath: string,
 *     schema: SchemaCol[],
 *     pagination?: {
 *       type: string,
 *       pages?: number,
 *       pageParam?: string,
 *       pageSizeParam?: string,
 *       pageSize?: number
 *     },
 *     retryAttempts?: number,
 *     retryBackoffMs?: number
 *   },
 *   transform: { sql: string },
 *   gate?: { rules: Record<string, string> },
 *   sink: {
 *     type?: string,
 *     connectionRef: string,
 *     bucket: string,
 *     key: string,
 *     format?: string,
 *     mode?: string,
 *     compression?: string
 *   },
 *   schedule?: { cron?: string, intervalMinutes?: number, timezone?: string, enabled?: boolean },
 *   owner?: { owner: string, match: string, maximumAge: string, description?: string },
 *   alerts?: { on: string[] }
 * }} Manifest */

const EVENTS = ['failure', 'recovery', 'success', 'stale', 'refreshed']
// 分页形态：`none` = 单次请求；`static_pages` = 每页一个静态 src.rest 节点 + ctl.merge
// （正典 §1.7 #41：大结果集源的默认形态；原生分页/foreach 都不适合大源，#44）。
const PAGINATION_TYPES = ['none', 'static_pages']
const MAX_STATIC_PAGES = 500
const DEFAULT_OUT = 'deploy/duckle/console/pipelines'
const OO_ALERT_URL = '${ENV:OO_BASE}/api/${ENV:OO_ORG}/data_alerts/_json'
const OO_ALERT_AUTH = 'Basic ${ENV:OO_AUTH}'

/** @param {string} p @returns {unknown} */
function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'))
}

/** @param {unknown} m @returns {string[]} */
export function validateManifest(m) {
  /** @type {string[]} */
  const errs = []
  if (typeof m !== 'object' || m === null) return ['manifest 必须是 JSON 对象']
  const d = /** @type {Record<string, any>} */ (m)
  if (typeof d.id !== 'string' || !/^[a-z0-9]+(\.[a-z0-9_]+)+$/.test(d.id)) {
    errs.push('id 必须是 domain.table 形（小写字母/数字/下划线/点）')
  }
  if (typeof d.domain !== 'string' || d.domain.length === 0) errs.push('缺 domain')
  const hasAccount = typeof d.account === 'string' && d.account.length > 0
  const hasAccounts = Array.isArray(d.accounts)
  if (hasAccount && hasAccounts) {
    errs.push('account 与 accounts 只能二选一（单账套用 account，多账套用 accounts）')
  } else if (!hasAccount && !hasAccounts) {
    errs.push('缺 account（或 accounts）')
  } else if (hasAccounts) {
    const list = /** @type {unknown[]} */ (d.accounts)
    if (list.length === 0 || list.some((a) => typeof a !== 'string' || a.length === 0)) {
      errs.push('accounts 必须是非空字符串数组')
    } else if (new Set(list).size !== list.length) {
      errs.push('accounts 有重复值')
    }
  }
  const s = d.source
  if (typeof s !== 'object' || s === null) {
    errs.push('缺 source')
  } else {
    if (typeof s.url !== 'string' || s.url.length === 0) errs.push('source.url 必填')
    if (typeof s.method !== 'string' || s.method.length === 0) errs.push('source.method 必填')
    if (typeof s.body !== 'string') errs.push('source.body 必须是字符串（JSON 模板）')
    if (typeof s.responsePath !== 'string' || s.responsePath.length === 0) errs.push('source.responsePath 必填')
    if (!Array.isArray(s.schema) || s.schema.length === 0) {
      errs.push('source.schema 必须非空（0 行响应时引擎按它建表）')
    }
    if (s.pagination && typeof s.pagination.type !== 'string') errs.push('source.pagination.type 必须是字符串')
    const pg = s.pagination ?? { type: 'none' }
    if (!PAGINATION_TYPES.includes(pg.type)) {
      errs.push(
        `source.pagination.type 只能是 ${PAGINATION_TYPES.join(' / ')}（foreach 不适合大源，见正典 §1.7 #44）`
      )
    }
    if (pg.type === 'static_pages') {
      if (!Number.isInteger(pg.pages) || pg.pages < 1 || pg.pages > MAX_STATIC_PAGES) {
        errs.push(`static_pages 需要 pages（整数 1..${MAX_STATIC_PAGES}）`)
      }
      const pageParam = pg.pageParam ?? 'page_number'
      if (typeof s.body !== 'string' || !new RegExp(`"${pageParam}"\\s*:\\s*\\d+`).test(s.body)) {
        errs.push(`static_pages 的 source.body 必须含 \`"${pageParam}": <数字>\` 占位（生成器按页改写）`)
      }
      if (typeof d.sink?.key === 'string' && !d.sink.key.includes('chunk=')) {
        errs.push('static_pages 的 sink.key 必须带 `chunk=`（按段落文件，正典 §1.7 #41）')
      }
    }
  }
  const t = d.transform
  if (typeof t !== 'object' || t === null || typeof t.sql !== 'string' || t.sql.trim().length === 0) {
    errs.push('transform.sql 必须非空')
  }
  const k = d.sink
  if (typeof k !== 'object' || k === null) {
    errs.push('缺 sink')
  } else {
    if (typeof k.connectionRef !== 'string' || k.connectionRef.length === 0) errs.push('sink.connectionRef 必填')
    if (typeof k.bucket !== 'string' || k.bucket.length === 0) errs.push('sink.bucket 必填（catalog 命名需要）')
    if (typeof k.key !== 'string' || k.key.length === 0) errs.push('sink.key 必填')
  }
  if (d.schedule) {
    const okCron = typeof d.schedule.cron === 'string' && d.schedule.cron.trim().length > 0
    const okInterval = typeof d.schedule.intervalMinutes === 'number' && d.schedule.intervalMinutes > 0
    if (!okCron && !okInterval) errs.push('schedule 需要 cron 或 intervalMinutes>0')
  }
  if (d.owner) {
    if (typeof d.owner.owner !== 'string' || d.owner.owner.length === 0) errs.push('owner.owner 必填')
    if (typeof d.owner.match !== 'string' || d.owner.match.length === 0) errs.push('owner.match 必填')
    if (typeof d.owner.maximumAge !== 'string' || d.owner.maximumAge.length === 0) errs.push('owner.maximumAge 必填')
  }
  if (d.alerts) {
    const on = /** @type {any[]} */ (d.alerts.on)
    if (!Array.isArray(on) || on.some((e) => !EVENTS.includes(String(e)))) {
      errs.push(`alerts.on 只能是 ${EVENTS.join(' / ')}`)
    }
  }
  return errs
}

/**
 * 按页改写请求体里的页码/页大小占位（校验已保证占位存在）。
 * @param {string} body
 * @param {string} pageParam
 * @param {string | undefined} pageSizeParam
 * @param {number | undefined} pageSize
 * @param {number} page
 * @returns {string}
 */
function pageBody(body, pageParam, pageSizeParam, pageSize, page) {
  const re = new RegExp(`("${pageParam}"\\s*:\\s*)(\\d+)`)
  let out = body.replace(re, (_m, head) => `${head}${page}`)
  if (pageSizeParam && typeof pageSize === 'number') {
    const reSize = new RegExp(`("${pageSizeParam}"\\s*:\\s*)(\\d+)`)
    out = out.replace(reSize, (_m, head) => `${head}${pageSize}`)
  }
  return out
}

/** @param {Manifest} m @param {string} [name] @returns {Record<string, unknown>} */
export function buildPipeline(m, name = m.id) {
  const s = m.source
  const pg = s.pagination ?? { type: 'none' }
  /** 源节点属性：**顺序照旧**（connectionRef,url,method,body,responsePath,paginationType,headers,retry）
   *  —— 生成物要跟仓里已有文件逐字一致，`--check` 才不会误报漂移。
   *  @param {string} body
   *  @param {string} paginationType
   *  @returns {Record<string, unknown>}
   */
  const sourceProps = (body, paginationType) => {
    /** @type {Record<string, unknown>} */
    const props = {
      connectionRef: s.connectionRef,
      url: s.url,
      method: s.method,
      body,
      responsePath: s.responsePath,
      paginationType,
    }
    if (s.headers) props.headers = s.headers
    if (typeof s.retryAttempts === 'number') props.retryAttempts = s.retryAttempts
    if (typeof s.retryBackoffMs === 'number') props.retryBackoffMs = s.retryBackoffMs
    return props
  }

  /** @type {any[]} */
  const nodes = []
  /** @type {any[]} */
  const edges = []
  let prev
  let x = 300
  if (pg.type === 'static_pages') {
    const pageParam = pg.pageParam ?? 'page_number'
    const pages = pg.pages ?? 1
    for (let i = 1; i <= pages; i += 1) {
      const id = `p${i}`
      nodes.push({
        id,
        type: 'source',
        position: { x: 0, y: (i - 1) * 120 },
        data: {
          label: `page ${i}`,
          componentId: 'src.rest',
          schema: s.schema,
          properties: sourceProps(pageBody(s.body, pageParam, pg.pageSizeParam, pg.pageSize, i), 'none'),
        },
      })
      edges.push({
        id: `e-${id}-m`,
        source: id,
        target: 'merge',
        sourceHandle: 'main',
        targetHandle: `main_${i}`,
        data: { connectionType: 'main' },
      })
    }
    nodes.push({
      id: 'merge',
      type: 'transform',
      position: { x, y: 0 },
      data: { label: 'merge', componentId: 'ctl.merge', properties: {} },
    })
    prev = 'merge'
    x += 300
  } else {
    nodes.push({
      id: 's',
      type: 'source',
      position: { x: 0, y: 0 },
      data: { label: 'source', componentId: 'src.rest', schema: s.schema, properties: sourceProps(s.body, pg.type) },
    })
    prev = 's'
  }
  nodes.push({
    id: 't',
    type: 'transform',
    position: { x, y: 0 },
    data: { label: 'transform', componentId: 'code.sql', properties: { sql: m.transform.sql } },
  })
  edges.push({ id: 'e1', source: prev, target: 't', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } })
  prev = 't'
  x += 300
  if (m.gate?.rules && Object.keys(m.gate.rules).length > 0) {
    nodes.push({
      id: 'g',
      type: 'transform',
      position: { x, y: 0 },
      data: { label: 'contract gate', componentId: 'qa.contract', properties: { rules: m.gate.rules } },
    })
    edges.push({ id: 'e2', source: 't', target: 'g', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } })
    prev = 'g'
    x += 300
  }
  const k = m.sink
  nodes.push({
    id: 'k',
    type: 'sink',
    position: { x, y: 0 },
    data: {
      label: 'sink',
      componentId: 'snk.minio',
      properties: {
        connectionRef: k.connectionRef,
        bucket: k.bucket,
        key: k.key,
        format: k.format ?? 'parquet',
        mode: k.mode ?? 'overwrite',
        compression: k.compression ?? 'zstd',
      },
    },
  })
  edges.push({ id: 'e3', source: prev, target: 'k', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } })

  return { name, nodes, edges, _note: [`由 scripts/gen-pipeline.mjs 从 manifest 生成；手改请改 manifest 后重生成（--check 会拦）。`] }
}

/**
 * 这份 manifest 会产出哪些管线名（单账套 = id；多账套 accounts = `<id>.<account>`）。
 * @param {Manifest} m
 * @returns {string[]}
 */
export function pipelineNames(m) {
  if (m.accounts && m.accounts.length > 0) return m.accounts.map((a) => `${m.id}.${a}`)
  return [m.id]
}

/** @param {Manifest} m @param {string} [name] @returns {{ schedule?: any, owner?: any, alert?: any }} */
function buildSnippets(m, name = m.id) {
  /** @type {{ schedule?: any, owner?: any, alert?: any }} */
  const out = {}
  if (m.schedule) {
    out.schedule = {
      id: `panel-${name}`,
      pipeline_id: name,
      name,
      enabled: m.schedule.enabled ?? false,
      kind: m.schedule.cron
        ? { type: 'cron', expr: m.schedule.cron }
        : { type: 'interval', minutes: m.schedule.intervalMinutes },
      timezone: m.schedule.timezone ?? 'Asia/Shanghai',
      misfire: 'skip',
      catchup: { maxCatchupRuns: 31, maxCatchupAgeDays: 45 },
      last_run_at: null,
      last_run_status: null,
      last_run_duration_ms: null,
      last_run_error: null,
      next_run_at: null,
    }
  }
  if (m.owner) {
    out.owner = {
      match: m.owner.match,
      owner: m.owner.owner,
      ...(m.owner.description ? { description: m.owner.description } : {}),
      maximumAge: m.owner.maximumAge,
    }
  }
  if (m.alerts) {
    out.alert = {
      match: name,
      on: m.alerts.on,
      cooldownMinutes: 15,
      channel: 'webhook',
      url: OO_ALERT_URL,
      headers: { Authorization: OO_ALERT_AUTH },
    }
  }
  return out
}

/** @param {string} p @param {unknown} v */
function writeJson(p, v) {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`)
}

function main() {
  const args = process.argv.slice(2)
  const manifestPath = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--out')
  if (!manifestPath) {
    console.error('usage: tsx scripts/gen-pipeline.mjs <manifest.json> [--out <dir>] [--check]')
    process.exit(2)
  }
  const outIdx = args.indexOf('--out')
  const outDir = outIdx >= 0 ? (args[outIdx + 1] ?? DEFAULT_OUT) : DEFAULT_OUT
  const check = args.includes('--check')
  /** @type {unknown} */
  const raw = readJson(manifestPath)
  const errs = validateManifest(raw)
  if (errs.length > 0) {
    for (const e of errs) console.error(`GEN_PIPELINE_INVALID: ${e}`)
    process.exit(1)
  }
  const m = /** @type {Manifest} */ (raw)
  const base = resolve(manifestPath)
  const names = pipelineNames(m)
  if (check) {
    for (const name of names) {
      const outPath = join(outDir, `${name}.json`)
      if (!existsSync(outPath)) {
        console.error(`GEN_PIPELINE_DRIFT: 缺少生成物 ${outPath}（跑不带 --check 的同一命令生成）`)
        process.exit(1)
      }
      const onDisk = readFileSync(outPath, 'utf8')
      if (onDisk !== `${JSON.stringify(buildPipeline(m, name), null, 2)}\n`) {
        console.error(`GEN_PIPELINE_DRIFT: ${outPath} 与 manifest 不一致（手改过？重生成）`)
        process.exit(1)
      }
    }
    console.log(`gen-pipeline: OK ${names.join(' / ')}（与 manifest 一致）`)
    return
  }
  for (const name of names) {
    const outPath = join(outDir, `${name}.json`)
    writeJson(outPath, buildPipeline(m, name))
    for (const [kind, value] of Object.entries(buildSnippets(m, name))) {
      writeJson(join(dirname(base), 'generated', `${name}.${kind}.json`), value)
    }
    console.log(`gen-pipeline: wrote ${outPath}`)
  }
  console.log(`gen-pipeline: snippets → ${join(dirname(base), 'generated')}/`)
  console.log('next: duckle validate / canary run / catalog / 排班与 owners/alerts 按 SOP 原子合并')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
