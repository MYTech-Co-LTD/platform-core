#!/usr/bin/env node
// scripts/gen-fct-measures.mjs — fct 度量列「影子生成器」（P3.0 聚合面组件化 / issue #1012）。
//
// ## 它生成什么
//
// `dbt/models/lemeng/marts/fct_retail_sale.sql` 里 `-- BEGIN/END GENERATED MEASURES` 之间的**整段**
// （标记区外的字节一律不碰）：
//   ① 基面 CTE `base_sale` / `base_return` —— `where` 由组件的具名行域（`l1_metrics.yml` 的
//      `domains:`）**派生**，不是手写。一个 base 不能服务两个行域（销售侧要排掉退货行、
//      退货侧只要退货行），故**每个组件各带一个**；
//   ② 两阶段编译（Task 4 的 `compilePerGroup` / `compileAggregate`）：
//      阶段 1 在组件自述的 grain 键上求 `measure_value`（CTE 名 `<组件>__gen`），
//      阶段 2 在 fct 粒度（`FCT_GRAIN`）上 `sum(measure_value)`；
//   ③ `gen_agg` —— 把各组件阶段 1 的结果按 fct 粒度对齐（full join + coalesce 键）后聚合。
// 唯一的**手写**派生列 `net_amount__gen` 不在本区里（它不属任何单一组件，见 fct 模型的最终 SELECT）。
//
// ## 为什么只写标记区、且 `--check` 逐字节比对
//
// 生成器一旦「顺手格式化整份 SQL」，每次改声明都会把无关行卷进 diff；更糟的是**手改也能过**
// ——而影子列的职责正是「与手写实现**独立**算一遍、由 singular test 逐分对账」（Task 6）。
// 只认标记区 = 手改区外无害、手改区内必红。CI 里挂的是 `--check`（gates job）。
//
// ## 声明自洽（fail loud）
//
// `measure.grain[0]` 必须等于键名的 `@grain` 后缀，且域名必须已声明、组件必须在 `measures:` 里。
// 缺 domain 的组件**不许**默认成全表（那会让影子列的基面比旧实现宽，对账红但看不出为什么）。
//
// 用法：
//   pnpm exec tsx scripts/gen-fct-measures.mjs            # 写回标记区
//   pnpm exec tsx scripts/gen-fct-measures.mjs --check    # 有漂移 ⇒ exit 1（CI 用）

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { parse as parseYaml } from 'yaml'

import { compileAggregate, compilePerGroup } from './lib/measure-compile.mjs'
import { L1_DECLARATIONS_REL, domainsOf, measuresOf, resolveDomain } from './sync-data-semantics.mjs'

// 声明文件的落点是**本生成器的输入契约**（测试与失败信息都要它）⇒ 从这里转出，不再各写一份字面量。
export { L1_DECLARATIONS_REL }

/** @typedef {import('./sync-data-semantics.mjs').Domain} Domain */
/** @typedef {import('./sync-data-semantics.mjs').Measure} Measure */

export const SCRIPT_NAME = 'gen-fct-measures'

/** 被生成的目标模型（仓内相对路径）。 */
export const FCT_REL = 'dbt/models/lemeng/marts/fct_retail_sale.sql'

/** 标记区边界（逐字；改了它等于改了 `--check` 的判据面）。 */
export const BEGIN = '-- BEGIN GENERATED MEASURES'
export const END = '-- END GENERATED MEASURES'

/** 重新生成命令——失败信息里必须复述，否则「有意的摩擦」会变成「无解的摩擦」。 */
export const REGEN_COMMAND = 'pnpm exec tsx scripts/gen-fct-measures.mjs'

/** 基面 CTE 的输入关系（与 fct 手写侧同一 staging：口径模型只从 ④ 的输入取数）。 */
export const STAGING_REF = "{{ ref('stg_lemeng_retail_order_line') }}"

/**
 * grain 名 → 分组键的**唯一映射**（组件键的 `@` 后缀是这里的一把钥匙）。
 * 键集与 fct 手写侧逐字一致：`per_order` 按前四键、明细侧按五键。
 * @type {Record<string, string[]>}
 */
export const GRAIN_KEYS = {
  order: ['system_book', 'bizday', 'branch_num', 'order_no'],
  line: ['system_book', 'bizday', 'branch_num', 'order_no', 'order_detail_num'],
}

/** fct 的粒度键（影子列最终按它聚合；与模型头注声明的 grain 同源）。 */
export const FCT_GRAIN = ['system_book', 'bizday', 'branch_num']

/**
 * 本 fct **物化**的组件键（顺序即生成顺序）。
 * `line_amount@line` **不在这里**：它属 `vw_lemeng_retail_order_line` 的聚合面（行级原始金额）。
 */
export const FCT_MEASURE_COLUMNS = ['sale_amount@order', 'return_amount@line']

/**
 * 组件键 → 基面 CTE 名。
 *
 * 显式映射而不是从名字里剥后缀：`sale_amount` → `sale` 这种推导一旦组件的命名换了口径
 * （如 `gross_amount@order`），生成的 CTE 名会**跟着悄悄变**，而 SQL 引用侧是按名字读的。
 * 名字是契约，宁可在加组件时被这里逼着做一次决定。缺项 ⇒ 抛错（不猜默认 base）。
 * @type {Record<string, string>}
 */
export const BASE_ALIASES = {
  'sale_amount@order': 'base_sale',
  'return_amount@line': 'base_return',
}

/**
 * 标记区的「不要手改」头注（生成物的一部分，逐字节参与 `--check`）。
 * @type {string[]}
 */
const REGION_HEADER = [
  '-- ⚠️ 本区由 scripts/gen-fct-measures.mjs 从 dbt/semantics/l1_metrics.yml 生成，**别手改**：',
  '--    基面的 where 由组件 domain 派生、两阶段聚合由 measure 编译而来。改声明 → 重跑生成器 → 一并提交；',
  '--    CI 的 `pnpm exec tsx scripts/gen-fct-measures.mjs --check` 逐字节比对本区，手改即红。',
]

/**
 * 一份生成结果。
 * @typedef {object} RenderedFct
 * @property {string} ctes 基面 + 阶段 1 的 CTE 定义（逗号分隔，不含结尾逗号）
 * @property {string} cols 阶段 2 的聚合列（逗号 + 换行分隔）
 * @property {string[]} names 各组件阶段 1 的 CTE 名（= 输出列名，顺序与 `columns` 一致）
 */

/**
 * 渲染某个 fct 的度量 CTE 与聚合列。
 *
 * @param {Map<string, Measure>} measures 组件键 → measure（`measuresOf` 的产物）
 * @param {string[]} [columns] 该 fct 物化的组件键（默认 `FCT_MEASURE_COLUMNS`）
 * @param {Record<string, Domain>} [domains] `domainsOf` 的产物（基面 where 的派生源）
 * @returns {RenderedFct}
 */
export function renderFctMeasures(measures, columns = FCT_MEASURE_COLUMNS, domains = {}) {
  if (!Array.isArray(columns) || columns.length === 0) throw new Error('fct 的度量列清单不能为空')
  /** @type {string[]} */
  const ctes = []
  /** @type {string[]} */
  const cols = []
  /** @type {string[]} */
  const names = []
  /** @type {Set<string>} */
  const emittedBases = new Set()

  for (const key of columns) {
    const m = measures.get(key)
    if (!m) throw new Error(`fct 引用了未声明的组件 ${key}`)
    const at = key.lastIndexOf('@')
    const name = key.slice(0, at)
    const grain = key.slice(at + 1)
    const keys = GRAIN_KEYS[grain]
    if (!keys) throw new Error(`未知 grain \`${grain}\`（只认 ${Object.keys(GRAIN_KEYS).join(' / ')}）`)
    // 声明自洽：grain 必须与键名后缀一致（`line_amount@line` 却声明 grain:[order] = 声明面自相矛盾）。
    // 只校验「有没有 grain」不够——缺省或写错都会让分组键与组件自述的原子粒度错位，而 SQL 照编不误。
    if (!m.grain || m.grain[0] !== grain) {
      throw new Error(`组件 ${key} 的 grain ${JSON.stringify(m.grain)} 与键名后缀 @${grain} 不一致`)
    }
    const missing = FCT_GRAIN.filter((k) => !keys.includes(k))
    if (missing.length > 0) throw new Error(`grain \`${grain}\` 缺 fct 粒度键 ${missing.join(', ')}`)

    const base = BASE_ALIASES[key]
    if (!base) throw new Error(`组件 ${key} 没有基面 CTE 名（BASE_ALIASES 缺项 —— 名字是契约，别靠推导）`)
    if (!m.domain) throw new Error(`组件 ${key} 缺 domain —— 基面 CTE 的 where 由它派生（不许默认全表）`)
    if (!Object.hasOwn(domains, m.domain)) {
      throw new Error(`组件 ${key} 的 domain \`${m.domain}\` 未在 \`domains:\` 里声明`)
    }
    if (!emittedBases.has(base)) {
      emittedBases.add(base)
      ctes.push(`${base} as (\n    select * from ${STAGING_REF}\n    where ${resolveDomain(m.domain, domains)}\n)`)
    }
    // 阶段 1：在组件自述的 grain 键上逐组求值（`keys` 是这个 grain 的唯一键集）
    ctes.push(`${name}__gen as (\n    ${compilePerGroup({ measure: m, keys, baseAlias: base })}\n)`)
    // 阶段 2：fct 粒度求和（值来自阶段 1 的 `measure_value`，不是把 expr 直接塞进最终 SELECT）
    cols.push(compileAggregate({ measure: m, column: `${name}__gen`, valueExpr: `${name}__gen.measure_value` }))
    names.push(`${name}__gen`)
  }

  return { ctes: ctes.join(',\n'), cols: cols.join(',\n        '), names }
}

/**
 * 把各组件阶段 1 的结果在 fct 粒度上对齐后聚合（`gen_agg`）。
 *
 * 为什么 full join + coalesce 键：sale 与 return 的行域**不重叠**（一侧排掉退货行、一侧只要退货行），
 * 某个门店日只有销售没有退货是常态 ⇒ 内连接会**静默丢行**（影子列少数，对账红但原因隐蔽）。
 * `sum(<name>__gen.measure_value)` 在缺侧时为 NULL，与手写侧 `coalesce(…, 0)` 的语义一致。
 *
 * @param {{ cols: string, names: string[] }} rendered
 * @returns {string}
 */
function renderGenAgg({ cols, names }) {
  const first = names[0]
  const keyLines = FCT_GRAIN.map(
    (k) => `        coalesce(${names.map((n) => `${n}.${k}`).join(', ')}) as ${k}`,
  )
  const joins = names.slice(1).map(
    (n) => `    full join ${n}\n        on  ${first}.${FCT_GRAIN[0]} = ${n}.${FCT_GRAIN[0]}`
      + FCT_GRAIN.slice(1).map((k) => `\n        and ${first}.${k} = ${n}.${k}`).join(''),
  )
  return [
    'gen_agg as (',
    '    select',
    `${keyLines.join(',\n')},`,
    `        ${cols}`,
    `    from ${first}`,
    ...joins,
    `    group by ${FCT_GRAIN.map((_, i) => i + 1).join(', ')}`,
    ')',
  ].join('\n')
}

/**
 * 标记区全文（含 BEGIN / END 两行，**不含**区外的前后逗号与空行）。
 *
 * @param {RenderedFct} rendered
 * @returns {string}
 */
export function renderRegion(rendered) {
  return [BEGIN, ...REGION_HEADER, `${rendered.ctes},`, renderGenAgg(rendered), END].join('\n')
}

/**
 * 取出文件里的标记区（含两行标记）。
 *
 * 缺标记 / 顺序反转 / 重复一律抛错：生成器**不猜**插入点——猜错会把整份模型写成非法 SQL，
 * 而错误只在 dbt parse 时才现形（本地无库 ⇒ 更晚才发现）。
 *
 * @param {string} text fct 文件全文
 * @returns {string} 标记区（从 BEGIN 行首到 END 行尾）
 */
export function extractRegion(text) {
  const b = text.indexOf(BEGIN)
  const e = text.indexOf(END)
  if (b < 0 || e < 0) throw new Error(`缺标记区（需同时有 \`${BEGIN}\` 与 \`${END}\`）`)
  if (e < b) throw new Error(`标记区顺序反转（\`${END}\` 出现在 \`${BEGIN}\` 之前）`)
  if (text.indexOf(BEGIN, b + BEGIN.length) >= 0) throw new Error('标记区重复：BEGIN 出现多次（只许一处）')
  if (text.indexOf(END, e + END.length) >= 0) throw new Error('标记区重复：END 出现多次（只许一处）')
  return text.slice(b, e + END.length)
}

/**
 * 用新的标记区替换旧的；区外逐字节不动。
 *
 * @param {string} text fct 文件全文
 * @param {string} region 新标记区（`renderRegion` 的产物）
 * @returns {string}
 */
export function replaceRegion(text, region) {
  const old = extractRegion(text)
  const b = text.indexOf(old)
  return text.slice(0, b) + region + text.slice(b + old.length)
}

/**
 * 逐字节比对标记区（`--check` 的判据）。一致返回 null；不一致返回人读的差异描述。
 *
 * @param {string} onDisk 文件里的标记区
 * @param {string} expected 生成物
 * @returns {string | null}
 */
export function driftMessage(onDisk, expected) {
  if (onDisk === expected) return null
  const a = onDisk.split('\n')
  const z = expected.split('\n')
  let i = 0
  while (i < a.length && i < z.length && a[i] === z[i]) i += 1
  return `标记区与生成物不一致（漂移），首个差异在第 ${i + 1} 行：\n`
    + `    文件: ${JSON.stringify(a[i] ?? '<缺行>')}\n`
    + `    生成: ${JSON.stringify(z[i] ?? '<缺行>')}`
}

/**
 * 读仓内的语义声明（组件 + 行域，唯一事实源 `dbt/semantics/l1_metrics.yml`）。
 *
 * @param {string} rootDir 仓根
 * @returns {{ measures: Map<string, Measure>, domains: Record<string, Domain> }}
 */
export function readSemantics(rootDir) {
  const parsed = /** @type {Record<string, unknown>} */ (parseYaml(readFileSync(join(rootDir, L1_DECLARATIONS_REL), 'utf8')))
  return { measures: measuresOf(parsed), domains: domainsOf(parsed) }
}

/**
 * 生成主流程。
 *
 * @param {string} rootDir 仓根
 * @param {{ check?: boolean }} [opts] `check` = 只比对不写（CI 用；有漂移 ⇒ 1）
 * @returns {number} 退出码
 */
export function run(rootDir, opts = {}) {
  const { measures, domains } = readSemantics(rootDir)
  const rendered = renderFctMeasures(measures, FCT_MEASURE_COLUMNS, domains)
  const expected = renderRegion(rendered)
  const file = join(rootDir, FCT_REL)
  const text = readFileSync(file, 'utf8')
  const drift = driftMessage(extractRegion(text), expected)
  if (drift === null) {
    console.log(`${SCRIPT_NAME}: OK（${rendered.names.length} 个度量列：${rendered.names.join(', ')}）`)
    return 0
  }
  if (opts.check) {
    console.error(`${SCRIPT_NAME}: ${FCT_REL}\n  ${drift}\n  重跑：${REGEN_COMMAND}`)
    return 1
  }
  writeFileSync(file, replaceRegion(text, expected))
  console.log(`${SCRIPT_NAME}: 已重写 ${FCT_REL} 的标记区（${rendered.names.length} 个度量列）`)
  return 0
}

const invoked = process.argv[1]?.endsWith('scripts/gen-fct-measures.mjs') ?? false
if (invoked) {
  // 位置参数（仓根）与旗标必须分开取：`argv[2]` 在 `--check` 形态下就是旗标本身，
  // 直接当 root 会拼出 `<cwd>/--check/dbt/...`（不存在）⇒ 读文件 ENOENT。未知旗标一律拒。
  const args = process.argv.slice(2)
  const unknown = args.filter((a) => a.startsWith('--') && a !== '--check')
  if (unknown.length > 0) {
    console.error(`${SCRIPT_NAME}: 未知参数 ${unknown.join(' ')}（只认 --check）`)
    process.exit(2)
  }
  const root = args.find((a) => !a.startsWith('--')) ?? process.cwd()
  process.exit(run(root, { check: args.includes('--check') }))
}
