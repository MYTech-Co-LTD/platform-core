// metric-store.ts — 指标词表的存储层（语义层声明在平台库里的投影）。
//
// 隔离键一律是 **org（text，值 = 该租户的 Casdoor org）**，不是 tenant_id：
// 正典 docs/module-protocol.md「租户数据隔离」，机器判据 scripts/check-tenant-isolation.mjs。
// 三处读写**全部**带 `where org = $1`——漏一处就是跨租户串数据。
import type { Pool, PoolClient } from 'pg'
import type { MetricDef, MetricParamDef } from './authz'
import type { MetricRowSnapshot } from './metric-audit-store'

/**
 * 指标行的**来源分层**（003_metrics_source.sql）——「这行 select_sql 谁写的、谁可以改」。
 *
 * `l1` = 平台语义声明，由 `scripts/sync-data-semantics.mjs` 从仓内 dbt YAML 物化；
 *        管理 API **只读**（改 L1 口径要改 dbt 声明并重新物化，不能经 API 就地改）。
 * `l2` = 租户声明，由 `domain/semantic-compiler.ts`（唯一编译点）从结构化声明编译。
 */
export type MetricSource = 'l1' | 'l2'

/**
 * 库里的 L1 桶 org 值（**不是** env 的 `PLATFORM_ORG`）。
 *
 * L1 行落 `org = 'platform'`（全局约束 5：平台级声明也是合法 org 值，**不豁免** org 列纪律）。
 * 与 `PLATFORM_ORG` 的区别：那个是 single 模式下「本部署唯一租户」的解析来源（apps/server/src/tenant.ts），
 * 值是某个真实公司的 casdoor org；这个只是 data.metrics 里的一个固定桶名。
 */
export const L1_ORG = 'platform'

/**
 * 存储行 = 授权契约（`MetricDef`）+ **来源标注** + **源系统**。
 *
 * 为什么把 `source` 放在剥壳类型上而不是塞进 `MetricDef`：`MetricDef` 是**授权核心的契约**
 * （domain/authz.ts 只消费语义字段），来源是**存储/治理**属性，与授权判定无关。
 * 混进去会让授权核心的每次构造都要带上它，而它一个字都不读。
 *
 * `sourceSystem`（库列 `source_system`）与 `source` 是本文件里最容易混的一对：
 *   · `source`       = 取值 `l1`/`l2` ——「**谁写的**」（来源分层，决定谁能改）。
 *   · `sourceSystem` = 取值如 `lemeng` ——「**数据来自哪个源系统**」（源维度，spec §3⑧）。
 * 故列的命名刻意错开（`source_system` 而不是塞进 `source`）——同名不同义是静默错答的温床。
 * 可空：L2 行由租户声明编译而来，**没有**源系统；L1 行的值恒等于声明的 `source`。
 */
export interface MetricRow extends MetricDef {
  source: MetricSource
  sourceSystem: string | null
  /** 最后操作人（Casdoor 用户名）；L1 行走 sync 物化 ⇒ 恒 null。 */
  updatedBy: string | null
  /** 单调计数（每次经 API 写 +1）；L1 行恒 1。与报表 005 同形，但此处是为**追溯**不是乐观并发。 */
  version: number
}

/**
 * **L1 写入口**的入参形状：授权契约 + 源系统（`upsertL1Metric` 专用）。
 *
 * 为什么把源系统写成**必填**而不是可选：L1 声明里 `source` 是必填字段（门禁规则 ⑤），
 * 物化出的 L1 行因此恒有源。写成可选会给「漏传 ⇒ 静默落 null」留门，而那正是
 * 「平台行的源维度凭空消失、Task 5 的裁剪把它判成未接入源」的失败形态。
 */
export interface L1MetricDef extends MetricDef {
  sourceSystem: string | null
}

/** 行 → MetricRow：只映射契约里的字段（created_at/updated_at 不外泄给授权核心）。 */
function toMetricRow(row: Record<string, unknown>): MetricRow {
  return {
    id: row.id as string,
    title: row.title as string,
    description: row.description as string,
    requiredScope: row.required_scope as string | null,
    subjectColumn: row.subject_column as string,
    selectSql: row.select_sql as string,
    groupBy: row.group_by as string,
    // params 是 jsonb：pg 已把它反序列化成对象，**不要**再 JSON.parse（那是第二个事实源）
    params: row.params as Record<string, MetricParamDef>,
    source: row.source as MetricSource,
    sourceSystem: row.source_system as string | null,
    updatedBy: (row.updated_by ?? null) as string | null,
    version: Number(row.version ?? 1),
  }
}

/** 投影列清单（三处查询共用一处写法——少写/写错一列是「字段静默变 undefined」的经典来源）。 */
const ROW_COLUMNS =
  'id, title, description, required_scope, subject_column, select_sql, group_by, params, source, source_system, updated_by, version'

/**
 * 本 org 的 L2 行（**不含** L1 平台行）。`order by id`：顺序确定。
 *
 * ⚠️ **消费通道一律不得调用本函数**（T8 评审 C1，Critical）。它只回本 org 的行 ⇒
 *   平台 L1 指标在调用它的通道上**整条消失**（不是报错，是「这个词表里没这个 id」）；
 *   而 `GET /metrics` 用的是合并词表 ⇒ **同一 id 在两条通道上胜负相反**
 *   （console 显示平台口径、`/query` 却跑租户那条 `source='l2'` 的 SQL），
 *   且没有任何状态码/日志/审计差异——是静默错答类缺陷。
 *
 *   消费面（`POST /query`、MCP `tools/list`、chat、`GET /metrics`）**唯一**的词表加载器是
 *   `loadMergedCatalog`。名字里的 `Org` 就是为了让这个错法在调用点一眼可辨：
 *   `loadCatalog` 读起来像「那个词表加载器」，正是 C1 里三条通道集体用错它的原因。
 *   本函数在**生产路径上没有调用方**——它服务的是存储层的「单桶」断言
 *   （`metric-store.test.ts`：只回本 org、行 → `MetricRow` 映射保真）。
 *   机器判据：`catalog-consumers.test.ts` 的「来源守卫」组逐文件钉住四个消费模块引用的是哪一个。
 */
export async function loadOrgCatalog(pool: Pool, org: string): Promise<MetricRow[]> {
  const r = await pool.query(
    `select ${ROW_COLUMNS} from data.metrics where org = $1 order by id`,
    [org],
  )
  return r.rows.map(toMetricRow)
}

/** L1 平台词表（唯一物化来源是 sync 脚本）。`order by id`：与合并口径一致。 */
export async function loadPlatformCatalog(pool: Pool): Promise<MetricRow[]> {
  const r = await pool.query(
    `select ${ROW_COLUMNS} from data.metrics where org = $1 and source = 'l1' order by id`,
    [L1_ORG],
  )
  return r.rows.map(toMetricRow)
}

/**
 * 消费面词表 = **L1（平台）∪ L2（本 org）**（计划 Task 8「catalog 加载」）。
 *
 * ★ **这是消费通道唯一的词表加载器**（T8 评审 C1 的整改落点）：`POST /query`、
 *   MCP `tools/list`、chat（`domain/agent-loop.ts`）、`GET /metrics` 四条面全部经它，
 *   于是「同一 id 在任一通道上解析结果一致（撞 id 时 L1 赢）」是**加载器的性质**，
 *   而不是四条通道各自的性质——四条各自加载就会漂（C1 的实况：3/4 条用了 `loadOrgCatalog`）。
 *   机器判据：`catalog-consumers.test.ts`（四通道一致性断言 + 来源守卫）。
 *
 * ★ L2 **不可覆盖** L1 口径：见下方撞名分支——这是「L2 只 refine 不改口径」在加载侧的落点。
 *   写入侧已有闸门（routes/metrics.ts 的 `ID_RESERVED_BY_L1`），这里是**第二道**：
 *   闸门被绕过（历史数据 / 直接写库 / 「先建 L2、后物化 L1」的合法时序）时，
 *   加载侧仍不能让 L2 行顶掉 L1 行，否则「L1 口径唯一」就只靠写侧那道门——
 *   而单道门的失效是静默的。
 */
export async function loadMergedCatalog(pool: Pool, org: string): Promise<MetricRow[]> {
  const r = await pool.query(
    // L1 桶恒取 platform；L2 只取本 org（**不**跨租户读别人的 L2 行）
    `select ${ROW_COLUMNS} from data.metrics
      where (org = $1 and source = 'l2') or (org = $2 and source = 'l1')
      order by id, source`,
    [org, L1_ORG],
  )
  const merged: MetricRow[] = []
  const l1Ids = new Set<string>()
  for (const row of r.rows.map(toMetricRow)) if (row.source === 'l1') l1Ids.add(row.id)
  for (const row of r.rows.map(toMetricRow)) {
    // L2 撞 L1 的 id ⇒ 丢弃 L2 行（L1 赢）。丢弃而不是报错：加载是读路径，
    // 读路径抛错会让整条问数链因为一行脏数据不可用——而写侧闸门保证这行不该存在。
    if (row.source === 'l2' && l1Ids.has(row.id)) continue
    merged.push(row)
  }
  return merged
}

// ── 两个写入函数，**不是一个带 source 参数的函数** ──────────────────────────────
// 来源是「这行谁写的、谁可以改」的分水岭（L1 只读 / L2 可改），故把它做成**两个各自命名的
// 入口**，而不是一个 `source` 形参：
//   · `upsertMetric`   —— 租户写路径（T2/T8 的管理 API、集成测试）。**写死的 l1 不可能出现**。
//   · `upsertL1Metric` —— 平台物化路径（**只许** scripts/sync-data-semantics.mjs 调）。
// 好处有两条，都是形参版做不到的：
//   ① `grep upsertL1Metric` 就能穷举「谁在写平台词表」，不需要逐个调用点看实参；
//   ② 形参版若给 source 一个默认值，漏传会**静默**写成 l2（一行平台声明变成租户可改的行）；
//      两个入口版没有「漏传」这个失败态。
// 代价是多一个函数——而它换掉的是一条静默的、安全相关的失败路径。

// 覆盖式写入：同 (org, id) 幂等（部署脚本会重跑迁移/重复投递词表）。
//
// ⚠️ 冲突分支必须是 **do update**，不是 do nothing：`do nothing` 会让「改过的词表再也投不进去」
//    （第二次投递静默无效——词表是运营面会改的东西，这正是它最需要的语义）。
// ⚠️ 冲突分支**不碰 created_at**：只刷 updated_at。created_at 是「这一行什么时候进来的」，
//    upsert 是改内容不是重建行，抹掉它就丢了唯一的时间锚。
// ⚠️ 冲突分支**不碰 source**：来源只由「首次插入」确定。让它被 excluded 覆盖，等于任何一次写
//    都能把这行从 L1 改标成 L2（或反之）——来源标注被写动作改掉，它就失去了意义。
// ⚠️ 冲突分支**同样不碰 source_system**（与 source 同一纪律，理由比它更实）：L2 行没有源
//    （插入值显式 `null`），而冲突分支若把它写成 excluded，则「租户写路径撞上同 (org,id) 的
//    L1 行」这一次写动作就会把**平台行的源维度抹成 null**——而 sync 的 `--check` 拿声明比对
//    库内 L1 行时会因此**长期报漂移**（一次租户写，永久红）。
export async function upsertMetric(
  db: Pool | PoolClient, org: string, def: MetricDef, updatedBy: string,
): Promise<void> {
  // ★ `updatedBy` 是**必填**（不给默认值）：给了默认值就等于留一条「不写人也能写库」的暗道，
  //   而 #489 的全部意义就是堵它。⚠️ 调用方若直接传 Pool（如夹具），参数照传即可——
  //   生产写路径（domain/metric-write）传的是事务里的 client，审计与变更同生共死。
  await db.query(
    `insert into data.metrics
       (org, id, title, description, required_scope, subject_column, select_sql, group_by, params, source, source_system, updated_by, version)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'l2', null, $10, 1)
     on conflict (org, id) do update set
       title          = excluded.title,
       description    = excluded.description,
       required_scope = excluded.required_scope,
       subject_column = excluded.subject_column,
       select_sql     = excluded.select_sql,
       group_by       = excluded.group_by,
       params         = excluded.params,
       updated_by     = excluded.updated_by,
       version        = data.metrics.version + 1,   -- ★ 单调计数（追溯用；本表无并发写案例，不做乐观并发）
       updated_at     = now()`,
    [
      org, def.id, def.title, def.description, def.requiredScope,
      def.subjectColumn, def.selectSql, def.groupBy, JSON.stringify(def.params), updatedBy,
    ],
  )
}

/**
 * **平台词表物化专用**：写 `org = 'platform'` 的 `source='l1'` 行。
 *
 * ⚠️ 唯一的合法调用方是 `scripts/sync-data-semantics.mjs`（L1 的 select_sql 只能从仓内 dbt
 *    YAML 物化）。管理 API **不得**调它——那等于让租户经 HTTP 写平台词表（跨租户能力）。
 *    测试里直调它是为了造 L1 夹具（等价于 sync 的产物）。
 *
 * 源系统（`source_system`）与其它语义字段**同进退**：声明是 L1 行的真值，故冲突分支也刷它
 * （改了声明的 `source` ⇒ 重新物化就跟上）。若只写首次插入，声明的源改了而库里不动，
 * `sync --check` 会永远报同一条漂移——而漂移报告是那套对账机制的全部产出。
 */
export async function upsertL1Metric(pool: Pool, def: L1MetricDef): Promise<void> {
  await pool.query(
    `insert into data.metrics
       (org, id, title, description, required_scope, subject_column, select_sql, group_by, params, source, source_system)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'l1', $10)
     on conflict (org, id) do update set
       title          = excluded.title,
       description    = excluded.description,
       required_scope = excluded.required_scope,
       subject_column = excluded.subject_column,
       select_sql     = excluded.select_sql,
       group_by       = excluded.group_by,
       params         = excluded.params,
       source_system  = excluded.source_system,
       updated_at     = now()`,
    [
      L1_ORG, def.id, def.title, def.description, def.requiredScope,
      def.subjectColumn, def.selectSql, def.groupBy, JSON.stringify(def.params), def.sourceSystem,
    ],
  )
}

/**
 * 删除：返回是否真命中一行（没命中不是错误）。
 *
 * ★ `and source = 'l2'` 是**纪律落进 SQL**（不是靠调用方记得）：L1 行的 select_sql 只能由
 *   sync 脚本从仓内 YAML 物化，管理 API 对它**只读**。「只读」若写在注释里，就得靠每个新调用点
 *   自觉；写在 WHERE 里，任何调用点都删不掉 L1 行。L1 行的删除唯一路径是 sync 的差集处置
 *   （仓内声明没了 ⇒ 物化时删），那是另一条显式路径。
 */
export async function deleteMetric(db: Pool | PoolClient, org: string, id: string): Promise<boolean> {
  const r = await db.query(
    "delete from data.metrics where org = $1 and id = $2 and source = 'l2'",
    [org, id],
  )
  return (r.rowCount ?? 0) > 0
}

/**
 * 点读一行的**语义快照**（#489）：审计的前后态用它，它同时是「这次是建还是改」的判据
 * （写之前有没有这行）。
 *
 * `and source = 'l2'` 与 `deleteMetric` 同一条纪律：平台桶的 L1 行不经本路径，
 * 也就永远不会有「以它为主题」的审计行。
 * 返回类型 `MetricRowSnapshot` 定义在 `metric-audit-store.ts`（审计的形状），
 * 依赖方向是 store → audit-store，单向、无环。
 */
export async function selectMetricSnapshot(
  db: Pool | PoolClient, org: string, id: string,
): Promise<MetricRowSnapshot | null> {
  const r = await db.query(
    `select title, description, subject_column, select_sql, group_by, params
       from data.metrics where org = $1 and id = $2 and source = 'l2'`,
    [org, id],
  )
  if ((r.rowCount ?? 0) === 0) return null
  const row = r.rows[0] as Record<string, unknown>
  return {
    title: row.title as string,
    description: row.description as string,
    subjectColumn: row.subject_column as string,
    selectSql: row.select_sql as string,
    groupBy: row.group_by as string,
    params: row.params as Record<string, unknown>,
  }
}

/**
 * sync 专用：删掉本仓声明集里**已不存在**的 L1 行（双向差集的删除侧）。
 *
 * 与 `deleteMetric` 分开、且**不**带 `source = 'l2'`——它的作用域由 `org = L1_ORG and source='l1'`
 * 单独界定，绝不能让它能被租户 org 调到（那会变成「删别人的平台词表」）。
 */
export async function deleteStaleL1Metrics(pool: Pool, keepIds: readonly string[]): Promise<string[]> {
  const r = await pool.query(
    `delete from data.metrics
      where org = $1 and source = 'l1' and not (id = any($2::text[]))
      returning id`,
    [L1_ORG, keepIds],
  )
  return r.rows.map((row) => row.id as string)
}
