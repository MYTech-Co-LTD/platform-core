#!/usr/bin/env node
// scripts/gen-fct-measures.mjs — fct 度量列生成区生成器（P3.0 聚合面组件化 / issue #1012；P3.2 起
// 生成区产物就是正式列，见 #1020）。
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
//      阶段 2 在 fct 粒度（`MODELS` 各项的 `fctGrain`）上 `sum(measure_value)`（CTE 名 `<组件>__rollup`）；
//      `grain: [flat]` 的组件（P3.3）没有阶段 2：阶段 1 直接在 fct 粒度求值；
//   ③ `gen_agg` —— 把各组件**上卷后**的结果按 fct 粒度对齐（full join + coalesce 键）。
//      ⚠️ 必须先各自上卷再 join：两个组件的阶段 1 粒度不同（订单 / 明细行），细粒度直接 join
//      会做笛卡尔积、把每侧按对方行数放大（fix round 1 的 Critical）。
// 本区产出的列是 `sale_amount__gen` / `return_amount__gen`（生成区的列名，由 fct 模型最终 SELECT
// 重命名为 `sale_amount` / `return_amount`）。`net_amount` **不在本区、也不由本生成器产出**：
// 它不属任何单一组件，由最终 SELECT 用上面两列相减得到。
//
// ## 为什么只写标记区、且 `--check` 逐字节比对
//
// 生成器一旦「顺手格式化整份 SQL」，每次改声明都会把无关行卷进 diff；更糟的是**手改也能过**
// ——标记区是声明（`l1_metrics.yml`）的唯一投影，手改它等于让生成物与声明悄悄漂移。
// 只认标记区 = 手改区外无害、手改区内必红。CI 里挂的是 `--check`（gates job）。
//
// ## 声明自洽（fail loud）
//
// `measure.grain[0]` 必须等于键名的 `@grain` 后缀，且域名必须已声明、组件必须在 `measures:` 里。
// 缺 domain 的组件**不许**默认成全表（那会让生成列的基面比声明语义宽，数偏大却看不出为什么）。
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

/** 标记区边界（逐字；改了它等于改了 `--check` 的判据面）。 */
export const BEGIN = '-- BEGIN GENERATED MEASURES'
export const END = '-- END GENERATED MEASURES'

/** 重新生成命令——失败信息里必须复述，否则「有意的摩擦」会变成「无解的摩擦」。 */
export const REGEN_COMMAND = 'pnpm exec tsx scripts/gen-fct-measures.mjs'

/**
 * 一个 fct 模型的生成输入：声明语义 → 生成物的全部绑定，一处收齐（P3.3 起，issue #1031）。
 *
 * @typedef {object} ModelSpec
 * @property {string} rel 仓内相对路径
 * @property {string} stagingRef 基面输入关系（口径模型只从这里取数）
 * @property {Record<string, string[]>} grainKeys grain 名 → 分组键；`flat` 不在此（单层直聚）
 * @property {string[]} fctGrain 该 fct 的粒度键（与模型头注声明的 grain 同源）
 * @property {string[]} columns 物化的组件键（顺序即生成顺序）
 * @property {Record<string, string>} baseAliases 组件键 → 基面 CTE 名
 */

/**
 * 被生成的目标模型注册表（`run` / `--check` 逐模型走同一渲染与比对流程）。
 *
 * 显式映射（baseAliases）而不是从名字里剥后缀：`sale_amount` → `sale` 这种推导一旦组件的
 * 命名换了口径（如 `gross_amount@order`），生成的 CTE 名会**跟着悄悄变**，而 SQL 引用侧是
 * 按名字读的。名字是契约，宁可在加组件时被这里逼着做一次决定。
 *
 * @type {ModelSpec[]}
 */
export const MODELS = [
  {
    rel: 'dbt/models/lemeng/marts/fct_retail_sale.sql',
    stagingRef: "{{ ref('stg_lemeng_retail_order_line') }}",
    // grain 名 → 分组键的唯一映射（组件键的 `@` 后缀是这里的一把钥匙）：
    // 销售侧（订单粒度）按前四键、退货侧（明细行粒度）按五键。
    grainKeys: {
      order: ['system_book', 'bizday', 'branch_num', 'order_no'],
      line: ['system_book', 'bizday', 'branch_num', 'order_no', 'order_detail_num'],
    },
    fctGrain: ['system_book', 'bizday', 'branch_num'],
    // `line_amount@line` 不在这里：它属 `vw_lemeng_retail_order_line` 的聚合面（行级原始金额）。
    columns: ['sale_amount@order', 'return_amount@line'],
    baseAliases: {
      'sale_amount@order': 'base_sale',
      'return_amount@line': 'base_return',
    },
  },
  // P3.3 Task 2（#1031）：门店费用构件——两列都是 flat（单层直聚，无中间粒度键 ⇒ grainKeys 空）。
  {
    rel: 'dbt/models/lemeng/marts/fct_branch_expense.sql',
    stagingRef: "{{ ref('stg_lemeng_branch_expense') }}",
    grainKeys: {},
    fctGrain: ['system_book', 'bizday', 'branch_num', 'expense_type'],
    columns: ['ep_payable@flat', 'er_receivable@flat'],
    baseAliases: {
      'ep_payable@flat': 'base_payable',
      'er_receivable@flat': 'base_receivable',
    },
  },
  // P3.3 Task 3-5 逐族追加其余三个 fct 的块（见各任务 Interfaces）
]

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
 * 逐组件的生成产物。
 * @typedef {object} RenderedComp
 * @property {string} name 阶段 1 的 CTE 名（`<组件>__gen`；flat 组件它同时是最终聚合输入）
 * @property {boolean} flat 是否 flat 组件（阶段 1 已在 fct 粒度 ⇒ 无上卷 CTE）
 * @property {string | null} col 非 flat 组件的阶段 2 聚合表达式（rollup 里用）；flat 组件为 null
 */

/**
 * 一份生成结果。
 * @typedef {object} RenderedFct
 * @property {string} ctes 基面 + 阶段 1 的 CTE 定义（逗号分隔，不含结尾逗号）
 * @property {RenderedComp[]} comps 逐组件产物（顺序与 `spec.columns` 一致）
 * @property {ModelSpec} spec 渲染用的模型 spec（`renderRegion` 据此取 fct 粒度）
 * @property {string[]} cols 非 flat 组件的阶段 2 聚合表达式（顺序同 `comps` 里的非 flat 项）
 * @property {string[]} names 各组件阶段 1 的 CTE 名（= 输出列名，顺序与 `spec.columns` 一致）
 */

/**
 * 渲染某个 fct 的度量 CTE 与聚合列。
 *
 * @param {Map<string, Measure>} measures 组件键 → measure（`measuresOf` 的产物）
 * @param {ModelSpec} spec 目标模型的生成输入（`MODELS` 的一项）
 * @param {Record<string, Domain>} [domains] `domainsOf` 的产物（基面 where 的派生源）
 * @returns {RenderedFct}
 */
export function renderFctMeasures(measures, spec, domains = {}) {
  if (!spec || !Array.isArray(spec.columns) || spec.columns.length === 0) throw new Error('ModelSpec.columns 不能为空')
  /** @type {string[]} */
  const ctes = []
  /** @type {RenderedComp[]} */
  const comps = []
  /** @type {Set<string>} */
  const emittedBases = new Set()

  for (const key of spec.columns) {
    const m = measures.get(key)
    if (!m) throw new Error(`fct 引用了未声明的组件 ${key}`)
    const at = key.lastIndexOf('@')
    const name = key.slice(0, at)
    const grain = key.slice(at + 1)
    // 声明自洽：grain 必须与键名后缀一致（`line_amount@line` 却声明 grain:[order] = 声明面自相矛盾；
    // `x@flat` 却声明 grain:[order] 同理——flat 不豁免这道）。只校验「有没有 grain」不够——
    // 缺省或写错都会让分组键与组件自述的原子粒度错位，而 SQL 照编不误。
    if (!m.grain || m.grain[0] !== grain) {
      throw new Error(`组件 ${key} 的 grain ${JSON.stringify(m.grain)} 与键名后缀 @${grain} 不一致`)
    }
    /** @type {string[] | undefined} 该 grain 的唯一键集；flat 没有（跳过键集两道校验） */
    let keys
    if (grain !== 'flat') {
      const ks = spec.grainKeys[grain]
      if (!ks) throw new Error(`未知 grain \`${grain}\`（只认 ${Object.keys(spec.grainKeys).join(' / ')} 与 flat）`)
      const missing = spec.fctGrain.filter((k) => !ks.includes(k))
      if (missing.length > 0) throw new Error(`grain \`${grain}\` 缺 fct 粒度键 ${missing.join(', ')}`)
      keys = ks
    }
    const base = spec.baseAliases[key]
    if (!base) throw new Error(`组件 ${key} 没有基面 CTE 名（baseAliases 缺项 —— 名字是契约，别靠推导）`)
    if (!m.domain) throw new Error(`组件 ${key} 缺 domain —— 基面 CTE 的 where 由它派生（不许默认全表）`)
    if (!Object.hasOwn(domains, m.domain)) {
      throw new Error(`组件 ${key} 的 domain \`${m.domain}\` 未在 \`domains:\` 里声明`)
    }
    if (!emittedBases.has(base)) {
      emittedBases.add(base)
      ctes.push(`${base} as (\n    select * from ${spec.stagingRef}\n    where ${resolveDomain(m.domain, domains)}\n)`)
    }
    if (grain === 'flat') {
      // flat：阶段 1 直接在 fct 粒度求值（expr 自身是单层可结合聚合，cast 走 precision），
      // **不产 rollup**（阶段 1 就是 fct 粒度，再上卷只是恒等的 group by）。无键集可校验 ⇒
      // 跳过「grain 键集查找」与「fctGrain ⊆ keys」两道；后缀一致性校验不豁免（上面已做）。
      ctes.push(
        `${name}__gen as (\n    select ${spec.fctGrain.join(', ')}, `
        + `${compileAggregate({ measure: m, column: `${name}__gen` })}`
        + ` from ${base} group by ${spec.fctGrain.map((_, i) => i + 1).join(', ')}\n)`,
      )
      comps.push({ name: `${name}__gen`, flat: true, col: null })
      continue
    }
    // 阶段 1：在组件自述的 grain 键上逐组求值（`keys` 是这个 grain 的唯一键集）
    ctes.push(`${name}__gen as (\n    ${compilePerGroup({ measure: m, keys: /** @type {string[]} */ (keys), baseAlias: base })}\n)`)
    // 阶段 2：fct 粒度求和（值来自阶段 1 的 `measure_value`，不是把 expr 直接塞进最终 SELECT）
    comps.push({
      name: `${name}__gen`,
      flat: false,
      col: compileAggregate({ measure: m, column: `${name}__gen`, valueExpr: `${name}__gen.measure_value` }),
    })
  }

  return {
    ctes: ctes.join(',\n'),
    comps,
    spec,
    cols: comps.filter((c) => !c.flat).map((c) => /** @type {string} */ (c.col)),
    names: comps.map((c) => c.name),
  }
}

/**
 * 某个组件的上卷 CTE 名：阶段 1 是**细粒度**（order / line 键），必须先各自上卷到 fct 粒度。
 * @param {string} name 组件名（阶段 1 的 CTE 名去掉 `__gen`）
 * @returns {string}
 */
function rollupName(name) {
  return `${name}__rollup`
}

/**
 * 上卷 CTE：把某组件的阶段 1 结果按 fct 粒度求和。
 *
 * 为什么**必须**先上卷再 join（2026-10-23 fix round 1 的 Critical）：两个组件的阶段 1 粒度不同
 * （sale 逐订单、return 逐明细行），直接按 `(账套, 业务日, 门店)` full join **会做笛卡尔积**——
 * 一个门店日 m 张订单 × n 条退货行 = m×n 行，随后 `sum()` 把每侧按对方的行数放大
 * （实测 2 单 100+50 + 3 行退货 −10/−20/−30 ⇒ 450 / −120，正确值 150 / −60）。
 * 单订单 + 单退货行的日子恰好乘 1 ⇒ 小样本看不出来，只有多行日才炸。
 *
 * @param {ModelSpec} spec 目标模型（fct 粒度的来源）
 * @param {string} name 组件的阶段 1 CTE 名（`<组件>__gen`）
 * @param {string} col 阶段 2 的聚合表达式（`compileAggregate` 的产物）
 * @returns {string}
 */
function renderRollup(spec, name, col) {
  return [
    `${rollupName(name.replace(/__gen$/, ''))} as (`,
    `    select ${spec.fctGrain.join(', ')}, ${col}`,
    `    from ${name}`,
    `    group by ${spec.fctGrain.map((_, i) => i + 1).join(', ')}`,
    ')',
  ].join('\n')
}

/**
 * 把各组件对齐到 fct 粒度（`gen_agg`）：分组组件用**上卷后**的结果，flat 组件直接用其
 * 阶段 1 CTE（它已在 fct 粒度，无 rollup 可言）。
 *
 * 为什么 full join + coalesce 键：sale 与 return 的行域**不重叠**（一侧排掉退货行、一侧只要退货行），
 * 某个门店日只有销售没有退货是常态 ⇒ 内连接会**静默丢行**（生成列少数，数偏小但原因隐蔽）。
 * 缺侧的列在此为 NULL，**由最终 SELECT 统一 `coalesce(…, 0)` 归零**
 * （见 fct 模型：`coalesce(gen_agg.sale_amount__gen, 0)`）。
 *
 * @param {ModelSpec} spec 目标模型（fct 粒度的来源）
 * @param {RenderedComp[]} comps 逐组件产物
 * @returns {string}
 */
function renderGenAgg(spec, comps) {
  // flat 组件直接以阶段 1 CTE 参与 join；分组组件以上卷 CTE 参与
  const rollups = comps.map((c) => (c.flat ? c.name : rollupName(c.name.replace(/__gen$/, ''))))
  const first = rollups[0]
  const keyLines = spec.fctGrain.map(
    (k) => `        coalesce(${rollups.map((r) => `${r}.${k}`).join(', ')}) as ${k}`,
  )
  const colLines = rollups.map((r) => `        ${r}.${r.replace(/__rollup$/, '__gen')}`)
  const joins = rollups.slice(1).map(
    (r) => `    full join ${r}\n        on  ${first}.${spec.fctGrain[0]} = ${r}.${spec.fctGrain[0]}`
      + spec.fctGrain.slice(1).map((k) => `\n        and ${first}.${k} = ${r}.${k}`).join(''),
  )
  return [
    'gen_agg as (',
    '    select',
    `${keyLines.join(',\n')},`,
    colLines.join(',\n'),
    `    from ${first}`,
    ...joins,
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
  const { spec, comps } = rendered
  const rollups = comps
    .filter((c) => !c.flat)
    .map((c) => renderRollup(spec, c.name, /** @type {string} */ (c.col)))
  const body = [rendered.ctes, ...rollups, renderGenAgg(spec, comps)].join(',\n')
  return [BEGIN, ...REGION_HEADER, body, END].join('\n')
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
 * 生成主流程：遍历 `MODELS`，逐模型渲染并比对/写回（`--check` 有任一模型漂移 ⇒ 1）。
 *
 * @param {string} rootDir 仓根
 * @param {{ check?: boolean }} [opts] `check` = 只比对不写（CI 用；有漂移 ⇒ 1）
 * @returns {number} 退出码
 */
export function run(rootDir, opts = {}) {
  const { measures, domains } = readSemantics(rootDir)
  for (const spec of MODELS) {
    const rendered = renderFctMeasures(measures, spec, domains)
    const expected = renderRegion(rendered)
    const file = join(rootDir, spec.rel)
    const text = readFileSync(file, 'utf8')
    const drift = driftMessage(extractRegion(text), expected)
    if (drift === null) {
      console.log(`${SCRIPT_NAME}: OK（${spec.rel}：${rendered.names.length} 个度量列：${rendered.names.join(', ')}）`)
      continue
    }
    if (opts.check) {
      console.error(`${SCRIPT_NAME}: ${spec.rel}\n  ${drift}\n  重跑：${REGEN_COMMAND}`)
      return 1
    }
    writeFileSync(file, replaceRegion(text, expected))
    console.log(`${SCRIPT_NAME}: 已重写 ${spec.rel} 的标记区（${rendered.names.length} 个度量列）`)
  }
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
