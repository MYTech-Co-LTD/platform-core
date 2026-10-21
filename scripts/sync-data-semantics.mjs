#!/usr/bin/env node
// sync-data-semantics.mjs — **L1 语义声明 → data.metrics 的唯一物化通道**（issue #150 / 计划 Task 8）。
//
// 用法：DATABASE_URL=postgres://… pnpm exec tsx scripts/sync-data-semantics.mjs [模式]
//       **不给模式 = 写库**（把 data.metrics 里 org='platform' 的 L1 行对齐到仓内声明）。
//       不写库的模式有两个：`--check`（门禁：有漂移 exit 1）与 `--dry-run`（不是门禁：exit 恒 0）。
//       `--help` 打印同一份说明（文案的唯一事实源是下面的 `FLAG_HELP`，不会两处各说各话）。
// 契约：成功 → exit 0，stdout 一行 `sync-data-semantics: …`；**有漂移的 --check** → exit 1；
//       参数用法错（未知 flag / 模式互斥）→ exit 2；其余失败（YAML 坏 / 形状不合契约 /
//       缺 DATABASE_URL）→ exit 1，stderr 一条可解释的错误。
//
// ── ⚠️ 未知 flag 一律**响亮拒绝**，绝不再静默忽略（T8 评审 I1，Important）────────────────
// 改前：脚本只看 `argv.includes('--dry-run')`，其它一律无视 ⇒ 打了 `--check` 的命令
// **实际向真库物化了**（评审在真库上复现），且 exit 0 全绿——一个「检查 job」在写生产库。
// 这是 fail-open 里最坏的一类：假绿 + 有副作用。故未知 flag → exit 2 + 列出支持项。
// T9 的门禁③消费 `--check`：**1 = 检出漂移**、**2 = 用法错**（两者都是非 0，但含义不同）。
//
// ── ⚠️ 主体列已补、但**真库验证尚未做**（issue #176 缺口 A 的仓内那半已落地）─────────────
// `dbt/models/**` 已由 `macros/subject_org.sql` 注入 `org` 列，`domain/authz.ts` 的 `authorize`
// 恒拼的 `WHERE <主体列> = '<org>'` 因此**有了着力点**（此前少这一列 ⇒ 查询必以仓库错误 502 收场）。
// **但真库出数的验收归 spec B**：本机没有 dbt / pg_duckdb ⇒ 别把「静态门禁绿」读成「真机跑过了」，
// 也别把本脚本的 exit 0 读成「指标可查」。设计（含验收分层）见
// docs/superpowers/specs/2026-09-26-subject-org-column-design.md §4。
//
// ── 它存在的理由（全局约束 12 的另一半）────────────────────────────────────────────
// 约束 12 说「L1 行的 select_sql 只能由 sync 脚本从仓内 YAML 物化写入」。这一句需要两半才成立：
//   · **写侧唯一**：`data.metrics` 里 `source='l1'` 的行只能由本脚本写（存储层的
//     `upsertL1Metric` 是唯一的 L1 写入口；管理 API 走 `upsertMetric`，它写死 source='l2'）。
//   · **事实源唯一**：本脚本的输入只有仓内的 dbt 声明文件 ⇒ 「平台上跑着哪些平台指标」
//     永远可由某个 commit 复现（而不是「某人某天在 console 上点出来的」）。
//
// ── ⚠️ 与计划正文的一处**有意偏离**（事实源文件的位置）────────────────────────────
// 计划 Task 8 写的是「读 `dbt/models/**/schema.yml` 的语义声明」。**实际事实源不是那里**：
// T4 已把 L1 声明落在 `dbt/semantics/l1_metrics.yml`——理由是指标名是 `<源>:<业务域>:<指标>` 形态
// （**含冒号**），而 dbt 资源名不允许冒号，放进 dbt 会扫的 schema 文件有让 `dbt parse` 挂掉的
// 风险（见 `dbt/README.md` §5「L1 语义声明的落点」原文，静态门禁两处都扫）。
// ⇒ 本脚本读的是**实际的事实源**。照计划原文去读 `models/**/schema.yml` 会**一条声明都读不到**
//   （那个文件里只有列描述与 tests），然后把 `data.metrics` 的 L1 行**全部删除**——
//   静默清空平台词表，是这条偏离里最危险的失败形态。故此处以仓内现状为准，并在任务报告点名。
//
// ── 幂等（部署脚本/job 会反复重跑）─────────────────────────────────────────────────
//   · 逐条 `upsert`（同 (org,id) 覆盖内容）；**声明的集合**才是真值 ⇒ 多出来的 L1 行删除。
//   · 重跑第二遍：新增 0 / 更新 0 / 删除 0 / 未变 N（内容比对，不是「跑完没报错」）。
//   · 删除只在 `org='platform' and source='l1'` 范围内 ⇒ 碰不到任何租户的 L2 行。
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import {
  L1_ORG,
  deleteStaleL1Metrics,
  loadPlatformCatalog,
  upsertL1Metric,
} from '../modules/data/domain/metric-store.ts'
// MASK_KINDS 是**值** import（校验要用它的集合成员判断），不是类型引用：kind 词表的唯一定义
// 在 authz.ts（spec 2026-10-17 §5.1「能选不能扩」），这里与门禁、T2 的 mask.ts 共用一份——
// 两处各列一份 kind，漂开的那份就是静默绕过口。authz.ts 是纯模块（不 import pool/env/Hono），
// 拖进来不破坏本脚本的「只连库不连服务」边界。
// 一并取默认档的豁免码 `DEFAULT_TIER_SCOPE`（spec §4.1.1 裁决 A）：**写侧与门禁读同一个值**，
// 别在这里另写一份字面量——「改了一处、另一处静默漂开」正是本任务要堵的口子。
import { MASK_KINDS, DEFAULT_TIER_SCOPE } from '../modules/data/domain/authz.ts'
// 「这一列在不在 selectSql 里」的**唯一实现**（#830）：声明侧与运行期共用一份。本脚本曾自带
// 一份 `as __alias__` 文本哨兵，与运行期各写一份 ⇒ 同一件事两个尺（PR #827 评审 M1 实测出两个
// 反例：哨兵名撞车、大小写不匹配）。mask.ts 是纯模块（只 import type），拖进来不破坏本脚本
// 「只连库不连服务」的边界。
import { sqlMentionsColumn } from '../modules/data/domain/mask.ts'
// 契约的 `sensitivity`（默认档的判据来源）：复用血缘门的读取器，别另起一套契约解析——字段口径
// 只有一处（T1 的 `sensitivity` 曾被白名单式构造静默丢过一次，见该文件头注）。
// **安全**：该文件的 CLI 守卫比对 `process.argv[1]` ⇒ 被 import 时不跑 main；
// 且**无环**（门禁不 import 本脚本）。
import { loadSensitivity } from './check-column-scope-monotonicity.mjs'

// 类型引用走 JSDoc 的 `import(...)`（`.mjs` 里不能写 `import type` —— TS8006）。写成类型引用
// 而不是值 import：只借它的**形状**，不在运行期多 import 一个模块。
/** @typedef {import('../modules/data/domain/authz.ts').MetricParamDef} MetricParamDef */
/** @typedef {import('../modules/data/domain/authz.ts').MaskSpec} MaskSpec */
/** @typedef {import('../modules/data/domain/authz.ts').DrillBinding} DrillBinding */

export const SCRIPT_NAME = 'sync-data-semantics'

/** L1 声明的事实源（仓内相对路径）。 */
export const L1_DECLARATIONS_REL = 'dbt/semantics/l1_metrics.yml'

/** 主体列：L1 行的主体钉死依据（与 `dbt/macros/generate_schema_name.sql` 的「行内 org」同源）。 */
export const L1_SUBJECT_COLUMN = 'org'

/**
 * 表达式里的**限定列引用**（`关系.列`，关系本身可再带 schema）。
 * 本脚本要用它反推 FROM 的关系名——见 `deriveRelation` 的「为什么必须限定」。
 */
const QUALIFIED_REF_RE = /([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.([A-Za-z_][A-Za-z0-9_]*)/g

/** 指标名形态 `<源>:<业务域>:<指标>`（与 scripts/check-data-models.mjs 规则 ⑥ 同一句；门禁是权威，这里只兜底）。 */
const METRIC_NAME_RE = /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/

/**
 * 差集比对的**唯一形状**：本脚本要用的全部字段，一个不少、一个不多。
 *
 * 为什么用这个结构类型而不是 `Record<string, unknown>`：后者在 checkJs 下**接不住** `MetricRow`
 * （TS 接口没有索引签名）——那是本次实打实撞到的类型错误，不是假想。而差别再往下走一层：
 * `params` 必须写成 `Record<string, MetricParamDef>` 而不是 `Record<string, unknown>`，
 * 否则它接不住 `MetricDef`（写库入口的形参类型）。⇒ 索性按 `MetricDef` 的字段逐条写全
 * （L1 行本来就是 `MetricDef` 形状 + 由写入口补的 org/source）。
 * 单个具体形状（字段恒在、无联合）也正合 scripts/ 是 checkJs 工程的脾气：
 * JSDoc 里写可辨识联合会被加宽，窄化随之失效。
 *
 * `sourceSystem` 必须**进**这个形状（而不只是进 `MetricDef` 的传递）：它是 `comparableOf` 的
 * 比对面之一，而 `comparableOf` 是 `--check` 判「有没有漂移」的唯一判据。少了它，改了声明的
 * `source` 而库里的 `source_system` 还是旧值 ⇒ 判「未变」⇒ 门禁报「无漂移」（假绿），
 * 而这恰恰是 sync 存在的理由（把声明的变化变成一次可见的写）。
 *
 * @typedef {object} ComparableMetric
 * @property {string} id
 * @property {string} title
 * @property {string} description
 * @property {string | null} requiredScope
 * @property {string} subjectColumn
 * @property {string} selectSql
 * @property {string} groupBy
 * @property {Record<string, MetricParamDef>} params
 * @property {string | null} sourceSystem
 * @property {boolean} totalable 可加标记（spec §8.4，deriveTotalable 从 expression 推导）
 * @property {string} [scopeNote] 口径射程与排除项（消费面 spec §12.6，声明 `scope_note` 的物化值；
 *                  '' = 未声明——允许空串是为了接住**库内旧行**：sync 未刷过该列的存量 L1 行）
 * @property {number | null} slaDays 新鲜度 SLA 承诺天数（spec §10.7.1，声明 freshness_sla_days 的物化值；
 *                  允许 null 是为了接住**库内旧行**——sync 未刷过 sla_days 的存量 L1 行；
 *                  声明侧推导出的行恒为非负整数，库侧读取不信任存储形状）
 * @property {string[] | null} freshnessRelations 新鲜度关系集（spec §10.7.3，deriveFreshnessRelations
 *                  从 sources 推导；null 同上——接住库内旧行）
 * @property {MaskSpec[] | null} masks 值级掩码声明（spec 2026-10-17 §5.2，声明 `mask` 的物化值；
 *                  null = 未声明——接住库内旧行与 L2 侧）
 * @property {string | null} drillExpr 下钻值表达式（下钻 spec 2026-10-21 §2.3，声明 compose 的编译产物
 *                  ——composeOf；null = 未声明。库侧行的 `MetricRow.drill` 是归一后的可选绑定，
 *                  **必须**先经 `drillTripleOf` 翻译成这份三键形状再进比对）
 * @property {string[] | null} drillDims 下钻维度闭集（声明 `dimensions` 的物化值；null = 未声明）
 * @property {{ relation: string, filter: string } | null} drillDetail 下钻明细关系与行域过滤
 *                  （声明 `detail` 的物化值；null = 未声明）
 */

/**
 * 对象存储路径里认得的**资产段**形态（要拼进 `stg_lemeng_<资产>` 这个 SQL 标识符，
 * 必须是安全形状：小写字母/数字/下划线、非空）。
 */
const FRESHNESS_ASSET_RE = /^[a-z0-9_]+$/

/**
 * 新鲜度关系集推导（spec §10.7.3）：声明 `sources` 的存储路径段 `lemeng/<资产>` ⇒ 关系名
 * `stg_lemeng_<资产>`。
 *
 * ── 为什么是「命名约定即事实」而不是再要一个显式声明字段 ─────────────────────────────
 * staging 模型名在仓内是 `stg_<源>_<资产>`（`dbt/models/<域>/staging/stg_lemeng_*.sql`，
 * 14 个全部同构，check-data-models 规则 ④ 的双向配对盯着的正是这个形状）；水位要查的表就是
 * 这些 staging 模型落的表。让声明再写一遍关系名 = 两处事实源（sources 已写了路径段）。
 * 故这里**机械推导**：推导不出来（路径里没有 `lemeng/` 段、资产段形状不安全）就**响亮失败**
 * ——瞎猜一个关系名，水位查询会静默查空（freshness 永远「未知」），坏在数据里不报错。
 *
 * @param {readonly string[] | undefined} sources 声明的对象存储路径（选填；undefined/空 = 无链路）
 * @returns {string[]} 关系名数组（保序去重；无 sources = 空数组 = 无自动水位）
 */
export function deriveFreshnessRelations(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return []
  /** @type {string[]} */
  const relations = []
  for (const raw of sources) {
    const p = String(raw)
    const idx = p.indexOf('lemeng/')
    if (idx === -1) {
      throw new Error(
        `指标声明 sources 路径 \`${p}\` 里没有 \`lemeng/<资产>\` 段，推不出新鲜度关系名 `
        + '（spec §10.7.3 的推导依赖路径段与 staging 模型名 `stg_lemeng_<资产>` 同构）。'
        + '请把 sources 写成实际读的湖路径（如 `s3://<bucket>/lemeng/<资产>/…`），'
        + '或显式不写 sources（= 该指标无自动水位，响应不带 freshness 字段）。',
      )
    }
    const rest = p.slice(idx + 'lemeng/'.length)
    const asset = rest.split('/')[0] ?? ''
    if (!FRESHNESS_ASSET_RE.test(asset)) {
      throw new Error(
        `指标声明 sources 路径 \`${p}\` 的资产段 \`${asset}\` 形态不合规 —— 它要拼成 SQL 标识符 `
        + `\`stg_lemeng_${asset}\`，只允许小写字母/数字/下划线（staging 模型名同构）。`,
      )
    }
    const relation = `stg_lemeng_${asset}`
    if (!relations.includes(relation)) relations.push(relation)
  }
  return relations
}

/**
 * 声明的 `freshness_sla_days` → 数值。**缺声明/坏形状一律响亮失败**（spec §10.7.1）。
 *
 * 为什么不许静默默认：SLA 是**人工登记值**（采集正典实测窗口的登记，不是推导产物），
 * 默认值会让「忘登记的新指标」永远拿一个看似合法的承诺、状态转译照常出数——错得悄无声息。
 * 响亮失败把「登记动作」变成新指标上线清单里绕不过去的一步。
 *
 * @param {unknown} v 声明字段的原始值
 * @param {string} metricName 指标名（只用于错误信息）
 * @returns {number}
 */
function slaDaysOf(v, metricName) {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v
  throw new Error(
    `指标 \`${metricName}\` 的 \`freshness_sla_days\` ${JSON.stringify(v ?? null)} 缺失或不是**非负整数** `
    + '（spec §10.7.1：新鲜度 SLA 承诺天数——物化水位距今天 ≤N 个业务日即「正常」；'
    + '现行登记 inventory 两指标 = 2、其余 = 1）。它是服务端 freshness_status 转译的算术判据，'
    + '缺了/错了不许静默默认——请在声明里显式登记。',
  )
}

/**
 * `required_scope`：**缺省 = `null`**（所有拿到本模块的人可见，与今天一致）；给了就必须是
 * **非空、无首尾空白**的字符串。
 *
 * ── 为什么不 trim 而是拒绝（与 `source` 那条同款坑）──────────────────────────────
 * 本脚本的脾气是「取不到 / 说不准就**响亮失败**」，静默 trim 等于替作者改他的声明。
 * 而这个值要与 `modules/data/manifest.yaml` 的 `permissions[].code` **逐字**比对才生效
 * （`requester.hasScope()` 是集合成员判断，不认近似值）⇒ 带空白的码 = 谁也匹配不上
 * = 该指标对**所有人**静默不可见。坏在数据里，不报错。
 *
 * ── 本函数**不**校验码是否存在 ─────────────────────────────────────────────────
 * 那需要读另一个文件（manifest），属静态门禁的活（`scripts/check-data-models.mjs`）。
 * 本函数只保证**形状**。
 *
 * @param {unknown} v 声明里的 `required_scope`
 * @param {string} metricName 指标名（只用于错误信息）
 * @returns {string | null}
 */
function requiredScopeOf(v, metricName) {
  if (v === undefined || v === null) return null
  // ⚠️ 必须是字符串本身，**不做 `String(v)` 强转**：YAML 里写 `required_scope: 123` 会解析成
  // number，强转成 `"123"` 就悄悄造出一个不存在的权限码（症状同样是「该指标对所有人不可见」）。
  if (typeof v !== 'string') {
    throw new Error(
      `指标 \`${metricName}\` 的 \`required_scope\` ${JSON.stringify(v)} 不是字符串 —— `
      + '权限码必须写成字符串（如 `data:cost`）。YAML 会把裸数字/布尔解析成别的类型，'
      + '强转出来的是**不存在的码**，该指标将对所有人静默不可见。',
    )
  }
  const s = v
  if (s.trim() === '') {
    throw new Error(
      `指标 \`${metricName}\` 的 \`required_scope\` 是空白 —— 空白码谁也匹配不上`
      + '（症状：该指标对**所有人**静默不可见，且不报错）。要么删掉这个键，要么写一个'
      + '真实存在于 `modules/data/manifest.yaml` 的 `permissions[].code`。',
    )
  }
  if (s !== s.trim()) {
    throw new Error(
      `指标 \`${metricName}\` 的 \`required_scope\` ${JSON.stringify(s)} 首尾带空白 —— `
      + '权限码是**逐字**比对的集合成员判断，带空白匹配不上（症状同样是「该指标对所有人'
      + `查不出来」且不报错）。请写成 \`${s.trim()}\`（本脚本不替声明做 trim）。`,
    )
  }
  return s
}

/** mask 条目的**键闭集**（声明面形状，spec 2026-10-17 §5.2；与 authz.ts 的 MaskSpec 同形）。 */
const MASK_ITEM_KEYS = new Set(['column', 'kind', 'step', 'grantedBy'])

/**
 * mask **单条**声明的形状核（纯函数；返回违规文案，合法返回 null）。
 *
 * ★ 逐项判据的**唯一实现**：`masksOf`（本文件，物化侧）与 `check-data-models.mjs` 规则 ⑤-d
 * （静态门禁）都从它取——门禁手里**没有**物化后的 selectSql，故「column 须逐字出现在
 * selectSql 里」那条不在这里、只归 masksOf（两处各判会各留一个假绿面，见 masksOf 头注）。
 * 判据（spec §5.2，写死）：
 *   · 元素是对象、键闭集 {column, kind, step, grantedBy}（拼错的键 = 声明写了但没生效）；
 *   · `kind ∈ MASK_KINDS`（闭集常量在 authz.ts，能选不能扩）；
 *   · `kind === 'round'` ⇒ `step` 必须是正整数（运行期展开成 `round(col, -step)`，负数/小数
 *     会物化出一条运行期才炸的掩码表达式）；
 *   · `grantedBy` 必须是非空、无任何空白的字符串（它是逐字比对的权限码，带空白谁也匹配不上
 *     ⇒ 对持码人照掩不误——掩码过度生效，症状静默）；
 *   · `column` 必须是**非空字符串**——**整值形态（column 缺席或为 null）一律拒**（spec §5.3.1
 *     R10 配套 2）：想整值隐藏 ⇒ **给源列打 `sensitivity`**（物化层自动合成整值 nullify 默认档，
 *     见 T5）；YAML 里**写不出**整值形态。
 *
 * @param {unknown} item mask 数组的单个元素
 * @param {string} metricName 指标名（只用于错误信息）
 * @returns {string | null} 违规文案；合法返回 null
 */
export function maskItemError(item, metricName) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    return `指标 \`${metricName}\` 的 \`mask\` 元素必须是对象（{column, kind, step?, grantedBy}），收到 ${JSON.stringify(item ?? null)}`
  }
  for (const k of Object.keys(item)) {
    if (!MASK_ITEM_KEYS.has(k)) {
      return `指标 \`${metricName}\` 的 \`mask\` 元素有未知键 \`${k}\` —— 键闭集是 `
        + `{column, kind, step, grantedBy}，拼错的键会被静默忽略（声明写了但没生效 = 掩码不生效）`
    }
  }
  const m = /** @type {Record<string, unknown>} */ (item)
  if (typeof m.kind !== 'string' || !(/** @type {readonly string[]} */ (MASK_KINDS)).includes(m.kind)) {
    return `指标 \`${metricName}\` 的 \`mask\` kind ${JSON.stringify(m.kind ?? null)} 不在词表里 —— `
      + `只允许 ${MASK_KINDS.join(' / ')}（闭集常量 MASK_KINDS 在 modules/data/domain/authz.ts，`
      + '能选不能扩；加 kind 走 PR）。写错 kind 的声明不会报错但也不会生效'
  }
  if (typeof m.grantedBy !== 'string' || m.grantedBy === '' || /\s/.test(m.grantedBy)) {
    return `指标 \`${metricName}\` 的 \`mask\` grantedBy ${JSON.stringify(m.grantedBy ?? null)} 形态不合规 —— `
      + '必须是非空、无空白的字符串。它是**逐字**比对的豁免权限码（持有 ⇒ 看原值），'
      + '带空白的码谁也匹配不上（症状：该掩码对**所有人**恒生效，且不报错）'
  }
  const column = m.column ?? null
  if (column !== null && (typeof column !== 'string' || column === '')) {
    return `指标 \`${metricName}\` 的 \`mask\` column ${JSON.stringify(column)} 形态不合规 —— `
      + '必须是「关系.列」形态的非空字符串。整值隐藏不是写 column: null——**给源列打 `sensitivity`**'
      + '（物化层自动合成整值 nullify 默认档，见 T5）；YAML 里**写不出**整值形态（`maskItemError` 一律拒）。'
  }
  if (column === null) {
    return `指标 \`${metricName}\` 的 \`mask\` 声明了整值掩码（column 缺席或为 null）—— `
      + '**手写整值声明一律拒**（spec §5.3.1 R10 配套 2）：整值形态是**指标级**的、'
      + '**不跨指标按列传播**，手写它等于重开 #820 同型洞。'
      + '该形态**只由默认档合成**（sync 的 applyDefaultMaskTier，不经本函数）。'
      + '想按列掩码请写出具体 column；想整值隐藏请给源列打 sensitivity。'
  }
  if (m.kind === 'round') {
    const step = m.step
    if (typeof step !== 'number' || !Number.isInteger(step) || step <= 0) {
      return `指标 \`${metricName}\` 的 \`mask\` 声明了 round 但 step ${JSON.stringify(step ?? null)} 不是正整数 —— `
        + '运行期会展开成 `round(<列>, -step)`，step 缺失/非整数会让掩码表达式到查询时才炸（静默面）'
    }
  }
  return null
}

/**
 * 声明的 `mask` → 掩码规格数组。**缺省 → `null`**（= 未声明）。**默认档在本层合成**
 * （`applyDefaultMaskTier`，读契约的 `sensitivity`）⇒ 运行期只消费物化好的 `masks`，
 * 不认识 `sensitivity`（运行期保持笨）；给了就逐项校验，坏形状**响亮失败**
 * （与 requiredScopeOf / slaDaysOf 同一脾气）。
 *
 * ⚠️ **`column` 必须逐字出现在该指标的 `selectSql` 里**——这条只在这里判、门禁判不了
 * （门禁手里没有物化后的 selectSql）：运行期展开是对 selectSql 做列引用定点替换，列不在里面
 * ⇒ 替换一个都命中不了 ⇒ **掩码静默不生效**，这正是本设计最怕的失败形态（坏在数据里，不报错）。
 * 判据**就是运行期那一份**（`sqlMentionsColumn`，#830），不再另写正则——同一件事两个尺
 * 正是本任务要堵的洞（PR #827 评审 M1 的两个反例）。
 * 新声明写不出整值形态（`maskItemError` 一律拒，spec §5.3.1 R10 配套 2）；整值形态只由
 * 物化层的默认档合成（见 T5）。
 *
 * ⚠️ 一处**更细的**拦点（issue #824 的 C-m3）：
 *   · **维度 / grain 列不许按列掩码**：运行期展开换掉的是该列在 selectSql 里的**全部**出现处
 *     （含 select 表里那一处维度列），而 GROUP BY 仍是原列名 ⇒ SQL 报「must appear in GROUP BY」。
 *     那是运行期才炸、离声明很远的一类，提前响亮拒绝。
 *
 * @param {unknown} v 声明里的 `mask` 原始值
 * @param {string} metricName 指标名（只用于错误信息）
 * @param {string} selectSql 该指标物化后的 select_sql（column 出现性的比对基准）
 * @param {readonly string[]} grain 该指标的可聚合维度（= group_by，维度列不许按列掩码）
 * @returns {MaskSpec[] | null} null = 未声明
 */
function masksOf(v, metricName, selectSql, grain) {
  if (v === undefined || v === null) return null
  if (!Array.isArray(v)) {
    throw new Error(
      `指标 \`${metricName}\` 的 \`mask\` ${JSON.stringify(v)} 不是数组 —— 掩码声明是数组 `
      + `（每项 {column, kind, step?, grantedBy}，如 [{"column":"fct_x.net_amount","kind":"round",`
      + `"step":1000,"grantedBy":"data:precise"}]）。写错形状的掩码会静默不生效，宁响亮勿静默`,
    )
  }
  /** @type {MaskSpec[]} */
  const out = []
  for (const raw of v) {
    const err = maskItemError(raw, metricName)
    if (err !== null) throw new Error(err)
    const m = /** @type {Record<string, unknown>} */ (raw)
    const column = m.column ?? null
    if (column !== null) {
      const bare = String(column).split('.').pop() ?? ''
      // ★ 维度 / grain 列不许按列掩码（C-m3，issue #824）：见函数头注——运行期会把它在
      //   selectSql 里的全部出现处（含维度表那一处）换掉，GROUP BY 却仍是原列名 ⇒ 运行期 SQL 报错。
      if (grain.includes(bare)) {
        throw new Error(
          `指标 \`${metricName}\` 的 \`mask\` column \`${String(column)}\` 是该指标的维度/grain 列 —— `
          + '维度列不能按列掩码：运行期展开会把 selectSql 里该列的**全部**出现处（含 select 表里'
          + '那一处维度列）换成掩码表达式，而 GROUP BY 仍是原列名 ⇒ SQL 报「must appear in '
          + 'GROUP BY」（运行期才炸，离声明很远）。要掩整个值 ⇒ **给源列打 `sensitivity`**'
          + '（物化层自动合成整值 nullify 默认档，见 T5）；要按列掩码请挑一个只出现在口径表达式里的列',
        )
      }
      // 比对基准由**运行期同一份实现**给（#830）：`sqlMentionsColumn` 的定义就是「跑一遍
      // maskedSelectSql、看 applied 里有没有这一列」⇒ 别名位跳过、词边界、`$&` 回调等语义
      // 全部自动继承。这里再写一份正则 = 第二个事实源（PR #827 评审 M1 实测的两个反例：
      // 哨兵名撞车 `column: '__alias__'`、大小写不匹配 `(select 1 AS VALUE) + sum(t.y)`）。
      if (!sqlMentionsColumn(selectSql, String(column))) {
        throw new Error(`指标 \`${metricName}\` 的 \`mask\` column \`${String(column)}\` 没有逐字出现在该指标的 selectSql 里 —— `
          + '运行期替换会命中不了 ⇒ **静默不生效**（本设计最怕的形态）。'
          + '判据与运行期同源：mask.ts 的 sqlMentionsColumn（#830）。')
      }
    }
    // step 只在 round 下有语义：nullify 物化时剥掉它，免得库里的声明带着一个没人读的键。
    // `column === null` 那个 disjunct 已删：`maskItemError` 先一步一律拒整值形态 ⇒ 这里不可达。
    out.push(m.kind === 'nullify'
      ? { column: /** @type {string | null} */ (column), kind: /** @type {MaskSpec['kind']} */ (m.kind), grantedBy: String(m.grantedBy) }
      : { column: /** @type {string | null} */ (column), kind: /** @type {MaskSpec['kind']} */ (m.kind), step: /** @type {number} */ (m.step), grantedBy: String(m.grantedBy) })
  }
  return out
}

/**
 * 从 L1 声明的 `expression` 反推 FROM 的关系名。
 *
 * ── 为什么要求表达式**带关系限定**（`fct_x.col`），而不是自己去猜表名 ──────────────────
 * `data.metrics.select_sql` 必须长成 `select <表达式> as value[, <维度>] from <关系>` 这一形状
 * （`domain/semantic-compiler.ts` 的 L1_SELECT_RE 是它的机器判据——L2 编译点要靠它把 base 拆开）。
 * 关系名是**形状的一部分**，而 dbt YAML 里没有任何字段写着它 ⇒ 只能从表达式取。
 * 取不到就**响亮失败**：猜一个关系名（例如拿 grain 里的列名当表名）会物化出一条语法错的
 * select_sql，而它要到「某个租户查这个指标」时才以 SQL 报错的面目暴露——那时已经离因很远。
 * ⚠️ 这是本脚本加给**将来 L1 声明**的一条硬约束：`expression` 必须引用至少一个
 * `关系.列`。当前两条声明（`sum(fct_retail_sale.net_amount)` / `sum(fct_retail_sale.order_count)`）
 * 都满足；将来若有人写 `count(*)`，这里会红——那时该做的是把关系显式写进声明，
 * 而不是放宽这条判定（放宽 = 允许物化出不知道自己读哪张表的词表）。
 *
 * @param {string} expression L1 声明的 expression 原文
 * @param {string} metricName 指标名（只用于错误信息）
 * @returns {string} 关系名（可带 schema，如 `dbt.fct_x`）
 */
export function deriveRelation(expression, metricName) {
  /** @type {Set<string>} */
  const relations = new Set()
  for (const m of expression.matchAll(QUALIFIED_REF_RE)) relations.add(m[1])
  if (relations.size === 0) {
    throw new Error(
      `指标 \`${metricName}\` 的 expression \`${expression}\` 里没有「关系.列」形态的引用，`
      + '取不到 FROM 的关系名 —— L1 的 select_sql 只能是 `select <表达式> as value[, <维度>] from <关系>` '
      + '这一形状，请把表达式的列写成 `<关系>.<列>`。',
    )
  }
  if (relations.size > 1) {
    throw new Error(
      `指标 \`${metricName}\` 的 expression 引用了多个关系（${[...relations].join(', ')}）：`
      + '单条 L1 声明的 select_sql 只有一个 FROM（跨模型聚合属于 marts 层的活，不是词表层能拼的）。',
    )
  }
  return [...relations][0]
}

/**
 * 组装 L1 的 `select_sql`（**形状契约**：与 semantic-compiler.ts 的 L1_SELECT_RE 同一条）。
 *
 * @param {string} expression 口径表达式（逐字保留——L2 靠「表达式原样在产物里」来保证不改口径）
 * @param {readonly string[]} grain 可聚合维度
 * @param {string} relation FROM 的关系名
 * @returns {string}
 */
export function buildSelectSql(expression, grain, relation) {
  const dims = grain.length > 0 ? `, ${grain.join(', ')}` : ''
  return `select ${expression} as value${dims} from ${relation}`
}

/**
 * 问数参数白名单（spec 2026-10-15 §2.2）：grain ∩ 白名单 = 该指标的问数参数面。
 * 判定原则：值域「模型或用户说得出」的维度才可作参数（bizday 日期人会说、system_book=3120/64188
 * 记得住、domain∈{transfer,wholesale} 记得住）；业务编码维度（branch_num/item_num/…）说了不出合法值，
 * 暴露即死参数——回流条件：设计「维度值解析」工具后再扩集。
 * 参数名 = 列名（与 group_by 同名，模型看到什么就能填什么）；required 恒缺省（空参=全量）。
 *
 * @type {Record<string, MetricParamDef>}
 */
const ASK_PARAM_WHITELIST = {
  bizday: { column: 'bizday', type: 'date_range' },
  system_book: { column: 'system_book', type: 'string' },
  domain: { column: 'domain', type: 'string' },
}

/**
 * grain ∩ 白名单 → 该指标的问数参数（参数名 = 列名；required 恒缺省）。
 *
 * @param {readonly string[]} grain 可聚合维度
 * @returns {Record<string, MetricParamDef>}
 */
export function deriveParams(/** @type {readonly string[]} */ grain) {
  return Object.fromEntries(
    // Object.hasOwn 而不是 `in`：`in` 会把原型链上的键也算命中（如 `toString`），
    // grain 若将来混入这类名字会物化出白名单外的参数——白名单就该只认自有键。
    grain.filter((/** @type {string} */ c) => Object.hasOwn(ASK_PARAM_WHITELIST, c))
      .map((/** @type {string} */ c) => /** @type {[string, MetricParamDef]} */ ([c, ASK_PARAM_WHITELIST[c]])),
  )
}

/**
 * 顶层 `measures:` → Map（键 `<snake>@<snake>`；形状由门禁把守，这里再兜一道：非空、无分号）。
 *
 * 为什么 sync 侧还要再兜一道：本脚本会被**手跑**（不经 CI），门禁拦不住手跑路径；
 * 而组件体是要拼进下钻 SQL 的——分号/空体这类垃圾形状落库 = 静默坏下钻。
 *
 * @param {Record<string, unknown> | null | undefined} parsed YAML 解析结果（顶层对象）
 * @returns {Map<string, string>} 组件键 → 组件体（首尾空白已剥；`measures:` 缺席 = 空 Map）
 */
export function measuresOf(parsed) {
  const raw = parsed?.measures
  if (raw === undefined || raw === null) return new Map()
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('`measures:` 必须是 `{ "组件名@粒度": 表达式 }` 映射')
  }
  const out = new Map()
  for (const [k, v] of Object.entries(raw)) {
    const body = typeof v === 'string' ? v.trim() : ''
    if (!/^[a-z_]+@[a-z_]+$/.test(k) || body === '' || body.includes(';')) {
      throw new Error(`\`measures.${k}\` 形态不合规 —— 键须 \`<snake>@<snake>\`，表达式须非空且不含分号`)
    }
    out.set(k, body)
  }
  return out
}

const MEASURE_REF_RE = /[A-Za-z_][A-Za-z0-9_]*@[a-z0-9_]+/g

/**
 * compose → drill_expr：组件引用替换为 `(<组件体>)`。封闭文法：只许组件引用与 `+ - ( )` 空白——
 * 乘除/数字/其它标识符一律响亮失败（不引入自由 SQL，全局约束 12；括号包裹保证替换后优先级不变）。
 *
 * 文法检查**先于**引用替换：先把记号问题挡掉，再谈引用解析——否则「未知引用 * 2」会只报引用，
 * 把文法漏洞藏在第二条错误后面。
 *
 * @param {unknown} raw 声明里的 `compose` 原值（undefined/null = 未声明）
 * @param {string} metricName 指标名（只用于错误信息）
 * @param {Map<string, string>} measures `measuresOf` 的产物（组件键 → 组件体）
 * @returns {string | null} null = 未声明 compose（聚合照旧，不下钻）
 */
export function composeOf(raw, metricName, measures) {
  if (raw === undefined || raw === null) return null
  const compose = String(raw)
  if (compose.trim() === '' || compose.includes(';')) {
    throw new Error(`指标 \`${metricName}\` 的 compose 必须是非空、不含分号的组件组合式`)
  }
  const stripped = compose.replace(MEASURE_REF_RE, ' ').replace(/[+\-()\s]/g, '')
  if (stripped !== '') {
    throw new Error(`指标 \`${metricName}\` 的 compose 含文法外记号「${stripped.slice(0, 20)}」 —— `
      + '只许组件引用与 + - ( ) 空白（不引入自由 SQL）；新算术请先落成组件')
  }
  return compose.replace(MEASURE_REF_RE, (ref) => {
    const body = measures.get(ref)
    if (body === undefined) {
      throw new Error(`指标 \`${metricName}\` 的 compose 引用了未声明的度量组件 \`${ref}\` —— 请在同文件顶层 \`measures:\` 声明`)
    }
    return `(${body})`
  })
}

/**
 * 可加判定（spec §8.4：total 自动伴随的物化依据）——**表达式形状的保守机械规则**。
 *
 * 两条判定，都取**保守**方向（漏给一个自动合计是小事；给比率编一个合计是错数）：
 *   ① `expression` 以 `sum(` 开头 ⇒ 可加 ⇒ true。可加指标的两种实文形态都覆盖：
 *      单聚合（`sum(fct_retail_sale.net_amount)`）与聚合之差（`sum(a) - sum(b)`，
 *      purchase:net_amount）。
 *   ② **含除法形状 ⇒ false**。sync 的 ratio 声明物化成 `sum(…) / nullif(sum(…), 0)`——
 *      ⚠️ 它**也以 `sum(` 开头**，只认前缀会把毛利率/填写率/满足率全判成可加（自动合计
 *      直接给出错数）。比率不可加（上滚 = 重算），一律不给自动合计。
 *      认「空格夹除号」而不是裸 `/`：`sum(a/b)`（行内比值再求和）是可加的，不该被误杀。
 *   ③ 去重计数（`count(distinct …)`）不以 `sum(` 开头，天然落 false——跨行求和
 *      = 供应商·天数，错（spec §8.4 明文）。
 *
 * @param {string} expression 物化后的口径表达式（ratio 声明已在此前包好 nullif）
 * @returns {boolean}
 */
export function deriveTotalable(expression, additivity = 'flow') {
  if (additivity !== 'flow') return false
  return /^\s*sum\s*\(/i.test(expression) && !/\s\/\s/.test(expression)
}

/**
 * 口径射程与排除项（消费面 spec 2026-10-17 §12.6）：缺省空串 = 未声明（响应不带该行）。
 *
 * 为什么空白必须响亮失败：它会被**原样**钉进对外答案末尾——空串会让平台附一条空行（噪音），
 * 而「声明了但没生效」正是本仓反复吃的静默形态。L2 租户行不开放该概念（写侧恒 ''）。
 *
 * @param {unknown} raw 声明里的 `scope_note` 原值
 * @param {string} name 指标名（只用于错误信息）
 * @returns {string}
 */
export function scopeNoteOf(raw, name) {
  if (raw === undefined || raw === null) return ''
  const v = String(raw).trim()
  if (v === '') {
    throw new Error(
      `指标 \`${name}\` 的 \`scope_note\` 为空/纯空白 —— 它会被原样钉进对外答案的末尾`
      + '（消费面 spec 2026-10-17 §12.6）；没内容就别声明（省略 = 未声明射程）。',
    )
  }
  return v
}

/** 可加性分类的闭集（消费面 spec 2026-10-17 §12.3）。 */
export const ADDITIVITY_VALUES = ['flow', 'stock', 'non_additive']

/**
 * 可加性分类（消费面 spec 2026-10-17 §12.3）：缺省 `flow`；未知值**响亮失败**。
 *
 * 为什么不能只靠形状推导：`deriveTotalable` 只看「expression 以 sum( 开头」，而**存量**指标
 * （库存/应收应付/余额）的 expression 也是 `sum(列)`——形状可加、**语义不可加**（跨时间求和无业务含义）。
 * 线上实证：`lemeng:inventory:quantity` / `:money` 曾被标成可加 ⇒ 问「近 7 天库存合计」= 7 天快照相加。
 *
 * @param {unknown} raw 声明里的 `additivity` 原值（缺省 / null ⇒ flow）
 * @param {string} name 指标名（只用于错误信息）
 * @returns {string} flow | stock | non_additive
 */
export function additivityOf(raw, name) {
  if (raw === undefined || raw === null) return 'flow'
  const v = String(raw)
  if (!ADDITIVITY_VALUES.includes(v)) {
    throw new Error(
      `指标 \`${name}\` 的 \`additivity\` ${JSON.stringify(raw)} 不在 ${ADDITIVITY_VALUES.join('|')}`
      + '（spec 2026-10-17 §12.3）—— 它决定能不能跨时间求合计；拼错会让存量指标静默按可加处理，'
      + '问数会把日快照相加（线上已实证）。',
    )
  }
  return v
}

/**
 * 语义事实源 YAML → L1 行（`MetricDef` 形状；org / source 由写入口钉死，不在这里）。
 *
 * 字段映射（为什么这么映，逐条）：
 *   `name`        → `id`（词表主键；L2 的 `baseMetric` 引的就是它）
 *   `label`       → `title`（人读名；缺省回落到 name，别让 title 为空串——管理面靠它认指标）
 *   `definition`  → `description`（口径的逐字定义，进词表给人与 agent 看）
 *   `expression`  → 值表达式（进 select_sql）
 *   `grain`       → GROUP BY 维度（**同时**是 L2 的可见维度白名单与过滤维度全集）
 *   `required_scope` → `requiredScope`：**缺省 = null**（所有拿到本模块的人可见，与 2026-10-17
 *                     之前的恒 null 行为一致）；声明了就要非空、无空白（见 `requiredScopeOf`）。
 *                     列级/值级授权的声明面，spec `2026-10-17-column-and-value-level-security-design.md` §4.2。
 *                     `tier` **不**映射成 requiredScope——spec §10 明写 tier 是**标记不是强制**
 *                     （「本仓不靠它挡谁，靠它让人一眼看见成熟度」），拿它当权限会凭空造出一条
 *                     谁也说不清的授权规则。
 *   `source`      → `sourceSystem`（库列 `source_system`）：**源系统**（如 `lemeng`），
 *                     spec §3⑧ 的源维度。⚠️ 与同一份声明里的 `sources`（对象存储路径，人读）
 *                     **不是一回事**；也与库里的 `source`（取值 l1/l2 = 谁写的）不是一回事。
 *   `compose` / `dimensions` / `detail` → 下钻三键 `drillExpr` / `drillDims` / `drillDetail`
 *                     （下钻 spec 2026-10-21 §2.3；compose 经 `composeOf` 编译——组件引用替换为
 *                     括号包裹的组件体。缺省三键全 null = 未声明下钻；顶层 `measures:` 是组件体
 *                     的事实源，由 `measuresOf` 解析）。
 *   `owner` / `tier` / `sources` → **不落库**（`data.metrics` 没有对应列）。它们仍是治理面的
 *                     事实源（在 YAML 里、被静态门禁规则 ⑤ 强制必填），只是不在这张表上体现。
 *                     ⚠️ 这是本任务的一处**已知边界**，见 README「L2 的已知边界」。
 *
 * @param {unknown} parsed YAML 解析结果
 * @returns {(ComparableMetric & { slaDays: number, freshnessRelations: string[] })[]}
 *          声明侧推导出的行**保证**两个新鲜度字段非 null（slaDaysOf/deriveFreshnessRelations
 *          已响亮拦掉缺/坏形状）——写库入口（L1MetricDef）要的非空类型由这里兑现；
 *          可空的 ComparableMetric 形状留给 --check 的库侧比对（存量旧行）。
 */
export function declarationsFromYaml(parsed) {
  if (parsed === null || typeof parsed !== 'object') throw new Error(`${L1_DECLARATIONS_REL} 的顶层不是对象`)
  const metrics = /** @type {Record<string, unknown>} */ (parsed).metrics
  if (!Array.isArray(metrics)) throw new Error(`${L1_DECLARATIONS_REL} 缺少 metrics 数组`)
  // 顶层 `measures:`（下钻 spec §2.3）：组件键 → 组件体。compose 的引用解析全靠它；
  // 形状坏/引用悬空在这里响亮失败（发生在任何写库之前，--check 模式同样拦）。
  const measures = measuresOf(/** @type {Record<string, unknown>} */ (parsed))

  return metrics.map((raw) => {
    const m = /** @type {Record<string, unknown>} */ (raw)
    const name = String(m.name ?? '')
    if (!METRIC_NAME_RE.test(name)) {
      throw new Error(`指标名 \`${name}\` 不合命名空间形态 \`<源>:<业务域>:<指标>\`（小写蛇形，三段）`)
    }
    // ── expression 与 ratio 二选一（spec 2026-10-12 §5.3 率类声明）────────────────────
    // 率类（毛利率/占比/退货率…）不可加：声明侧用 `ratio: {numerator, denominator}`，
    // 分母在这里统一包 `nullif(…, 0)`（零分母 → 不适用，不产 0）——「零分母怎么算」是口径的
    // 一部分，由声明通道一次定死，不许各指标自己发挥。两处都给 = 两处事实源，拒绝。
    const expressionField = String(m.expression ?? '')
    const hasRatio = m.ratio !== undefined && m.ratio !== null
    if (hasRatio && expressionField !== '') {
      throw new Error(`指标 \`${name}\` 的 ratio 与 expression 互斥：率类声明用 ratio（分母自动包 nullif），可加指标用 expression，不许两处各写一份`)
    }
    let expression = expressionField
    if (hasRatio) {
      const r = /** @type {Record<string, unknown>} */ (m.ratio)
      const numerator = String(r.numerator ?? '')
      const denominator = String(r.denominator ?? '')
      if (numerator === '') throw new Error(`指标 \`${name}\` 的 ratio 缺 numerator（分子）`)
      if (denominator === '') throw new Error(`指标 \`${name}\` 的 ratio 缺 denominator（分母）`)
      // 写侧先拦注入；读侧 parseL1Select 的形状契约仍在（两层防线，同文件头注的两侧同源约定）
      if (numerator.includes(';') || denominator.includes(';')) {
        throw new Error(`指标 \`${name}\` 的 ratio 含分号：声明里只写聚合表达式，不许拼语句`)
      }
      expression = `${numerator} / nullif(${denominator}, 0)`
    }
    if (expression === '') throw new Error(`指标 \`${name}\` 缺 expression（率类请改用 ratio: {numerator, denominator}）`)
    if (!Array.isArray(m.grain) || m.grain.length === 0) {
      throw new Error(`指标 \`${name}\` 的 grain 必须是非空数组（grain 同时是 L2 的维度白名单来源）`)
    }
    // 源系统（源维度）**必填**——缺了就响亮失败，绝不落一个「看起来有值、实际是垃圾」的源。
    // 为什么不能只靠 `String(m.source)` 的默认行为：缺字段时它产出**字符串** `'undefined'`，
    // 于是行照样落库、sync 照样报成功，而消费侧的裁剪会拿这个值与「已接入源」比对 ⇒ 该指标
    // 对**所有**租户静默不可见（没有任何租户接过名为 `undefined` 的源）——坏在数据里，不报错。
    // ⚠️ 声明面的必填由门禁规则 ⑤ 把守（唯一事实源 = 仓内 YAML）**且**这里再拦一道：
    //    本脚本会被手跑（不经 CI），事实源的位置将来也可能变——门禁是权威，这条是兜底。
    //
    // ⚠️ 第二个坑是**首尾空白**（同一类静默失效，只是触发条件收窄）：`' lemeng '` 这种值在门禁侧
    //    是合法声明（`asText` 先 trim 再判，故门禁校验的其实是 `lemeng`），若原样落库，库里的值
    //    就与「已接入源」的登记值**逐字比对不上** ⇒ 同样静默不可见。这里选择**拒绝**而不是 trim：
    //    本脚本的脾气是「取不到/说不准就响亮失败」，静默 trim 等于替作者改他的声明，而「声明写了
    //    什么」与「库里存了什么」必须是同一个值。代价：本脚本对空白比门禁**更严**——方向是安全的
    //    （响亮失败，不是坏值落库），且真事实源（`dbt/semantics/l1_metrics.yml`）本来就不带空白。
    const sourceSystem = String(m.source ?? '')
    if (sourceSystem.trim() === '') {
      throw new Error(
        `指标 \`${name}\` 缺 \`source\`（源系统，如 \`lemeng\`；全为空白也算缺）—— 它会被物化成 `
        + '`data.metrics.source_system` 并被消费侧拿去与「已接入源」比对，缺了它指标就查不出来了'
        + '（静默，不是报错）。请在声明里补 `source`（形状：小写蛇形）。',
      )
    }
    if (sourceSystem !== sourceSystem.trim()) {
      throw new Error(
        `指标 \`${name}\` 的 \`source\` ${JSON.stringify(sourceSystem)} 首尾带空白 —— 它要与`
        + '「已接入源」的登记值**逐字**比对，带空白的值匹配不上（症状：该指标对所有人都查不出来，'
        + `且不报错）。请把它写成 \`${sourceSystem.trim()}\`（本脚本不替声明做 trim）。`,
      )
    }
    const grain = m.grain.map((/** @type {unknown} */ g) => String(g))
    const relation = deriveRelation(expression, name)
    // selectSql 先落一个变量：masksOf 的「column 须逐字在 selectSql 里」要拿它做比对基准
    // （先校验后物化——坏声明的失败发生在**任何写库之前**，--check 模式同样拦）。
    const selectSql = buildSelectSql(expression, grain, relation)
    // 新鲜度链路（spec §10.7）：sla_days 必填显式登记（缺/坏形状响亮失败，见 slaDaysOf）；
    // 关系集从 sources 路径段机械推导（未声明 sources = 空数组 = 无自动水位，字段缺席）。
    const slaDays = slaDaysOf(m.freshness_sla_days, name)
    const freshnessRelations = deriveFreshnessRelations(
      Array.isArray(m.sources) ? m.sources.map((/** @type {unknown} */ s) => String(s)) : undefined)
    return {
      id: name,
      title: String(m.label ?? name),
      description: String(m.definition ?? ''),
      requiredScope: requiredScopeOf(m.required_scope, name),
      subjectColumn: L1_SUBJECT_COLUMN,
      selectSql,
      groupBy: grain.join(', '),
      // 问数参数面：grain ∩ 白名单（spec 2026-10-15 §2.2）。L2 仍不开放参数面——
      // L2 是治理性持久切片，问数是会话内过滤，重量错配（spec §5 的边界声明，改前先回 spec）。
      params: deriveParams(grain),
      // 源系统（源维度）：上面已拦掉缺字段的情形，故这里的取值恒是非空串。
      sourceSystem,
      // 可加标记（spec §8.4；2026-10-17 §12.3 起**先看声明的 additivity**）：ratio 在上面已包成
      // `… / nullif(…, 0)`，deriveTotalable 的除法排除正好接住它；`stock`/`non_additive` 直接 false。
      totalable: deriveTotalable(expression, additivityOf(m.additivity, name)),
      // 口径射程与排除项（消费面 spec 2026-10-17 §12.6）：缺省空串 = 未声明（响应不带该行）。
      scopeNote: scopeNoteOf(m.scope_note, name),
      slaDays,
      freshnessRelations,
      // 值级掩码声明（spec 2026-10-17 §5.2）：缺省 null（未声明）；给了就逐项校验
      // （含「column 须逐字在 selectSql 里」——静默不生效形态的唯一拦点，见 masksOf）。
      masks: masksOf(m.mask, name, selectSql, grain),
      // 下钻绑定（spec 2026-10-21 §2.3）：缺省三字段全 null（未声明）。门禁已拦「半套」，
      // 这里对 dimensions/detail 再各兜一道形状（sync 会被手跑，不经 CI）。
      drillExpr: composeOf(m.compose, name, measures),
      drillDims: m.dimensions === undefined ? null
        : (Array.isArray(m.dimensions) && m.dimensions.length > 0
          && m.dimensions.every((/** @type {unknown} */ d) => typeof d === 'string' && /^[a-z_][a-z0-9_]*$/.test(d))
          ? m.dimensions.map(String) : null),
      drillDetail: m.detail === undefined ? null
        : (typeof m.detail === 'object' && m.detail !== null
          && typeof /** @type {any} */ (m.detail).relation === 'string'
          && typeof /** @type {any} */ (m.detail).filter === 'string'
          ? { relation: /** @type {any} */ (m.detail).relation, filter: /** @type {any} */ (m.detail).filter }
          : null),
      // `reads` 上载进行对象：默认档要读它（`applyDefaultMaskTier`）。
      // ⚠️ 它**不在** `comparableOf` 的 16 元组里 ⇒ 加它**不会**让 `--check` 凭空报漂移；
      //    但 `reads` 的改动**仍可被 `--check` 检出**——经由它对**合成 masks**（第 13 元）的影响。
      // ⚠️ 也**不会**影响写库：`upsertL1Metric` 的列清单来自 `ROW_COLUMNS` 白名单，多出的键被忽略。
      reads: Array.isArray(m.reads) ? m.reads.map(String) : null,
    }
  })
}

/**
 * 内容比对用的一行摘要（**只比**决定「要不要写」的字段；created_at/updated_at 不参与）。
 *
 * `sourceSystem` 必须在场：否则「改了声明的 source、库里没跟上」会被判成「未变」——
 * 而 `--check` 只认这个判据，于是门禁假绿（见上面 ComparableMetric 的说明）。
 * `totalable` 同理（spec §8.4）：加列后的首次比对 = 可加指标全部判「更新」（预期漂移）；
 * 不进比对的话，声明推导变了而库里没刷的情况会被永久判「未变」。
 * `slaDays` / `freshnessRelations` 第三组同理（spec §10.7）：SLA 登记与关系集推导变了
 * 而库内没刷，水位/固定行会永远按旧链路算——必须被 --check 检出。
 * `masks` 第四组同理（spec 2026-10-17 §5.2）：掩码声明变了而库内没刷 = 掩码静默按旧声明生效
 * （安全面，宁可不生效也不能背着旧声明生效）——必须被 --check 检出。
 * 下钻三键 第六组（下钻 spec 2026-10-21 §2.3）：下钻声明漂了而库内没刷 = 下钻面静默按旧声明跑，
 * 必须被 --check 检出。
 */
/**
 * 递归规范化：对象**键按字典序排序**，数组保序（顺序是语义的一部分）。
 *
 * 为什么要：`params` 这类 jsonb 字段经 PG 读回时**键序会被重排**（PG 的 jsonb 按
 * （长度, 字节序）存键），而声明侧是对象字面量的书写序 ⇒ 直接 `JSON.stringify` 两边恒不等，
 * `--check` 对已物化库**恒判「更新」**（#700 现场：写完再 check 也回不到无漂移，恒报「更新 27」）。
 * 后果不是多写几次，而是**漂移信号退化成狼来了**——真漂移来了也没人信。
 *
 * @param {unknown} v
 * @returns {unknown}
 */
const canonical = (v) => {
  if (Array.isArray(v)) return v.map(canonical)
  if (v !== null && typeof v === 'object') {
    const o = /** @type {Record<string, unknown>} */ (v)
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, canonical(o[k])]))
  }
  return v
}

const comparableOf = (/** @type {ComparableMetric} */ row) => JSON.stringify(canonical([
  row.title, row.description, row.requiredScope, row.subjectColumn, row.selectSql, row.groupBy, row.params,
  row.sourceSystem,
  row.totalable,
  row.scopeNote,
  row.slaDays,
  row.freshnessRelations,
  row.masks,
  row.drillExpr,
  row.drillDims,
  row.drillDetail,
]))

/**
 * 声明行的下钻三键 → `upsertL1Metric` 入参的 `drill`（def 组装面；下钻 spec 2026-10-21 §2.3）。
 *
 * 为什么这层单独存在：行级三键是 **--check 比对面**的形状——恒在场，null = 未声明；
 * 而 `L1MetricDef.drill` 是**可选** `DrillBinding`——字段**缺省**才是「未声明」的合法态
 * （写侧 `== null` 收口）。两层各守各的口径，这层做翻译：未声明 ⇒ undefined（调用方省略
 * drill 字段，不传字面 null）；「半套」（任一为 null 而另两个非 null）⇒ 响亮失败——
 * 门禁的同现判据是 CI 权威，这里兜的是手跑路径（本脚本不经 CI）。
 *
 * @param {ComparableMetric} row declarationsFromYaml 的声明行
 * @returns {DrillBinding | undefined} 未声明 = undefined（drill 字段缺省）
 */
export function drillOf(row) {
  const expr = row.drillExpr ?? null
  const dims = row.drillDims ?? null
  const detail = row.drillDetail ?? null
  if (expr === null && dims === null && detail === null) return undefined
  if (expr === null || dims === null || detail === null) {
    throw new Error('下钻三键必须同现（门禁同款判据，这里兜手跑）')
  }
  return { expr, dims, relation: detail.relation, filter: detail.filter }
}

/**
 * 库行 → 比对行的下钻三键（--check 库侧的形状翻译；下钻 spec 2026-10-21 §2.3）。
 *
 * 为什么必须翻译：`loadPlatformCatalog` 回的 `MetricRow` 把三列归一成 `drill?: DrillBinding`
 * （读侧 fail-closed：任一列缺/坏 ⇒ undefined = 未声明），而比对面（ComparableMetric）用
 * 三键恒在场形状（null = 未声明）。不翻译 ⇒ 库侧三键恒 undefined ⇒ 声明了下钻的指标与库
 * **恒不等** ⇒ --check 恒红（#700 同款「狼来了」形态，漂移信号作废）。声明侧与库侧都以
 * 同一份三键进 `comparableOf`。
 *
 * @param {{ drill?: DrillBinding | null }} row 库行（MetricRow；只读它的 drill）
 * @returns {{ drillExpr: string | null, drillDims: string[] | null, drillDetail: { relation: string, filter: string } | null }}
 */
export function drillTripleOf(row) {
  const d = row.drill
  if (d === undefined || d === null) {
    return { drillExpr: null, drillDims: null, drillDetail: null }
  }
  return {
    drillExpr: d.expr,
    drillDims: [...d.dims],
    drillDetail: { relation: d.relation, filter: d.filter },
  }
}

/**
 * 计算「声明集 ↔ 已物化集」的差集（新增 / 更新 / 删除 / 未变）。
 *
 * @param {readonly ComparableMetric[]} declared 本轮声明
 * @param {readonly ComparableMetric[]} current 库里现有的 L1 行
 * @returns {{ added: string[], updated: string[], removed: string[], unchanged: string[] }}
 */
export function diffDeclarations(declared, current) {
  const currentById = new Map(current.map((r) => [r.id, r]))
  /** @type {string[]} */ const added = []
  /** @type {string[]} */ const updated = []
  /** @type {string[]} */ const unchanged = []
  for (const d of declared) {
    const c = currentById.get(d.id)
    if (c === undefined) added.push(d.id)
    else if (comparableOf(c) === comparableOf(d)) unchanged.push(d.id)
    else updated.push(d.id)
  }
  const declaredIds = new Set(declared.map((d) => d.id))
  const removed = current.filter((r) => !declaredIds.has(r.id)).map((r) => r.id)
  return { added, updated, removed, unchanged }
}

// ── 命令行面 ────────────────────────────────────────────────────────────────────
// 出口码三分法（0 成功 / 1 漂移或运行失败 / 2 用法错），与仓内其它 CLI 的「非 0 但含义不同」一致。

/** 成功（含「--check 无漂移」「--dry-run 有漂移」——那两种模式下 0 不代表「库已对齐」）。 */
export const EXIT_OK = 0
/** `--check` 检出漂移；运行期失败（YAML 坏 / 缺 DATABASE_URL / 写库报错）也用这个。 */
export const EXIT_DRIFT = 1
/** 参数用法错：未知 flag 或模式互斥。**与漂移区分**，否则 T9 的门禁会把用法错读成漂移。 */
export const EXIT_USAGE = 2

export const MODE_WRITE = 'write'
export const MODE_DRY_RUN = 'dry-run'
export const MODE_CHECK = 'check'
export const MODE_HELP = 'help'

/**
 * 支持的 flag 与它们的语义——**唯一事实源**：`parseArgs`、`--help` 文案与用法错提示
 * 都从这里生成，三处不会各说各话。每条都显式写明「会不会写库」：本脚本最危险的失败形态
 * 就是「以为在检查、实际在写」。
 */
export const FLAG_HELP = [
  { flag: '--check', help: '读库比对并打印差集，**不写库**；有漂移 exit 1 / 无漂移 exit 0（门禁）' },
  { flag: '--dry-run', help: '读库比对并打印差集，**不写库**；exit 恒 0（不是门禁，只给人看）' },
  { flag: '--help, -h', help: '打印本说明，**不写库**；exit 0' },
]

/**
 * 解析 argv → 模式 + 未识别项。**纯函数**（单测面，不需要数据库）。
 *
 * 返回**单形状、字段恒在**的对象（不写可辨识联合）：`scripts/` 是 checkJs 工程，
 * JSDoc 里的字面量联合会被加宽、窄化随之失效——那正是本仓已经踩过的一类假绿。
 *
 * @param {readonly string[]} argv 不含 node 与脚本路径的参数
 * @returns {{ mode: string, modes: string[], unknown: string[] }}
 *   `mode` 是最终生效的模式（不给模式 ⇒ `write`）；`modes` 保留原序（用于「互斥」判定）；
 *   `unknown` 是未识别的参数。
 */
export function parseArgs(argv) {
  /** @type {string[]} */ const unknown = []
  /** @type {string[]} */ const modes = []
  for (const arg of argv) {
    if (arg === '--check') modes.push(MODE_CHECK)
    else if (arg === '--dry-run') modes.push(MODE_DRY_RUN)
    else if (arg === '--help' || arg === '-h') modes.push(MODE_HELP)
    else unknown.push(arg)
  }
  let mode = MODE_WRITE
  // --help 优先于其它模式（`--check --help` 是「我要看说明」，不是「我要检查」）
  if (modes.includes(MODE_HELP)) mode = MODE_HELP
  else if (modes.length > 0) mode = modes[0]
  return { mode, modes, unknown }
}

/**
 * 参数用法错 → 一条可读的错误（没错则 null）。
 *
 * ★ 未知 flag **必须**是错（不是「忽略」）：忽略会让 `--check` 的调用方以为跑的是 dry-run，
 *   实际发生的是写库 + exit 0。同理模式互斥也要响亮——静默取第一个会让
 *   `--check --dry-run` 的语义取决于参数顺序（不可预测）。
 *
 * @param {{ mode: string, modes: string[], unknown: string[] }} args
 * @returns {string | null}
 */
export function usageError(args) {
  const supported = `支持的参数：\n${FLAG_HELP.map((f) => `  ${f.flag.padEnd(10)} ${f.help}`).join('\n')}`
  if (args.unknown.length > 0) {
    return `未知参数 ${args.unknown.join(' ')} —— 本脚本不忽略未识别 flag`
      + `（静默忽略会让 \`--check\` 退化成「直接写库」）。\n${supported}`
  }
  // 互斥只判**非 help** 的模式：`--help` 的语义是「把说明给我」，不是「跑哪个模式」——
  // 把 `--check --help` 判成互斥，就与 parseArgs 的「help 优先」自相矛盾
  // （改前实测：parseArgs 说 help、usageError 说互斥 ⇒ 同一份 argv 两个结论）。
  const effective = args.modes.filter((m) => m !== MODE_HELP)
  if (effective.length > 1) {
    return `模式互斥：${effective.join(' + ')} —— 一次只能给一个模式。\n${supported}`
  }
  return null
}

/** `--help` 的正文（与头注同源：都从 `FLAG_HELP` 生成）。 */
export function usageText() {
  return [
    `用法：DATABASE_URL=postgres://… pnpm exec tsx scripts/${SCRIPT_NAME}.mjs [模式]`,
    '      不给模式 = **写库**（把 org=platform 的 L1 行对齐到仓内 dbt 声明）。',
    '',
    FLAG_HELP.map((f) => `  ${f.flag.padEnd(10)} ${f.help}`).join('\n'),
    '',
    '退出码：0 成功 / 1 --check 检出漂移或运行失败 / 2 参数用法错（未知参数、模式互斥）',
  ].join('\n')
}

/**
 * 差集 → 可读文本（**`--check` 与 `--dry-run` 共用同一个打印器**）。
 *
 * 为什么两处必须同源：T9 的门禁要消费 `--check`，而人读的是 `--dry-run`——
 * 两处各写一份格式化，症状是「门禁说漂移、人照着 dry-run 的输出找不到是哪条」。
 *
 * @param {{ added: string[], updated: string[], removed: string[], unchanged: string[] }} diff
 * @returns {string[]} 首行是计数摘要，其后每行一条漂移（`+` 新增 / `~` 更新 / `-` 删除）
 */
export function formatDiff(diff) {
  const lines = [
    `新增 ${diff.added.length} / 更新 ${diff.updated.length}`
    + ` / 删除 ${diff.removed.length} / 未变 ${diff.unchanged.length}`,
  ]
  for (const id of diff.added) lines.push(`  + ${id}`)
  for (const id of diff.updated) lines.push(`  ~ ${id}`)
  for (const id of diff.removed) lines.push(`  - ${id}`)
  return lines
}

/**
 * 模式 + 差集 → 出口码。**纯函数**（单测面）：把「会不会非 0」从 main 里提出来，
 * 免得它和「有没有写库」一起埋在 I/O 里没法单测。
 *
 * @param {string} mode
 * @param {{ added: string[], updated: string[], removed: string[], unchanged: string[] }} diff
 * @returns {number}
 */
export function exitCodeFor(mode, diff) {
  if (mode !== MODE_CHECK) return EXIT_OK
  const drift = diff.added.length + diff.updated.length + diff.removed.length
  return drift > 0 ? EXIT_DRIFT : EXIT_OK
}

/**
 * 默认档（spec §4.1.1 裁决：**严档 `nullify`**）——「本指标一条列键声明都没命中，
 * 且本指标的 `reads` 申报里含 `sensitivity !== 'none'` 的源列」⇒ 合成一条**整值**掩码。
 *
 * ★ 为什么是**整值**（`column: null`）而不是按列：`reads` 是**湖契约列全名**
 *   （`lemeng.retail_order_line.sale_money`），`selectSql` 引用的是 **mart 列**
 *   （`fct_retail_sale.net_amount`）——**不同命名空间、无机械映射**。仓规**明文禁止**
 *   「按名字在 expression 里模糊匹配」的启发式（check-column-scope-monotonicity.mjs:27-28：
 *   会造假阳性、让真违规淹没）。⇒ 只能整值。
 *   ⚠️ 后果：整值是**指标级**的 ⇒ **不按列传播 ⇒ L2 不继承**（spec §7 R12）。
 *
 * ★ 为什么在这里（`readDeclarations`）而不是 `declarationsFromYaml`：
 *   `declarationsFromYaml` 是**纯**函数、被约 20 处内联夹具测试调用；
 *   `readDeclarations` 才持有 `rootDir`（要读 `contracts/**`）。默认档必须**只在真仓路径**生效，
 *   否则那些夹具测试会全变。
 *
 * @param {any[]} rows
 * @param {Map<string, string>} sensitivity
 * @returns {any[]}
 */
export function applyDefaultMaskTier(rows, sensitivity) {
  // 「列键声明」= 全仓所有 metric 行里 column 非 null 的声明（按列解析口径，spec §5.3.1 R10）
  const declared = new Set()
  for (const r of rows) for (const spec of r.masks ?? []) if (spec.column !== null) declared.add(spec.column)

  return rows.map((r) => {
    // 显式标类型：本仓 `scripts/` 是 checkJs（noImplicitAny）——`rows` 是 any[]，不标则回调参数
    // `c` 落成隐式 any（tsc TS7006）。
    const reads = /** @type {string[]} */ (r.reads ?? [])
    if (!reads.some((c) => (sensitivity.get(c) ?? 'none') !== 'none')) return r   // 没读敏感列 ⇒ 不套
    // ① 命中：本次 selectSql 里有任一被声明的列 ⇒ 默认档不叠加（spec §5.2 ① 优先于 ②）
    if ([...declared].some((col) => sqlMentionsColumn(r.selectSql, col))) return r
    return { ...r, masks: [...(r.masks ?? []), { column: null, kind: 'nullify', grantedBy: DEFAULT_TIER_SCOPE }] }
  })
}

/**
 * 读仓内的 L1 声明（唯一事实源）。
 *
 * @param {string} rootDir 仓库根
 * @returns {ReturnType<typeof declarationsFromYaml>}
 */
export function readDeclarations(rootDir) {
  const file = path.join(rootDir, L1_DECLARATIONS_REL)
  const parsed = parseYaml(readFileSync(file, 'utf8'))
  return applyDefaultMaskTier(declarationsFromYaml(parsed), loadSensitivity(rootDir))
}

/** 拿一个 pg 客户端：scripts/ 不在 workspace 包里，pg 只装在依赖它的包下（与 reconcile-data-tenants 同法）。 */
function poolFromEnv() {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('缺 DATABASE_URL（本脚本要写库；取法见仓库 README 的「常用命令」，值不进仓库）')
  }
  const requireFromModule = createRequire(new URL('../modules/data/package.json', import.meta.url))
  const { Pool } = requireFromModule('pg')
  return new Pool({ connectionString: url })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  // ★ 参数校验**必须最靠前**：未知 flag 若晚于读库/写库被处理，「--check 打成了 --chekc」
  //   这类手误就已经把库改了——错误提示再清楚也没意义。
  const usage = usageError(args)
  if (usage !== null) {
    console.error(`${SCRIPT_NAME}: ${usage}`)
    process.exitCode = EXIT_USAGE
    return
  }
  if (args.mode === MODE_HELP) {
    console.log(usageText())
    return
  }

  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

  const declared = readDeclarations(rootDir)
  const pool = poolFromEnv()
  try {
    // 库行 → 比对行：MetricRow 的下钻是归一后的 `drill?`（读侧 fail-closed），比对面用的是
    // 三键恒在场形状（null = 未声明）——不翻译，声明了下钻的指标与库恒不等 ⇒ --check 恒红。
    const current = (await loadPlatformCatalog(pool)).map((r) => ({ ...r, ...drillTripleOf(r) }))
    const diff = diffDeclarations(declared, current)

    // 两种**不写库**的模式共用同一个 diff 打印器（T9 的门禁与人读的输出必须同源）
    if (args.mode !== MODE_WRITE) {
      const lines = formatDiff(diff)
      console.log(`${SCRIPT_NAME}: ${args.mode} —— ${lines[0]}`)
      for (const line of lines.slice(1)) console.log(line)
      const code = exitCodeFor(args.mode, diff)
      if (args.mode === MODE_CHECK) {
        // 把「为什么非 0」写在 stdout 末行：人读日志时不必回头查退出码表的含义
        console.log(`${SCRIPT_NAME}: check ${code === EXIT_OK
          ? '无漂移（库内 L1 行与仓内声明一致）'
          : `检出漂移（exit ${code}）—— 库内 L1 行与仓内声明不一致`}`)
      }
      process.exitCode = code
      return
    }

    // def 组装**先行于任何写库**：半套下钻声明在第一条 upsert 之前就响亮失败（不做半套物化）。
    const defs = declared.map((row) => {
      const drill = drillOf(row)
      // 未声明下钻 ⇒ 省略 drill 字段（undefined），不传字面 null——`L1MetricDef.drill` 是
      // 可选字段，「缺省」才是「未声明」的合法态（写侧 `== null` 收口）。
      return drill === undefined ? row : { ...row, drill }
    })
    for (const d of defs) await upsertL1Metric(pool, d)
    // 删除侧：仓内声明里已经不存在的 L1 行（双向差集；作用域被 deleteStaleL1Metrics 钉在
    // org='platform' and source='l1'，碰不到任何租户的 L2 行）
    await deleteStaleL1Metrics(pool, declared.map((d) => d.id))

    // 回读一次，把「真的写进去了」当作验收面（不拿「函数没抛错」当成功）
    const after = await loadPlatformCatalog(pool)
    console.log(
      `${SCRIPT_NAME}: 物化 ${declared.length} 条 L1 声明（org=${L1_ORG} / source=l1）`
      + ` —— 新增 ${diff.added.length} / 更新 ${diff.updated.length}`
      + ` / 删除 ${diff.removed.length} / 未变 ${diff.unchanged.length}`
      + `；回读 ${after.length} 条`,
    )
  } finally {
    await pool.end()
  }
}

// 只在作为脚本直接运行时执行 main（被测试 import 时不执行——本文件导出的纯函数可单测）
if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main().catch((/** @type {unknown} */ e) => {
    console.error(`${SCRIPT_NAME}: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  })
}
