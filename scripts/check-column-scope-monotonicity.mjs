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
//   P2 值级脱敏四项（spec 2026-10-17 §4.3.1；同一脚本、不另起）：
//     ① 指标 `mask[].grantedBy` 必须 ∈ manifest `permissions[].code`（#822）——码发不出去 ⇒
//        谁都豁免不了 ⇒ 静默全掩。
//     ② 契约里出现任一 `sensitivity !== 'none'` 的列时，manifest 必须先有默认档豁免码
//        `DEFAULT_TIER_SCOPE`（#821 / #764 R6）——否则默认档一开，全租户静默拿 NULL 且无人能豁免。
//     ③ 同一列只许一处 `mask` 声明（#820 路线 C 前置）——两处会让「取哪个规格」无定义。
//     ④ 指标 `required_scope` 必须 ∈ manifest `permissions[].code`——码不存在 ⇒ 该指标对
//        所有人静默不可见（销 `check-data-models.mjs` 里「属另一条门禁」的陈旧承诺）。
//   ⚠️ 四项都只查「**申报了**的自洽性」，查不到「漏申报」——与下方同源的弱点，别让它看起来更强。
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
// 默认档的豁免码：**从写侧同一个常量取**（T3 `DEFAULT_TIER_SCOPE`），别在门禁里另写一份字面量
// —— 写侧与门禁读同一个值，才不会有「改了一处、另一处静默漂开」的口子。
import { DEFAULT_TIER_SCOPE } from '../modules/data/domain/authz.ts'

export const SCRIPT_NAME = 'check-column-scope-monotonicity'

/** 语义声明的事实源（与 sync / check-data-models 同一个文件）。 */
export const L1_DECLARATIONS_REL = 'dbt/semantics/l1_metrics.yml'

/** 本模块的权限清单（`permissions[].code`）——码的**唯一可发放来源**。 */
export const DATA_MANIFEST_REL = 'modules/data/manifest.yaml'

/** R12 存量 L2 盘点产物（spec §8.1 ③ 硬化后的发布门凭据）。 */
export const L2_INVENTORY_REL = 'docs/data/l2-sensitivity-inventory.md'

/**
 * manifest 里声明过的权限码集合。
 *
 * ⚠️ 仓内**没有**可复用的 manifest 权限读取器（`scripts/lib/` 只有 `data-contract.mjs`；
 * `check-manifests.mjs` 是 16 行 shim，走 `packages/platform-sdk` 的 `runChecks`，
 * 不导出 permissions）⇒ 本函数自带，别去找。
 *
 * @param {string} rootDir
 * @returns {Set<string>}
 */
export function loadManifestCodes(rootDir) {
  const doc = parseYaml(readFileSync(join(rootDir, DATA_MANIFEST_REL), 'utf8'))
  const perms = Array.isArray(doc?.permissions) ? doc.permissions : []
  // 箭头参数显式标类型：本仓 `scripts/` 是 checkJs（noImplicitAny）——不标就 tsc 报 TS7006。
  return new Set(
    perms
      .map((/** @type {any} */ p) => String(p?.code ?? ''))
      .filter((/** @type {string} */ c) => c !== ''),
  )
}

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
  const codes = loadManifestCodes(rootDir)

  // ② 有任一契约列带 sensitivity ⇒ 默认档的豁免码必须在 manifest 里
  //    （否则默认档一开，全租户静默拿 NULL 且**无人能豁免**——没有任何码能放行原值）
  const hasSensitiveColumn = [...sensitivity.values()].some((s) => s !== 'none')
  if (hasSensitiveColumn && !codes.has(DEFAULT_TIER_SCOPE)) {
    violations.push({
      file: DATA_MANIFEST_REL,
      message: `契约里已有列声明了 \`sensitivity !== 'none'\`，但 \`permissions[]\` 里没有`
        + ` \`${DEFAULT_TIER_SCOPE}\`（默认档的豁免码，spec §4.1.1 裁决 A）——`
        + '默认档一开，**谁都豁免不了**，全租户静默拿 NULL。'
        + `请先声明 \`${DEFAULT_TIER_SCOPE}\`（spec §8.1 的 ② 是人工步骤，闸只拦顺序颠倒）。`,
    })
  }

  // ②b 打 sensitivity ⇒ 必须先有 R12 存量 L2 盘点产物，且该产物覆盖当前**每一个**敏感列（spec §8.1 ③）。
  //     为什么是发布门而不是提示：打标那一刻**已经存在**的 L2 不会继承默认档整值掩码（spec §7 R12），
  //     而 L2_BASE_MASKED 写侧守卫**只拦新建** ⇒ 敞口恰好落在「打标前已存在」的那批上。
  //     ⚠️ 每次新增打标都会**重新打开**窗口（后打的标，其「打标前已存在」的 L2 是新的一批）
  //        ⇒ 所以判据是「逐列点名」而不是「文件存在」。
  //     ⚠️ 诚实边界：这条检查**只保证「产物在且点了名」**，**不保证盘点真的做了**——契约 gate
  //        读不到生产 `data.metrics`。这是刻意取舍（能拦「忘了做」，拦不住「写了 0」），
  //        后者归运行期判据（T2 登记进 #538 Phase 1）。别让后来者以为这条闸比实际强。
  const sensitiveCols = [...sensitivity.entries()]
    .filter(([, s]) => s !== 'none')
    .map(([c]) => c)
    .sort()
  if (sensitiveCols.length > 0) {
    let inventory = null
    try {
      inventory = readFileSync(join(rootDir, L2_INVENTORY_REL), 'utf8')
    } catch {
      inventory = null
    }
    if (inventory === null) {
      violations.push({
        file: L2_INVENTORY_REL,
        message: `契约里已有 ${sensitiveCols.length} 个列声明了 \`sensitivity !== 'none'\`（${sensitiveCols.join('、')}），`
          + `但 \`${L2_INVENTORY_REL}\` 不存在 —— 打标前必须先盘点存量 L2（spec §8.1 ③ 的发布门）。`
          + '打标时**已存在**的 L2 不会继承默认档整值掩码（spec §7 R12），'
          + '而 `L2_BASE_MASKED` 只拦新建 ⇒ 那批必须先确认、留痕。',
      })
    } else {
      // ⚠️ 判据必须**定界匹配**，不能用 `includes` 子串匹配（Task 1 评审 Important 订正）：
      //    本仓真实列名里有**前缀撞车对** —— `lemeng.branch_expense.settlement_state` ⊂
      //    `…settlement_state_name`、`…other_inout_flag` ⊂ `…other_inout_flag_name`、
      //    `…other_inout_kind` ⊂ `…other_inout_kind_code`、`lemeng.client_expense.other_inout_flag` ⊂
      //    `…other_inout_flag_name`。同概念的两列一起打标、操作者只列长名 ⇒ 短名**静默通过**，
      //    正是本闸存在的意义（防漏报）。⇒ 两侧都不许再接 `[A-Za-z0-9_.]`（列名含点，故点也算词内字符）。
      /** @param {string} c @returns {RegExp} */
      const namedRe = (c) => new RegExp(`(?<![A-Za-z0-9_.])${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_.])`)
      const missing = sensitiveCols.filter((c) => !namedRe(c).test(inventory))
      if (missing.length > 0) {
        violations.push({
          file: L2_INVENTORY_REL,
          message: '契约里这些列声明了 `sensitivity !== \'none\'` 但盘点产物里**没有点名**：'
            + `${missing.join('、')} —— 每次新增打标都会重新打开窗口（spec §8.1 ③），`
            + '盘点必须**逐列留痕**（点出列全名 + 查询原文 + 原始输出 + 日期）。',
        })
      }
    }
  }

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

  // ③ 按列解析要求「同一列只有一处声明」——否则并集里同一列有两个规格，谁赢没定义
  /** @type {Map<string, string>} */
  const colOwners = new Map()
  for (const m of metrics) {
    const name = String(m?.name ?? '(空)')
    if (!Array.isArray(m?.mask)) continue
    for (const item of m.mask) {
      const col = item?.column
      if (typeof col !== 'string' || col === '') continue // 整值/形状问题归别处
      const prev = colOwners.get(col)
      if (prev !== undefined) {
        violations.push({
          file: L1_DECLARATIONS_REL,
          message: `列 \`${col}\` 被两个指标各声明了一次 \`mask\`（\`${prev}\` 与 \`${name}\`）——`
            + '按列解析（spec §5.3.1 R10）下同一列只许一处声明，两处会让「取哪个规格」无定义。'
            + '请合并到一处，或改掉其中一处的 column。',
        })
        continue
      }
      colOwners.set(col, name)
    }
  }

  for (const m of metrics) {
    const name = String(m?.name ?? '(空)')

    // ① 掩码的豁免码必须真实存在于 manifest（否则发不出去 ⇒ 谁都豁免不了 ⇒ 静默全掩）
    if (Array.isArray(m?.mask)) {
      for (const item of m.mask) {
        const g = item?.grantedBy
        if (typeof g !== 'string' || g === '') continue // 形状问题归 check-data-models ⑤-d
        if (!codes.has(g)) {
          violations.push({
            file: L1_DECLARATIONS_REL,
            message: `指标 \`${name}\` 的 \`mask\` 声明了豁免码 \`${g}\`，但 ${DATA_MANIFEST_REL} 的`
              + ' `permissions[]` 里没有它 —— 装载器按各租户 org 逐个 upsert，**没声明就发不出去**'
              + '（admin 端点会 404 NO_SUCH_CODE）。失败方向是**过度掩码**（fail-closed）：'
              + '持码人也看掩码值。修法：在 manifest 里声明该码，或改掉 `grantedBy`。',
          })
        }
      }
    }

    // ④ required_scope 的码必须真实存在（今天 `check-data-models.mjs:1005` 写着「属另一条门禁」
    //    ——那条门禁**不存在**。本检查就是它。）
    if (m?.required_scope !== undefined && m.required_scope !== null) {
      const sc = String(m.required_scope)
      if (!codes.has(sc)) {
        violations.push({
          file: L1_DECLARATIONS_REL,
          message: `指标 \`${name}\` 的 \`required_scope: ${sc}\` 不在 ${DATA_MANIFEST_REL} 的`
            + ' `permissions[]` 里 —— 该指标对**所有人**静默不可见（码匹配不上，且没人能拿到它）。',
        })
      }
    }

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
