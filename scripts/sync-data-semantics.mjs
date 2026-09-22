#!/usr/bin/env node
// sync-data-semantics.mjs — **L1 语义声明 → data.metrics 的唯一物化通道**（issue #150 / 计划 Task 8）。
//
// 用法：DATABASE_URL=postgres://… pnpm exec tsx scripts/sync-data-semantics.mjs [--dry-run]
// 契约：成功 → exit 0，stdout 一行 `sync-data-semantics: …`；失败（YAML 坏 / 形状不合契约 /
//       缺 DATABASE_URL）→ exit 1，stderr 一条可解释的错误。**不是门禁**（不判别人的对错），
//       故不套 check-* 的「OK（计数）」格式。
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
// T4 已把 L1 声明落在 `dbt/semantics/l1_metrics.yml`——理由是指标名是 `<域>:<指标名>` 形态
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

// 类型引用走 JSDoc 的 `import(...)`（`.mjs` 里不能写 `import type` —— TS8006）。写成类型引用
// 而不是值 import：只借它的**形状**，不在运行期多 import 一个模块。
/** @typedef {import('../modules/data/domain/authz.ts').MetricParamDef} MetricParamDef */

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

/** 指标名形态 `<域>:<指标名>`（与 scripts/check-data-models.mjs 规则 ⑥ 同一句；门禁是权威，这里只兜底）。 */
const METRIC_NAME_RE = /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/

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
 * @typedef {object} ComparableMetric
 * @property {string} id
 * @property {string} title
 * @property {string} description
 * @property {string | null} requiredScope
 * @property {string} subjectColumn
 * @property {string} selectSql
 * @property {string} groupBy
 * @property {Record<string, MetricParamDef>} params
 */

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
 * 语义事实源 YAML → L1 行（`MetricDef` 形状；org / source 由写入口钉死，不在这里）。
 *
 * 字段映射（为什么这么映，逐条）：
 *   `name`        → `id`（词表主键；L2 的 `baseMetric` 引的就是它）
 *   `label`       → `title`（人读名；缺省回落到 name，别让 title 为空串——管理面靠它认指标）
 *   `definition`  → `description`（口径的逐字定义，进词表给人与 agent 看）
 *   `expression`  → 值表达式（进 select_sql）
 *   `grain`       → GROUP BY 维度（**同时**是 L2 的可见维度白名单与过滤维度全集）
 *   `requiredScope` → **恒 null**：L1 指标对所有拿到本模块的人可见。`tier` **不**映射成
 *                     requiredScope——spec §10 明写 tier 是**标记不是强制**（「本仓不靠它挡谁，
 *                     靠它让人一眼看见成熟度」），拿它当权限会凭空造出一条谁也说不清的授权规则。
 *   `owner` / `tier` / `sources` → **不落库**（`data.metrics` 没有对应列）。它们仍是治理面的
 *                     事实源（在 YAML 里、被静态门禁规则 ⑤ 强制必填），只是不在这张表上体现。
 *                     ⚠️ 这是本任务的一处**已知边界**，见 README「L2 的已知边界」。
 *
 * @param {unknown} parsed YAML 解析结果
 * @returns {ComparableMetric[]}
 */
export function declarationsFromYaml(parsed) {
  if (parsed === null || typeof parsed !== 'object') throw new Error(`${L1_DECLARATIONS_REL} 的顶层不是对象`)
  const metrics = /** @type {Record<string, unknown>} */ (parsed).metrics
  if (!Array.isArray(metrics)) throw new Error(`${L1_DECLARATIONS_REL} 缺少 metrics 数组`)

  return metrics.map((raw) => {
    const m = /** @type {Record<string, unknown>} */ (raw)
    const name = String(m.name ?? '')
    if (!METRIC_NAME_RE.test(name)) {
      throw new Error(`指标名 \`${name}\` 不合命名空间形态 \`<域>:<指标名>\`（小写蛇形，两段）`)
    }
    const expression = String(m.expression ?? '')
    if (expression === '') throw new Error(`指标 \`${name}\` 缺 expression`)
    if (!Array.isArray(m.grain) || m.grain.length === 0) {
      throw new Error(`指标 \`${name}\` 的 grain 必须是非空数组（grain 同时是 L2 的维度白名单来源）`)
    }
    const grain = m.grain.map((/** @type {unknown} */ g) => String(g))
    const relation = deriveRelation(expression, name)
    return {
      id: name,
      title: String(m.label ?? name),
      description: String(m.definition ?? ''),
      requiredScope: /** @type {string|null} */ (null),
      subjectColumn: L1_SUBJECT_COLUMN,
      selectSql: buildSelectSql(expression, grain, relation),
      groupBy: grain.join(', '),
      // L1 声明没有查询参数（params 是问数参数面的东西，L2 也暂不开放）
      params: /** @type {Record<string, MetricParamDef>} */ ({}),
    }
  })
}

/** 内容比对用的一行摘要（**只比**决定「要不要写」的字段；created_at/updated_at 不参与）。 */
const comparableOf = (/** @type {ComparableMetric} */ row) => JSON.stringify([
  row.title, row.description, row.requiredScope, row.subjectColumn, row.selectSql, row.groupBy, row.params,
])

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

/**
 * 读仓内的 L1 声明（唯一事实源）。
 *
 * @param {string} rootDir 仓库根
 * @returns {ReturnType<typeof declarationsFromYaml>}
 */
export function readDeclarations(rootDir) {
  const file = path.join(rootDir, L1_DECLARATIONS_REL)
  const parsed = parseYaml(readFileSync(file, 'utf8'))
  return declarationsFromYaml(parsed)
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
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

  const declared = readDeclarations(rootDir)
  const pool = poolFromEnv()
  try {
    const current = await loadPlatformCatalog(pool)
    const diff = diffDeclarations(declared, current)

    if (dryRun) {
      console.log(
        `${SCRIPT_NAME}: dry-run —— 新增 ${diff.added.length} / 更新 ${diff.updated.length}`
        + ` / 删除 ${diff.removed.length} / 未变 ${diff.unchanged.length}`,
      )
      for (const id of [...diff.added, ...diff.updated, ...diff.removed]) console.log(`  ${id}`)
      return
    }

    for (const d of declared) await upsertL1Metric(pool, d)
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
