#!/usr/bin/env node
// check-semantics.mjs —— 语义层声明门禁（W4，路线图 G6 / #1444）。
//
// 管三份声明的一致性（口径仍只在 dbt/semantics/l1_metrics.yml，本文件不碰口径）：
//   · entities.yml    业务对象 + 权威源 + 对齐键
//   · dimensions.yml  维度层级（Task 3 接入；本文件先留读入口）
//   · invariants.yml  业务不变量（Task 4 接入）
//
// 判据（全部纯函数，单测直接喂桩）：
//   ① 对象名唯一且是合法标识符；
//   ② 必填齐全：label / system_of_record / identity_keys（非空）/ merge_rule / owner；
//   ③ 一个对象只能有一个权威源（跨源接入时它是裁决依据）；
//   ④ **未知 ≠ 没有**：指标里 `entity:` 引用的对象必须在 entities.yml 声明；
//   ⑤ 维度（接入后）：层级无环、level 唯一、引用列必须能在契约里找到。
//
// 用法：`pnpm exec tsx scripts/check-semantics.mjs [rootDir]`
// 契约：干净 → exit 0 + `check-semantics: OK（entities N / dimensions M / invariants K）`
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from 'yaml'

const SCRIPT_NAME = 'check-semantics'
const ENTITY_NAME_RE = /^[a-z][a-z0-9_]*$/

/**
 * 对象声明校验（纯函数）。
 * @param {unknown} doc `entities.yml` 解析结果
 * @param {Map<string,string>} metricEntityById 指标 id → entity 名（来自 l1_metrics.yml）
 * @returns {string[]} 违规项（空 = 干净）
 */
export function entityIssues(doc, metricEntityById) {
  const out = []
  const root = doc !== null && typeof doc === 'object' ? doc : {}
  const list = Array.isArray(root.entities) ? root.entities : null
  if (list === null) return ['[entities] 缺 entities: 数组']
  const seen = new Set()
  const declared = new Set()
  for (const [i, e] of list.entries()) {
    const at = `entities[${i}]`
    if (e === null || typeof e !== 'object') { out.push(`${at} 必须是对象`); continue }
    const name = typeof e.name === 'string' ? e.name.trim() : ''
    if (name === '') out.push(`${at} 缺 name`)
    else if (!ENTITY_NAME_RE.test(name)) out.push(`${at} name 不合规（小写蛇形）：${JSON.stringify(name)}`)
    else if (seen.has(name)) out.push(`${at} name 重复：${name}`)
    if (name !== '') { seen.add(name); declared.add(name) }
    if (typeof e.label !== 'string' || e.label.trim() === '') out.push(`${at} 缺 label（业务把人读的名字要能填）`)
    const sor = typeof e.system_of_record === 'string' ? e.system_of_record.trim() : ''
    if (sor === '') out.push(`${at} 缺 system_of_record（权威源是跨源裁决依据，必填）`)
    const keys = Array.isArray(e.identity_keys) ? e.identity_keys.filter((k) => typeof k === 'string' && k.trim() !== '') : []
    if (keys.length === 0) out.push(`${at} 缺 identity_keys（跨源对齐键，至少一个）`)
    const merge = typeof e.merge_rule === 'string' ? e.merge_rule.trim() : ''
    if (!['prefer_source', 'manual'].includes(merge)) out.push(`${at} merge_rule 只允许 prefer_source | manual，收到 ${JSON.stringify(merge)}`)
    if (typeof e.owner !== 'string' || e.owner.trim() === '') out.push(`${at} 缺 owner`)
    if (Array.isArray(e.aliases)) {
      const bad = e.aliases.filter((a) => typeof a !== 'string' || a.trim() === '')
      if (bad.length > 0) out.push(`${at} aliases 只能是字符串数组`)
    } else if (e.aliases !== undefined) out.push(`${at} aliases 必须是数组`)
  }
  // ④ 未知 ≠ 没有：指标引用的 entity 必须声明
  for (const [id, ent] of metricEntityById) {
    if (ent !== '' && !declared.has(ent)) out.push(`[l1_metrics] 指标 ${id} 引用了未声明的 entity：${ent}`)
  }
  return out
}

/** 读 l1_metrics.yml 的 name → entity（缺失 = ''）。 */
export function metricEntities(metricsYaml) {
  const map = new Map()
  let doc
  try { doc = parse(metricsYaml) } catch { return map }
  const items = doc?.metrics
  if (!Array.isArray(items)) return map
  for (const m of items) {
    if (m === null || typeof m !== 'object') continue
    if (typeof m.name !== 'string') continue
    map.set(m.name, typeof m.entity === 'string' ? m.entity.trim() : '')
  }
  return map
}

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
const parseOrNull = (text) => { try { return text === '' ? null : parse(text) } catch { return null } }

/** CLI 入口。 @returns {void} */
function main() {
  const rootDir = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url))
  const semDir = join(rootDir, 'dbt', 'semantics')
  const entities = parseOrNull(read(join(semDir, 'entities.yml')))
  const metricsYaml = read(join(semDir, 'l1_metrics.yml'))
  if (entities === null) {
    console.error(`${SCRIPT_NAME}: dbt/semantics/entities.yml 缺失或不可解析`)
    process.exit(1)
  }
  const violations = entityIssues(entities, metricEntities(metricsYaml))
  // Task 3/4 接入前，维度与不变量文件可缺席；存在就至少断言它是可解析的 YAML。
  const dimsText = read(join(semDir, 'dimensions.yml'))
  const invText = read(join(semDir, 'invariants.yml'))
  for (const [name, text] of [['dimensions.yml', dimsText], ['invariants.yml', invText]]) {
    if (text !== '' && parseOrNull(text) === null) violations.push(`${name} 不是可解析的 YAML`)
  }
  if (violations.length > 0) {
    for (const v of violations) console.error(`[SEMANTICS] ${v}`)
    process.exit(1)
  }
  const n = (d) => (Array.isArray(d?.entities) ? d.entities.length : 0)
  const m = (d, key) => (Array.isArray(d?.[key]) ? d[key].length : 0)
  console.log(`${SCRIPT_NAME}: OK（entities ${n(entities)} / dimensions ${m(parseOrNull(dimsText), 'dimensions')} / invariants ${m(parseOrNull(invText), 'invariants')}）`)
}

// 被单测 import 时不触发（与 check-mcp-toolface 同款 argv 守卫）
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()

// 供可能的未来消费者使用（当前仅 CLI）
export { readdirSync }
