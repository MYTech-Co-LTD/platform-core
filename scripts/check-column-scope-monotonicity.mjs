#!/usr/bin/env node
// check-column-scope-monotonicity.mjs — 血缘单调门（issue #780；spec 2026-10-17 §4.3；
// 正典 docs/architecture.md §4.2「血缘单调」）。
//
// 用法：tsx scripts/check-column-scope-monotonicity.mjs [rootDir]   # 默认 = 仓根
// 契约：干净 → exit 0，stdout 一行 `check-column-scope-monotonicity: OK（…）`；
//       有违规 → exit 1，stderr 每条一行 `✗ <文件>\n      <说明>`。
//
// ── 判据（写死，别扩）──────────────────────────────────────────────────────────
//   源列 `sensitivity !== 'none'` 且被某指标的 `reads` 申报 ⇒ 该指标**必须**有 `required_scope`。
//   另：`reads` 指向契约里不存在的源列 ⇒ 也报（打错的名字会让本门**以为**没读它）。
//
// ── ⚠️ 这道门**查不到「漏申报」**，别让它看起来比实际强 ─────────────────────────
//   它只查「**申报了**的单调性」。完整性需要 contract → staging → marts 的**列级血缘**，
//   而仓内**不存在**（无 dbt manifest、无 parser；见 spec §2.3 U1/U2）。
//   ⇒ 少写一条 `reads` 就绕过本门。**这是已知且被记录的弱点**，不是 bug。
//   ⇒ 别为此加「按名字在 expression 里模糊匹配」的启发式：那会造出假阳性，
//      让真违规淹没在噪声里（本仓规矩：判据必须能变异确认）。
//
// ── 为什么读契约要用 readContractDoc，而不是自己 JSON.parse ──────────────────────
//   2026-10-17 的教训：`readContractDoc` 是**白名单式**构造，新字段若没在里面登记就会被**静默丢掉**
//   （T1 的 `sensitivity` 正是这么被丢过一次）。这里复用它、而不是另起一套解析 ⇒ 字段口径只有一处；
//   它一旦漏字段，`check-data-contract` 的既有用例会先红。
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'

import { collectJson, readContractDoc } from './lib/data-contract.mjs'
import { SENSITIVITY_KINDS } from './check-data-contract.mjs'

export const SCRIPT_NAME = 'check-column-scope-monotonicity'

/** 语义声明的事实源（与 sync / check-data-models 同一个文件）。 */
export const L1_DECLARATIONS_REL = 'dbt/semantics/l1_metrics.yml'

/** 契约里的基础设施文件（不是真契约），与 `check-data-contract` 同一份清单。 */
const NON_CONTRACT = new Set(['_schema.schema.json', '_template.contract.json'])

/** @typedef {{ file: string, message: string }} Violation */

/**
 * 源列全名 → sensitivity。全名 = `<domain>.<table>.<column>`（与 `reads` 的书写形态一致）。
 * 未声明 `sensitivity` 的列按 `'none'` 计（= 不敏感，与 check-data-contract 的缺省口径一致）。
 *
 * @param {string} rootDir
 * @returns {Map<string, string>}
 */
export function loadSensitivity(rootDir) {
  /** @type {Map<string, string>} */
  const m = new Map()
  for (const rel of collectJson(rootDir, 'contracts')) {
    if (NON_CONTRACT.has(rel.split('/').pop() ?? '')) continue
    const doc = readContractDoc(rootDir, rel)
    if (doc === null) continue // 坏 JSON 由 check-data-contract 报，这里不重复
    for (const col of doc.columns) {
      m.set(`${doc.domain}.${doc.table}.${col.name}`, col.sensitivity ?? 'none')
    }
  }
  return m
}

/**
 * @param {string} rootDir
 * @returns {Violation[]}
 */
export function checkColumnScopeMonotonicity(rootDir) {
  /** @type {Violation[]} */
  const violations = []
  const sensitivity = loadSensitivity(rootDir)

  /** @type {any} */
  let doc
  try {
    doc = parseYaml(readFileSync(join(rootDir, L1_DECLARATIONS_REL), 'utf8'))
  } catch (e) {
    violations.push({
      file: L1_DECLARATIONS_REL,
      message: `YAML 解析失败：${/** @type {Error} */ (e).message}`,
    })
    return violations
  }

  const metrics = Array.isArray(doc?.metrics) ? doc.metrics : []
  for (const m of metrics) {
    const name = String(m?.name ?? '(空)')
    if (!Array.isArray(m?.reads)) continue // 未申报 ⇒ 本门无从判（见文件头「查不到漏申报」）
    const hasScope = m.required_scope !== undefined && m.required_scope !== null
    for (const raw of m.reads) {
      const colId = String(raw)
      if (!sensitivity.has(colId)) {
        violations.push({
          file: L1_DECLARATIONS_REL,
          message: `指标 \`${name}\` 的 \`reads\` 里写了 \`${colId}\`，但契约里没有这一列 ——`
            + '打错的名字会让本门**以为**没读它而放行。请核对 `contracts/**` 的'
            + ' `domain` / `table` / `columns[].name`（全名形态 `<domain>.<table>.<column>`）。',
        })
        continue
      }
      const s = sensitivity.get(colId)
      if (s === 'none') continue
      if (!hasScope) {
        violations.push({
          file: L1_DECLARATIONS_REL,
          message: `指标 \`${name}\` 读了敏感源列 \`${colId}\`（sensitivity=${s}）`
            + ' 却没有声明 `required_scope` —— 违反血缘单调：藏了这一列，读它的指标照旧算得出'
            + '（spec §4.3 / 正典 §4.2 不变量「血缘单调」）。'
            + '给它补一个 `required_scope`（码要真实存在于 manifest 的 `permissions[]`），'
            + '或确认 `reads` 写错了。',
        })
      }
    }
  }
  return violations
}

/**
 * CLI 入口。
 *
 * @param {string[]} argv
 * @returns {number} 退出码
 */
export function main(argv) {
  const root = argv[2] ?? process.cwd()
  const violations = checkColumnScopeMonotonicity(root)
  if (violations.length > 0) {
    console.error(`${SCRIPT_NAME}: 发现 ${violations.length} 条违规`)
    for (const v of violations) console.error(`  ✗ ${v.file}\n      ${v.message}`)
    console.error('\n修法：给读了敏感源列的指标补 `required_scope`（码要真实存在于 manifest），'
      + '或修正 `reads`。口径见 docs/architecture.md §4.2 与 spec 2026-10-17 §4.3。')
    return 1
  }
  console.log(`${SCRIPT_NAME}: OK（血缘单调；sensitivity 闭集 ${SENSITIVITY_KINDS.join(' / ')}）`)
  return 0
}

const invoked = process.argv[1] ? relative(process.cwd(), process.argv[1]).split(sep).join('/') : ''
if (invoked.endsWith(`scripts/${SCRIPT_NAME}.mjs`)) {
  process.exit(main(process.argv))
}
