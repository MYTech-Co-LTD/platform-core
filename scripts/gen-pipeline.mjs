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
 *   identityGate?: boolean,
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
 *       offsetParam?: string,
 *       pageSizeParam?: string,
 *       pageSize?: number,
 *       truncationGuard?: boolean,
 *       fingerprintSql?: string,
 *       watermarkPath?: string,
 *       windowToken?: string
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
const PAGINATION_TYPES = ['none', 'static_pages', 'incremental']
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
      if (typeof pg.offsetParam === 'string') {
        // offset/limit 分页：页码不在 body 里，按 `offset = (page-1) × pageSize` 生成。
        if (typeof pg.pageSizeParam !== 'string') {
          errs.push('offset 分页需要 pageSizeParam（limit 参数名）')
        }
        if (typeof pg.pageSize !== 'number') {
          errs.push('offset 分页需要 pageSize（offset = (page-1) × pageSize）')
        }
        if (typeof s.body !== 'string' || !new RegExp(`"${pg.offsetParam}"\\s*:\\s*\\d+`).test(s.body)) {
          errs.push(`offset 分页的 source.body 必须含 \`"${pg.offsetParam}": <数字>\` 占位（生成器按页改写）`)
        }
        if (
          typeof pg.pageSizeParam === 'string' &&
          (typeof s.body !== 'string' || !new RegExp(`"${pg.pageSizeParam}"\\s*:\\s*\\d+`).test(s.body))
        ) {
          errs.push(`offset 分页的 source.body 必须含 \`"${pg.pageSizeParam}": <数字>\` 占位`)
        }
      } else {
        const pageParam = pg.pageParam ?? 'page_number'
        if (typeof s.body !== 'string' || !new RegExp(`"${pageParam}"\\s*:\\s*\\d+`).test(s.body)) {
          errs.push(`static_pages 的 source.body 必须含 \`"${pageParam}": <数字>\` 占位（生成器按页改写）`)
        }
      }
      if (typeof d.sink?.key === 'string' && !d.sink.key.includes('chunk=')) {
        errs.push('static_pages 的 sink.key 必须带 `chunk=`（按段落文件，正典 §1.7 #41）')
      }
      if (pg.truncationGuard && typeof pg.pageSize !== 'number') {
        errs.push('truncationGuard 需要 pageSize（阈值 = pages × pageSize）')
      }
    } else if (pg.truncationGuard && pg.type !== 'incremental') {
      errs.push('truncationGuard 只能与 static_pages / incremental 一起用')
    }
    if (pg.type === 'incremental') {
      if (!Number.isInteger(pg.pages) || pg.pages < 1 || pg.pages > MAX_STATIC_PAGES) {
        errs.push(`incremental 需要 pages（整数 1..${MAX_STATIC_PAGES}）`)
      }
      if (typeof pg.pageSize !== 'number') errs.push('incremental 需要 pageSize')
      if (typeof pg.fingerprintSql !== 'string' || pg.fingerprintSql.trim().length === 0) {
        errs.push('incremental 需要 fingerprintSql（对 input 的聚合，如 `max(CAST(order_no AS VARCHAR))`）')
      }
      if (typeof pg.watermarkPath !== 'string' || !pg.watermarkPath.startsWith('/')) {
        errs.push('incremental 需要 watermarkPath（绝对路径，父管线写、下一轮读）')
      }
      if (typeof pg.windowToken !== 'string' || !s.body.includes(pg.windowToken)) {
        errs.push('incremental 需要 windowToken，且 source.body 里要出现它（父展开、子走 ITER_ITEM_BIZDAY）')
      }
      if (typeof d.sink?.key === 'string' && !d.sink.key.includes('${ITER_ITEM_PAGE}')) {
        errs.push('incremental 的 sink.key 必须带 `${ITER_ITEM_PAGE}`（子管线按页落盘）')
      }
    }
  }
  if (d.identityGate !== undefined && typeof d.identityGate !== 'boolean') {
    errs.push('identityGate 必须是布尔值')
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
 * @param {number | string} page
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

/**
 * offset/limit 分页的请求体改写：`offset = (page-1) × pageSize`，limit 固定 pageSize。
 * @param {string} body
 * @param {string} offsetParam
 * @param {string | undefined} pageSizeParam
 * @param {number} pageSize
 * @param {number} page
 * @returns {string}
 */
function offsetBody(body, offsetParam, pageSizeParam, pageSize, page) {
  const offset = (page - 1) * pageSize
  const re = new RegExp(`("${offsetParam}"\\s*:\\s*)(\\d+)`)
  let out = body.replace(re, (_m, head) => `${head}${offset}`)
  if (pageSizeParam) {
    const reSize = new RegExp(`("${pageSizeParam}"\\s*:\\s*)(\\d+)`)
    out = out.replace(reSize, (_m, head) => `${head}${pageSize}`)
  }
  return out
}

/**
 * 标准 L0 身份闸（与现役 L0 管线同形，2026-11-07 真机）：
 * whoami → 账套/门店自证 → env 形状闸。由 `dv` 用 `on-subjob-ok` 控制边挂到首个数据节点。
 * @param {string} connectionRef
 * @param {string} windowToken
 * @returns {{ nodes: any[], edges: any[], last: string }}
 */
function identityGate(connectionRef, windowToken) {
  const whoamiFile = '/workspace/.duckle-raw/whoami-${datetime}.sse'
  /** @type {any[]} */
  const nodes = [
    {
      id: 'w0',
      type: 'source',
      position: { x: 0, y: -400 },
      data: {
        label: 'w0',
        componentId: 'src.rest',
        // 身份探针必须申报 schema：空响应时引擎按它构造关系（正典 §1.3.2 四条护栏之一）。
        schema: [{ name: 'x', type: 'string' }],
        properties: {
          connectionRef,
          url: 'https://cloud.nhsoft.cn/agi/mcp',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
          body: '{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "whoami", "arguments": {}}}',
          paginationType: 'none',
          responseFormat: 'xml',
          rawResponseDestination: whoamiFile,
          retryAttempts: 3,
          retryBackoffMs: 2000,
        },
      },
    },
    {
      id: 'g0',
      type: 'transform',
      position: { x: 300, y: -400 },
      data: {
        label: 'g0',
        componentId: 'code.sql',
        properties: {
          sql: `SELECT unnest(regexp_extract_all(content, '(?m)^data: ([^\\r\\n]*)', 1)) AS line FROM read_text('${whoamiFile}')`,
        },
      },
    },
    {
      id: 'g1',
      type: 'transform',
      position: { x: 600, y: -400 },
      data: {
        label: 'g1',
        componentId: 'code.sql',
        properties: {
          sql: "SELECT json_extract_string(line, '$.result.content[0].text') AS txt FROM input QUALIFY row_number() OVER () = count(*) OVER ()",
        },
      },
    },
    {
      id: 'g2',
      type: 'transform',
      position: { x: 900, y: -400 },
      data: {
        label: 'g2',
        componentId: 'code.sql',
        properties: {
          sql: "SELECT json_extract_string(txt, '$.company_id') AS company_id, json_extract_string(txt, '$.branch_nums') AS branch_nums FROM input",
        },
      },
    },
    {
      id: 'd0',
      type: 'transform',
      position: { x: 1200, y: -400 },
      data: {
        label: 'd0',
        componentId: 'ctl.die',
        properties: {
          condition: 'no-rows',
          message: 'identity: whoami 响应里没有可解析的身份（网关形状变了？）⇒ 身份未证，拒绝采集与写湖',
        },
      },
    },
    {
      id: 'g3',
      type: 'transform',
      position: { x: 1500, y: -400 },
      data: {
        label: 'g3',
        componentId: 'code.sql',
        properties: {
          sql:
            "SELECT 'book' AS violation, company_id AS detail FROM input WHERE company_id IS DISTINCT FROM '${ENV:SYSTEM_BOOK}' " +
            "UNION ALL SELECT 'branch' AS violation, CAST(c.branch_num AS VARCHAR) AS detail " +
            "FROM (SELECT unnest('${ENV:BRANCH_NUMS}'::BIGINT[]) AS branch_num) c " +
            "LEFT JOIN (SELECT unnest(CAST(json_extract(branch_nums, '$[*]') AS BIGINT[])) AS branch_num FROM input) w USING (branch_num) " +
            'WHERE w.branch_num IS NULL',
        },
      },
    },
    {
      id: 'd1',
      type: 'transform',
      position: { x: 1800, y: -400 },
      data: {
        label: 'd1',
        componentId: 'ctl.die',
        properties: { condition: 'has-rows', message: 'identity: 凭据账套/门店清单自证未过 ⇒ 拒绝采集与写湖' },
      },
    },
    {
      id: 'gv',
      type: 'transform',
      position: { x: 2100, y: -400 },
      data: {
        label: 'gv',
        componentId: 'code.sql',
        properties: {
          sql:
            "SELECT 'BRANCH_NUMS' AS violation, '${ENV:BRANCH_NUMS}' AS detail, 'JSON integer array, e.g. [1001,1002]' AS rule " +
            "WHERE NOT regexp_full_match('${ENV:BRANCH_NUMS}', '\\[[0-9]+([, ]+[0-9]+)*\\]') " +
            "UNION ALL SELECT 'SYSTEM_BOOK', '${ENV:SYSTEM_BOOK}', 'digits only' WHERE NOT regexp_full_match('${ENV:SYSTEM_BOOK}', '[0-9]{1,32}') " +
            `UNION ALL SELECT 'BIZDAY', '${windowToken}', 'YYYY-MM-DD' WHERE NOT regexp_full_match('${windowToken}', '[0-9]{4}-[0-9]{2}-[0-9]{2}')`,
        },
      },
    },
    {
      id: 'dv',
      type: 'transform',
      position: { x: 2400, y: -400 },
      data: {
        label: 'dv',
        componentId: 'ctl.die',
        properties: {
          condition: 'has-rows',
          message:
            'EXPECTED_VALUE_MISSING_OR_MALFORMED: 期望值缺席或形状非法（{rows} 条违规，明细见上）⇒ 拒绝采集与写湖。处置：检查该管线调度/触发面的 env 注入',
        },
      },
    },
  ]
  const order = ['w0', 'g0', 'g1', 'g2', 'd0', 'g3', 'd1', 'gv', 'dv']
  const edges = order.slice(0, -1).map((id, i) => ({
    id: `e-${id}-${order[i + 1]}`,
    source: id,
    target: order[i + 1],
    sourceHandle: 'main',
    targetHandle: 'main',
    data: { connectionType: 'main' },
  }))
  return { nodes, edges, last: 'dv' }
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
  let firstDataNode = ''
  // 身份闸只加在父管线上；子管线由父管线调用前已自证，不重复。
  // 形状闸的 BIZDAY 检查用窗口 token：增量走 `pg.windowToken`；static_pages 默认 `${date-1d}`
  // （4 条高频源都是日窗；其它窗口的 static_pages 在 manifest 里显式给 `windowToken`）。
  const gateToken = pg.windowToken ?? '${date-1d}'
  const gate = m.identityGate && !name.endsWith('.page') ? identityGate(s.connectionRef, gateToken) : null
  if (gate) {
    nodes.push(...gate.nodes)
    edges.push(...gate.edges)
  }
  /**
   * 把身份闸的出口用 `on-subjob-ok` 控制边挂到首个数据节点（与现役 L0 同形）。
   * @param {string} target
   */
  const attachGate = (target) => {
    if (!gate) return
    edges.push({
      id: 'e-dv-first',
      source: gate.last,
      target,
      sourceHandle: null,
      targetHandle: null,
      data: { connectionType: 'on-subjob-ok' },
    })
  }
  if (pg.type === 'incremental' && name.endsWith('.page')) {
    // ── 子管线：一页 ────────────────────────────────────────────────────────
    // 子管线不展开 ${ENV:...} / 日期变量（正典 §1.7 #44）⇒ 页码与窗口一律走 ITER 列。
    const pageParam = pg.pageParam ?? 'page_number'
    const windowToken = pg.windowToken ?? ''
    const withPage = pageBody(s.body, pageParam, pg.pageSizeParam, pg.pageSize, '${ITER_ITEM_PAGE}')
    const childBody = windowToken ? withPage.split(windowToken).join('${ITER_ITEM_BIZDAY}') : withPage
    // 子管线同样不展开 ${ENV:*} / ${datetime} ⇒ 投影里的这些 token 一律换成 ITER 列
    const childSql = m.transform.sql
      .split('${ENV:SYSTEM_BOOK}')
      .join('${ITER_ITEM_SYSTEM_BOOK}')
      .split('${datetime}')
      .join('${ITER_ITEM_RUN}')
      .split(windowToken || '\u0000')
      .join('${ITER_ITEM_BIZDAY}')
    m = { ...m, transform: { sql: childSql } }
    nodes.push({
      id: 'p',
      type: 'source',
      position: { x: 0, y: 0 },
      data: { label: 'page', componentId: 'src.rest', schema: s.schema, properties: sourceProps(childBody, 'none') },
    })
    prev = 'p'
  } else if (pg.type === 'incremental') {
    // ── 父管线：探针 → 指纹 → 比水位 → 页列表 → foreach ────────────────────
    const pageParam = pg.pageParam ?? 'page_number'
    nodes.push({
      id: 'probe',
      type: 'source',
      position: { x: 0, y: 0 },
      data: {
        label: 'probe page 1',
        componentId: 'src.rest',
        schema: s.schema,
        properties: sourceProps(
          pageBody(s.body, pageParam, pg.pageSizeParam, /** @type {number} */ (pg.pageSize), 1),
          'none'
        ),
      },
    })
    nodes.push({
      id: 'fp',
      type: 'transform',
      position: { x: 300, y: 0 },
      data: {
        label: 'fingerprint',
        componentId: 'code.sql',
        // n = 探针页实际行数：页满（n >= pageSize）⇒ 可能还有后续页，强制全量采（见 cmp）
        properties: { sql: `SELECT ${pg.fingerprintSql} AS fp, count(*) AS n FROM input` },
      },
    })
    nodes.push({
      id: 'prev',
      type: 'source',
      position: { x: 0, y: 200 },
      data: { label: 'prev watermark', componentId: 'src.parquet', properties: { path: pg.watermarkPath } },
    })
    nodes.push({
      id: 'cmp',
      type: 'transform',
      position: { x: 600, y: 0 },
      data: {
        label: 'compare',
        componentId: 'code.sql',
        properties: {
          sql:
            'SELECT f.fp, (SELECT max(fp) FROM prev) AS prev_fp, ' +
            `(f.n > 0 AND (f.n >= ${/** @type {number} */ (pg.pageSize)} OR f.fp IS DISTINCT FROM (SELECT max(fp) FROM prev))) AS has_new ` +
            'FROM fp f',
        },
      },
    })
    const values = Array.from({ length: /** @type {number} */ (pg.pages) }, (_, i) => `(${i + 1})`).join(',')
    nodes.push({
      id: 'pages',
      type: 'transform',
      position: { x: 900, y: 0 },
      data: {
        label: 'page list',
        componentId: 'code.sql',
        properties: {
          sql:
            `SELECT CAST(t.page AS INTEGER) AS page, '${pg.windowToken ?? ''}' AS bizday, ` +
            `'${'${ENV:SYSTEM_BOOK}'}' AS system_book, '${'${datetime}'}' AS run ` +
            `FROM (VALUES ${values}) t(page) CROSS JOIN (SELECT has_new FROM input) h WHERE h.has_new`,
        },
      },
    })
    nodes.push({
      id: 'fe',
      type: 'transform',
      position: { x: 1200, y: 0 },
      data: {
        label: 'foreach page',
        componentId: 'ctl.foreach',
        properties: { pipelineRef: `\${workspace}/pipelines/${name}.page.json`, concurrency: 1 },
      },
    })
    // 水位：必须用**旁路 sink** 在比较之后写（ctl.checkpoint 会提前覆盖，实测踩过）
    nodes.push({
      id: 'wmk',
      type: 'transform',
      position: { x: 900, y: 200 },
      data: { label: 'watermark', componentId: 'code.sql', properties: { sql: 'SELECT fp FROM input' } },
    })
    nodes.push({
      id: 'ks',
      type: 'sink',
      position: { x: 1200, y: 200 },
      data: {
        label: 'write watermark',
        componentId: 'snk.parquet',
        properties: { path: pg.watermarkPath, mode: 'overwrite' },
      },
    })
    edges.push({ id: 'e-probe-fp', source: 'probe', target: 'fp', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } })
    edges.push({ id: 'e-fp-cmp', source: 'fp', target: 'cmp', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } })
    edges.push({ id: 'e-prev-cmp', source: 'prev', target: 'cmp', sourceHandle: 'main', targetHandle: 'prev', data: { connectionType: 'main' } })
    edges.push({ id: 'e-cmp-pages', source: 'cmp', target: 'pages', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } })
    edges.push({ id: 'e-pages-fe', source: 'pages', target: 'fe', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } })
    edges.push({ id: 'e-cmp-wmk', source: 'cmp', target: 'wmk', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } })
    edges.push({ id: 'e-wmk-ks', source: 'wmk', target: 'ks', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } })
    if (pg.truncationGuard) {
      // foreach 形态没有 merge 可数 ⇒ 用「第 pages+1 页」尾页探针（与静态页哨兵同义：
      // 尾页非空 = 已击穿 pages × pageSize）。代价是每轮多 1 次请求；无新数据时也跑。
      const tailPage = /** @type {number} */ (pg.pages) + 1
      // 尾页必须用**同一 pageSize**：page 10 只有在 pageSize=100 时才从第 901 行开始；
      // 改成 1 会让 page 10 变成有效页（真机 2026-11-08 踩过）。
      const tailBody = pageBody(s.body, pageParam, pg.pageSizeParam, pg.pageSize, tailPage)
      nodes.push({
        id: 'tail',
        type: 'source',
        position: { x: 0, y: 400 },
        data: { label: 'tail probe', componentId: 'src.rest', schema: s.schema, properties: sourceProps(tailBody, 'none') },
      })
      nodes.push({
        id: 'dgt',
        type: 'transform',
        position: { x: 300, y: 400 },
        data: {
          label: 'die on truncation',
          componentId: 'ctl.die',
          properties: {
            condition: 'has-rows',
            message:
              `INCREMENTAL_TRUNCATED: 第 ${tailPage} 页仍有行（pages=${pg.pages} × pageSize=${pg.pageSize}）` +
              ' ⇒ 可能截断；请加页后重生成',
          },
        },
      })
      edges.push({ id: 'e-tail-dgt', source: 'tail', target: 'dgt', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } })
      if (gate) {
        edges.push({
          id: 'e-dv-tail',
          source: gate.last,
          target: 'tail',
          sourceHandle: null,
          targetHandle: null,
          data: { connectionType: 'on-subjob-ok' },
        })
      }
    }
    attachGate('probe')
    return { name, nodes, edges, _note: [`由 scripts/gen-pipeline.mjs 从 manifest 生成；手改请改 manifest 后重生成（--check 会拦）。`] }
  } else if (pg.type === 'static_pages') {
    const pageParam = pg.pageParam ?? 'page_number'
    const pages = pg.pages ?? 1
    firstDataNode = 'p1'
    for (let i = 1; i <= pages; i += 1) {
      const id = `p${i}`
      const body = pg.offsetParam
        ? offsetBody(s.body, pg.offsetParam, pg.pageSizeParam, /** @type {number} */ (pg.pageSize), i)
        : pageBody(s.body, pageParam, pg.pageSizeParam, pg.pageSize, i)
      nodes.push({
        id,
        type: 'source',
        position: { x: 0, y: (i - 1) * 120 },
        data: {
          label: `page ${i}`,
          componentId: 'src.rest',
          schema: s.schema,
          properties: sourceProps(body, 'none'),
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
    if (pg.truncationGuard) {
      // 截断哨兵（真机实测 2026-11-07）：叶子 ctl.die 会被执行；命中时 run 标红。
      // ⚠️ 它是**告警不是闸**——sink 与哨兵并行，湖里已经写了。
      const threshold = pages * /** @type {number} */ (pg.pageSize)
      nodes.push({
        id: 'q',
        type: 'transform',
        position: { x: 0, y: -200 },
        data: {
          label: 'truncation guard',
          componentId: 'code.sql',
          properties: { sql: `SELECT count(*) AS n FROM input HAVING count(*) = ${threshold}` },
        },
      })
      nodes.push({
        id: 'dg',
        type: 'transform',
        position: { x: 300, y: -200 },
        data: {
          label: 'die on truncation',
          componentId: 'ctl.die',
          properties: {
            condition: 'has-rows',
            message: `STATIC_PAGES_TRUNCATED: 总行数 == pages×pageSize（${pages}×${pg.pageSize}=${threshold}）⇒ 可能截断；sink 已写，需人工确认并补页/加页`,
          },
        },
      })
      edges.push({ id: 'e-merge-q', source: 'merge', target: 'q', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } })
      edges.push({ id: 'e-q-dg', source: 'q', target: 'dg', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } })
    }
  } else {
    nodes.push({
      id: 's',
      type: 'source',
      position: { x: 0, y: 0 },
      data: { label: 'source', componentId: 'src.rest', schema: s.schema, properties: sourceProps(s.body, pg.type) },
    })
    prev = 's'
    firstDataNode = 's'
  }
  attachGate(firstDataNode)
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
  const base = m.accounts && m.accounts.length > 0 ? m.accounts.map((a) => `${m.id}.${a}`) : [m.id]
  // incremental 产出「父 + 子」两条：子管线名 = <父>.page
  if (m.source?.pagination?.type === 'incremental') return base.flatMap((n) => [n, `${n}.page`])
  return base
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
