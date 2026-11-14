#!/usr/bin/env node
// check-semantics.mjs —— 语义层声明门禁（W4，路线图 G6 / #1447）。
//
// **单一事实源**：`dbt/semantics/l1_metrics.yml` 的顶层 `entities:`（W0 已建，W4 扩四个字段）。
// 不另建 entities.yml——那会造第二事实源（B11 纪律）。
//
// 判据（纯函数，单测直接喂桩）：
//   ① 对象名合法（小写蛇形）；② 必填齐全：label / system_of_record / identity_keys / merge_rule / owner；
//   ③ merge_rule 闭集；④ **未知 ≠ 没有**：指标 `entity:` 引用的对象必须在顶层 entities 里；
//   ⑤ dimensions.yml / invariants.yml（W4 Task 3/4 接入）存在时至少可解析。
//
// 用法：`pnpm exec tsx scripts/check-semantics.mjs [rootDir]`
// 契约：干净 → exit 0 + `check-semantics: OK（entities N / dimensions M / invariants K）`
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from 'yaml'

const SCRIPT_NAME = 'check-semantics'
const ENTITY_NAME_RE = /^[a-z][a-z0-9_]*$/
const REQUIRED = ['system_of_record', 'identity_keys', 'merge_rule', 'owner']
const MERGE_RULES = new Set(['prefer_source', 'manual'])

/**
 * @param {unknown} doc `l1_metrics.yml` 解析结果（顶层 entities 为映射）
 * @returns {string[]} 违规项（空 = 干净）
 */
export function entityIssues(doc) {
  const out = []
  /** @type {any} */
  const root = doc !== null && typeof doc === 'object' ? doc : {}
  const entities = root.entities
  if (entities === null || typeof entities !== 'object' || Array.isArray(entities)) {
    return ['[entities] 缺顶层 entities: 映射（`{ 实体名: { label, ... } }`）']
  }
  const declared = new Set(Object.keys(entities))
  for (const [name, def] of Object.entries(/** @type {Record<string, unknown>} */ (entities))) {
    const at = `entities.${name}`
    if (!ENTITY_NAME_RE.test(name)) out.push(`${at} 名不合规（小写蛇形）`)
    if (def === null || typeof def !== 'object' || Array.isArray(def)) { out.push(`${at} 必须是对象`); continue }
    const d = /** @type {Record<string, unknown>} */ (def)
    if (typeof d.label !== 'string' || d.label.trim() === '') out.push(`${at} 缺 label`)
    for (const k of REQUIRED) {
      if (d[k] === undefined || d[k] === null || d[k] === '') out.push(`${at} 缺 ${k}（多源接入的裁决依据，W4 起必填）`)
    }
    if (Array.isArray(d.identity_keys)) {
      if (d.identity_keys.length === 0 || d.identity_keys.some((x) => typeof x !== 'string' || x.trim() === '')) {
        out.push(`${at} identity_keys 必须是非空字符串数组`)
      }
    }
    if (d.merge_rule !== undefined && !MERGE_RULES.has(String(d.merge_rule))) {
      out.push(`${at} merge_rule 只允许 prefer_source | manual，收到 ${JSON.stringify(d.merge_rule)}`)
    }
  }
  // ④ 未知 ≠ 没有
  const items = Array.isArray(root.metrics) ? root.metrics : []
  for (const m of items) {
    const ent = typeof m?.entity === 'string' ? m.entity.trim() : ''
    if (ent !== '' && !declared.has(ent)) out.push(`[metrics] 指标 ${String(m?.name)} 引用了未声明的 entity：${ent}`)
  }
  // ⑤ label 撞名预检（P1 缓办①，2026-11-14）：L1 行物化进 org='platform' 桶时会撞
  //    `metrics_title_per_dept_uq (org, coalesce(owner_dept,''), lower(title))`——
  //    归一后同 label 的两条指标 = sync 在**运行时**炸（部署后才发现）。
  //    在 CI 就拦：归一 = trim + 小写（与唯一索引的 lower() 同口径）。
  const byLabel = new Map()
  for (const m of items) {
    const label = typeof m?.label === 'string' ? m.label.trim().toLowerCase() : ''
    if (label === '') continue                       // 缺 label 由必填门禁管（见 ②）
    if (!byLabel.has(label)) byLabel.set(label, [])
    byLabel.get(label).push(String(m?.name))
  }
  for (const [label, names] of byLabel) {
    if (names.length > 1) out.push(`[metrics] label 撞名（物化会撞平台桶唯一索引）：${label} ← ${names.join(', ')}`)
  }
  return out
}

/** 读 l1_metrics.yml 的 name → entity（缺失 = ''）；供覆盖率报告复用。 */
/**
 * 不变量声明校验（W4 Task 4）：形状 + status 闭集 + check_sql 形态。
 * @param {unknown} doc invariants.yml 解析结果
 * @returns {string[]}
 */
export function invariantIssues(doc) {
  const out = []
  const root = /** @type {any} */ (doc)
  const list = Array.isArray(root?.invariants) ? root.invariants : null
  if (list === null) return ['[invariants] 缺 invariants: 数组']
  const seen = new Set()
  for (const [i, v] of list.entries()) {
    const at = `invariants[${i}]`
    if (v === null || typeof v !== 'object') { out.push(`${at} 必须是对象`); continue }
    const name = typeof v.name === 'string' ? v.name.trim() : ''
    if (name === '') out.push(`${at} 缺 name`)
    else if (seen.has(name)) out.push(`${at} name 重复：${name}`)
    else seen.add(name)
    if (typeof v.relation !== 'string' || v.relation.trim() === '') out.push(`${at} 缺 relation`)
    if (!['error', 'warn'].includes(String(v.severity))) out.push(`${at} severity 只允许 error | warn`)
    if (!['candidate', 'verified', 'observing'].includes(String(v.status))) out.push(`${at} status 只允许 candidate | verified | observing`)
    if (typeof v.owner !== 'string' || v.owner.trim() === '') out.push(`${at} 缺 owner`)
    const sql = typeof v.check_sql === 'string' ? v.check_sql.trim() : ''
    if (!/^select\s+count\(\*\)\s+from\s+[A-Za-z_][\w.]*\s+where\s+/i.test(sql)) {
      out.push(`${at} check_sql 必须是「select count(*) from <rel> where …」（生成器依赖该形态）`)
    }
  }
  return out
}

/**
 * 维度层级校验（W4 Task 3）。
 * @param {unknown} doc dimensions.yml 解析结果
 * @param {Map<string, Set<string>>} contractColumns 表名 → 列集合（来自 contracts/）
 * @returns {string[]}
 */
export function dimensionIssues(doc, contractColumns) {
  const out = []
  const root = /** @type {any} */ (doc)
  const list = Array.isArray(root?.dimensions) ? root.dimensions : null
  if (list === null) return ['[dimensions] 缺 dimensions: 数组']
  const seenKeys = new Set()
  for (const [i, d] of list.entries()) {
    const at = `dimensions[${i}]`
    if (d === null || typeof d !== 'object') { out.push(`${at} 必须是对象`); continue }
    const name = typeof d.name === 'string' ? d.name.trim() : ''
    if (name === '') out.push(`${at} 缺 name`)
    const relation = typeof d.relation === 'string' ? d.relation.trim() : ''
    const key = typeof d.key === 'string' ? d.key.trim() : ''
    if (relation === '' || key === '') { out.push(`${at} 缺 relation/key`); continue }
    const cols = contractColumns.get(relation)
    if (cols === undefined) { out.push(`${at} relation \`${relation}\` 没有契约——无法校验列（未知 ≠ 没有）`); continue }
    const keyed = `${relation}.${key}`
    if (seenKeys.has(keyed)) out.push(`${at} (${keyed}) 被多个维度声明（同一个键只能有一个维度）`)
    seenKeys.add(keyed)
    if (!cols.has(key)) out.push(`${at} key \`${key}\` 不在 ${relation} 的契约列里`)
    const hier = Array.isArray(d.hierarchy) ? d.hierarchy : null
    if (hier === null || hier.length < 2) { out.push(`${at} hierarchy 至少两级`); continue }
    const levels = new Set()
    for (const [j, h] of hier.entries()) {
      const level = typeof h?.level === 'string' ? h.level.trim() : ''
      const column = typeof h?.column === 'string' ? h.column.trim() : ''
      if (level === '' || column === '') { out.push(`${at}.hierarchy[${j}] 缺 level/column`); continue }
      if (levels.has(level)) out.push(`${at}.hierarchy[${j}] level 重复：${level}`)
      levels.add(level)
      if (!cols.has(column)) out.push(`${at}.hierarchy[${j}] 列 \`${column}\` 不在 ${relation} 的契约里`)
    }
    const last = hier[hier.length - 1]
    if (typeof last?.column === 'string' && last.column !== key) out.push(`${at} 层级末级必须是 key（\`${key}\`），收到 \`${last.column}\``)
  }
  return out
}

/** @param {any} metricsDoc @returns {Map<string,string>} */
export function metricEntities(metricsDoc) {
  const map = new Map()
  const items = Array.isArray(metricsDoc?.metrics) ? metricsDoc.metrics : []
  for (const m of items) {
    if (m === null || typeof m !== 'object' || typeof m.name !== 'string') continue
    map.set(m.name, typeof m.entity === 'string' ? m.entity.trim() : '')
  }
  return map
}

/** @param {string} p @returns {string} */
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
/** @param {string} text @returns {any} */
const parseOrNull = (text) => { try { return text === '' ? null : parse(text) } catch { return null } }

/**
 * 扫 contracts 目录下所有 json，建「表名 → 列集合」。只读列名，不关心 expr。
 * @param {string} rootDir
 * @returns {Map<string, Set<string>>}
 */
function loadContractColumns(rootDir) {
  const out = new Map()
  const base = join(rootDir, 'contracts')
  if (!existsSync(base)) return out
  /** @param {string} dir */
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name)
      if (ent.isDirectory()) { walk(p); continue }
      if (!ent.name.endsWith('.json')) continue
      const doc = parseOrNull(readFileSync(p, 'utf8')) ?? {}
      const table = typeof doc.table === 'string' ? doc.table : ''
      if (table === '' || !Array.isArray(doc.columns)) continue
      out.set(table, new Set(doc.columns.map((/** @type {any} */ c) => c?.name).filter((/** @type {unknown} */ n) => typeof n === 'string')))
    }
  }
  walk(base)
  return out
}

/** CLI 入口。 @returns {void} */
function main() {
  // 位置参数 = 去掉 `--flag` 与 `--new-source <值>` 后剩下的第一个（默认仓根）
  const argv = process.argv.slice(2)
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--new-source') { i += 1; continue }
    if (a.startsWith('--')) continue
    positional.push(a)
  }
  const rootDir = positional[0] ?? fileURLToPath(new URL('..', import.meta.url))
  const sem = join(rootDir, 'dbt', 'semantics')
  const metricsText = read(join(sem, 'l1_metrics.yml'))
  const metricsDoc = parseOrNull(metricsText)
  if (metricsDoc === null) {
    console.error(`${SCRIPT_NAME}: dbt/semantics/l1_metrics.yml 缺失或不可解析`)
    process.exit(1)
  }
  const violations = entityIssues(metricsDoc)
  const newSource = newSourceArg()
  if (newSource !== null) violations.push(...newSourceIssues(metricsDoc, newSource))
  const dims = parseOrNull(read(join(sem, 'dimensions.yml')))
  const inv = parseOrNull(read(join(sem, 'invariants.yml')))
  // 维度校验基准：contracts/ 里每张表的列集合（表名 → 列）
  const contractColumns = loadContractColumns(rootDir)
  if (dims !== null) violations.push(...dimensionIssues(dims, contractColumns))
  if (inv !== null) violations.push(...invariantIssues(inv))
  for (const [name, text] of [['dimensions.yml', read(join(sem, 'dimensions.yml'))], ['invariants.yml', read(join(sem, 'invariants.yml'))]]) {
    if (text !== '' && parseOrNull(text) === null) violations.push(`${name} 不是可解析的 YAML`)
  }
  if (violations.length > 0) {
    for (const v of violations) console.error(`[SEMANTICS] ${v}`)
    process.exit(1)
  }
  const nEnt = Object.keys(metricsDoc.entities ?? {}).length
  /** @param {any} d @param {string} key @returns {number} */
  const n = (d, key) => (Array.isArray(d?.[key]) ? d[key].length : 0)
  console.log(`${SCRIPT_NAME}: OK（entities ${nEnt} / dimensions ${n(dims, 'dimensions')} / invariants ${n(inv, 'invariants')}）`)
}

/**
 * 接新源前置闸：新源必须已挂在至少一个业务对象上（`source_systems` 含它）。
 * @param {any} metricsDoc l1_metrics.yml 解析结果
 * @param {string} system 新源系统名（如 wms）
 * @returns {string[]}
 */
export function newSourceIssues(metricsDoc, system) {
  const sys = String(system ?? '').trim()
  if (sys === '') return ['[new-source] 缺 --new-source <系统名>']
  const entities = metricsDoc?.entities ?? {}
  const hits = Object.entries(entities).filter(([, d]) => Array.isArray(/** @type {any} */ (d)?.source_systems) && /** @type {any} */ (d).source_systems.includes(sys))
  if (hits.length === 0) return [`[new-source] 新源 \`${sys}\` 没有挂到任何业务对象——先在 entities 的 source_systems 里登记它供给哪些对象（否则接进来就是孤儿数据）`]
  const out = []
  for (const [name, d] of hits) {
    const sor = typeof /** @type {any} */ (d)?.system_of_record === 'string' ? /** @type {any} */ (d).system_of_record : ''
    if (sor === '') out.push(`[new-source] 对象 ${name} 没有 system_of_record——多源下无法裁决`)
    else if (sor !== sys) {
      // 非权威源：合法（补充源），但必须在任务报告里写清合并规则
      out.push(`[new-source] 提醒：${name} 的权威源是 \`${sor}\`，\`${sys}\` 是补充源——接入报告需写明按 ${sor} 对齐、冲突按 merge_rule 处理`)
    }
  }
  return out
}

/** 供 CLI 识别 `--new-source <sys>`。 @returns {string | null} */
function newSourceArg() {
  const i = process.argv.indexOf('--new-source')
  if (i < 0) return null
  const v = process.argv[i + 1]
  return typeof v === 'string' && !v.startsWith('--') ? v : ''
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
