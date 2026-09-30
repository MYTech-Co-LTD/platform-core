// report-store.ts — 报表登记的存储层（双写面的平台侧，spec §4/§7）。
//
// 隔离键一律是 **org（text，值 = 该租户的 Casdoor org）**，不是 tenant_id：
// 正典 docs/module-protocol.md「租户数据隔离」，机器判据 scripts/check-tenant-isolation.mjs。
// 三处读写**全部**带 `where org = $1`——漏一处就是跨租户串数据。
//
// `renderer` 区分渲染器：`metabase` = 嵌 Metabase dashboard（有真 `metabase_id`）；
// `platform` = 平台自绘，**没有** Metabase dashboard（`metabase_id` 落 0，见 ReportRow）。
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { ReportSpec } from './report-spec'

/** 渲染器取值域，与库侧 check 约束 `data_reports_renderer_check` 同域（列默认 'metabase'）。 */
export type ReportRenderer = 'metabase' | 'platform'

export interface ReportRow {
  id: string
  title: string
  /**
   * **`renderer='platform'` 的行为 0，即哨兵——凡用它之前先判 renderer。**
   *
   * 为什么是 0 而不是 null：`metabase_id` 是 `integer not null`（迁移 003），放宽它为 null
   * 需要 `drop not null`——那是一条独立的破坏性 DDL，而眼下**没有任何** platform 行；
   * 等真写第一行 platform 时与迁移一起做，避免本轮动存量列。
   * 0 在 Metabase 里不可能是真 dashboard id（id 从 1 起）⇒ 拿 0 当 id 去请求必然失败，
   * 不会静默指向别的 dashboard。
   */
  metabaseId: number
  /** 本报表除 `tenant` 外要锁的参数 → 值（`tenant` 的平台保留值不在此列，见 routes/reports.ts）。 */
  embedParams: Record<string, string>
  requiredScope: string | null
  renderer: ReportRenderer
  /**
   * 平台自绘的**声明式规格**（spec §3⑥；迁移 007）：`renderer='platform'` ⇒ 必非空，
   * `renderer='metabase'` ⇒ 必为 null（库侧跨列 check `data_reports_spec_by_renderer` 把两边都钉死）。
   * 读侧不再 JSON.parse——jsonb pg 已反序列化成对象（与 embed_params 同口径）。
   */
  spec: ReportSpec | null
  /** 登记侧版本号（spec §3③）：每次写 +1；写请求必须回带它（人裁 2026-09-29 fail-closed）。 */
  version: number
}

/**
 * 七列投影提成常量：四处 `select/returning` 共用（避免漏改一处导致 `toReportRow` 拿到 `undefined`）。
 * `data.reports` 的读取一律走它，新增列只改这一行。
 */
const REPORT_COLS = 'id, title, metabase_id, embed_params, required_scope, renderer, version, spec'

/** 行 → ReportRow。`metabase_id` 是 int4 ⇒ pg 回 JS number（**bigint 会回 string**，故列类型选 int4）。 */
function toReportRow(row: Record<string, unknown>): ReportRow {
  return {
    id: row.id as string,
    title: row.title as string,
    metabaseId: row.metabase_id as number,
    // embed_params 是 jsonb：pg 已反序列化成对象，**不要**再 JSON.parse（那是第二个事实源）
    embedParams: row.embed_params as Record<string, string>,
    requiredScope: row.required_scope as string | null,
    renderer: row.renderer as ReportRenderer,
    version: row.version as number,
    spec: (row.spec ?? null) as ReportSpec | null,
  }
}

/** 本 org 的全部登记。`order by title`：顺序确定，对账差集与 console 列表都不必猜。 */
export async function listReports(pool: Pool, org: string): Promise<ReportRow[]> {
  const r = await pool.query(
    `select ${REPORT_COLS}
       from data.reports
      where org = $1
      order by title`,
    [org],
  )
  return r.rows.map(toReportRow)
}

/** 单行读取。**必须带 org**——否则 id 就是跨租户探测句柄。 */
export async function getReport(pool: Pool, org: string, id: string): Promise<ReportRow | null> {
  const r = await pool.query(
    `select ${REPORT_COLS}
       from data.reports
      where org = $1 and id = $2`,
    [org, id],
  )
  return r.rowCount === 0 ? null : toReportRow(r.rows[0])
}

/** 带隔离键的登记行——只有跨 org 的对账面需要把 org 显式带出来。 */
export interface RegisteredReport extends ReportRow {
  org: string
}

/**
 * **全部租户**的登记（对账的登记侧并集）。
 *
 * 为什么必须跨 org 读（I-2）：`unregistered` 的判据是「Metabase 可嵌入集里**不属于任何 org 的
 * 任何一行 `metabase_id`**」。只读本 org 时，别人的 dashboard（本来就登记在别人名下）会
 * **恒被报成本租户未登记** ⇒ 多租户部署下这个差集恒非空 / 或按 title 求差时恒空——
 * 两种都是**假绿**（对账机制一半失效，spec §7 的目的被绕过）。
 * 跨 org 读是**平台级对账动作**的一部分（spec §7 的对账本就是平台级的），仅
 * `POST /reports/reconcile` 使用；其余读写面一律带 `where org = $1`。
 */
export async function listAllReports(pool: Pool): Promise<RegisteredReport[]> {
  const r = await pool.query(
    `select org, ${REPORT_COLS}
       from data.reports
      order by org, title`,
  )
  return r.rows.map((row) => ({ ...toReportRow(row), org: row.org as string }))
}

/**
 * 幂等登记：**冲突键是 (org, title)**，不是 (org, id)。
 *
 * 为什么按 title 而不是 id：幂等的语义是「同一个报表重跑一次不重复建」，而报表在 Metabase
 * 侧的身份就是它的 name（`API 无按名 upsert`，平台自己按 name 找 → spec §6.5）。按 id 做冲突
 * 键的话，每次 POST 都会生成新 uuid ⇒ 每次都新增一行，正是要防的那个 bug。
 *
 * 二次 POST 覆盖 metabase_id / embed_params / required_scope / renderer，但**不换 id**（老 id 保留 ⇒
 * 已经发出去的嵌入 URL 指向的行不会凭空消失），也不碰 created_at（那是「这行什么时候进来的」）。
 * 返回登记行的 id（稳定）。
 *
 * `renderer` 是可选参数（缺省 `metabase`，与列默认同值）⇒ 既有调用方不传也对，
 * 且改渲染器 = 二次 upsert 带上它即可（冲突分支把 excluded 整列覆盖）。
 * `spec` 同为可选（缺省落 SQL null）：既有 Metabase 调用点（routes/reports.ts 的
 * `POST /reports`）不传也照常编译运行；自绘调用方必须显式带 spec，否则库侧跨列 check
 * `data_reports_spec_by_renderer`（迁移 007）直接拒——「自绘行必须有规格」不靠调用方自觉。
 */
export async function upsertReport(
  pool: Pool,
  org: string,
  input: {
    title: string; metabaseId: number; embedParams: Record<string, string>
    requiredScope: string | null; renderer?: ReportRenderer; spec?: ReportSpec | null
  },
): Promise<string> {
  const r = await pool.query(
    `insert into data.reports (org, id, title, metabase_id, embed_params, required_scope, renderer, spec)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (org, title) do update set
       metabase_id    = excluded.metabase_id,
       embed_params   = excluded.embed_params,
       required_scope = excluded.required_scope,
       renderer       = excluded.renderer,
       spec           = excluded.spec,
       version        = data.reports.version + 1,
       updated_at     = now()
     returning id`,
    [org, randomUUID(), input.title, input.metabaseId,
      JSON.stringify(input.embedParams), input.requiredScope, input.renderer ?? 'metabase',
      // 缺省必须是 **SQL null**（不是 jsonb 的 'null' 字面量）——后者在 `spec is null` 里为假，
      // 会把 Metabase 行钉死在跨列 check 上。pg 收到 JS null 才发 SQL NULL（与 embed_params
      // 同款显式 stringify：不依赖驱动对对象的隐式序列化）。
      input.spec == null ? null : JSON.stringify(input.spec)],
  )
  return r.rows[0].id as string
}

/** 删登记行：返回是否真命中一行（没命中不是错误）。 */
export async function deleteReport(pool: Pool, org: string, id: string): Promise<boolean> {
  const r = await pool.query('delete from data.reports where org = $1 and id = $2', [org, id])
  return (r.rowCount ?? 0) > 0
}

/**
 * 页门改动（管理面动作，spec §3⑤）：`requiredScope` 传 null = **发布**（所有拿到本模块的人
 * 可见，口径同 `data.metrics.required_scope`）。**没有独立的 published 列**——「未发布」就是
 * 页门未放行在观看面的表现，不为管理动作新增状态列。
 *
 * 返回更新后的整行（`updatedAt` 由 SQL 侧 `updated_at = now()` 维护，不在投影里）；
 * 没命中返回 null ⇒ 路由层一律 404。
 *
 * **条件更新（写保护，spec §3③）**：只有 `version = expectedVersion` 才落（并 `version + 1`）。
 * 不命中（陈旧版本 / 跨租户 / id 不存在）都返回 null——**三种原因合流**，是刻意的：
 * 存储层不区分它们、也不给存在性探针；路由层要先 `getReport` 才能把「不存在」判 404、
 * 把「陈旧」判 409（见 Task 3）。
 */
export async function updateRequiredScope(
  pool: Pool, org: string, id: string, requiredScope: string | null, expectedVersion: number,
): Promise<ReportRow | null> {
  const r = await pool.query(
    `update data.reports
        set required_scope = $3, version = version + 1, updated_at = now()
      where org = $1 and id = $2 and version = $4
      returning ${REPORT_COLS}`,
    [org, id, requiredScope, expectedVersion],
  )
  return r.rowCount === 0 ? null : toReportRow(r.rows[0])
}

/**
 * 规格改写（自绘报表的管理面动作，spec §3⑥）：与 `updateRequiredScope` 同款**条件更新**——
 * 只有 `version = expectedVersion` 才落（并 `version + 1`）；没命中（陈旧版本 / 跨租户 /
 * id 不存在）都返回 null，三种原因合流是刻意的（不给存在性探针，路由层先 `getReport` 再分流，
 * 见 Task 3）。规格本身已在装载前经 `parseReportSpec` 校验（白名单），存储层不再重复解析。
 *
 * 非自绘行（`renderer='metabase'`）不在此拦：本函数只在自绘编辑通路上被调用；对 metabase 行
 * 误用会撞上跨列 check（metabase ⇒ spec 必须 null）而抛错——库侧兜底，不是静默写坏。
 */
export async function updateSpec(
  pool: Pool, org: string, id: string, spec: ReportSpec, expectedVersion: number,
): Promise<ReportRow | null> {
  const r = await pool.query(
    `update data.reports
        set spec = $3, version = version + 1, updated_at = now()
      where org = $1 and id = $2 and version = $4
      returning ${REPORT_COLS}`,
    [org, id, JSON.stringify(spec), expectedVersion],
  )
  return r.rowCount === 0 ? null : toReportRow(r.rows[0])
}

/** 轻量只读：只为 409 的 currentVersion（给客户端重试用）。 */
export async function getReportVersion(pool: Pool, org: string, id: string): Promise<number | null> {
  const r = await pool.query('select version from data.reports where org = $1 and id = $2', [org, id])
  return r.rowCount === 0 ? null : (r.rows[0].version as number)
}
