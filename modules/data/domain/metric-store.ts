// metric-store.ts — 指标词表的存储层（语义层声明在平台库里的投影）。
//
// 隔离键一律是 **org（text，值 = 该租户的 Casdoor org）**，不是 tenant_id：
// 正典 docs/module-protocol.md「租户数据隔离」，机器判据 scripts/check-tenant-isolation.mjs。
// 三处读写**全部**带 `where org = $1`——漏一处就是跨租户串数据。
import type { Pool } from 'pg'
import type { MetricDef, MetricParamDef } from './authz'

/** 行 → MetricDef：只映射契约里的字段（created_at/updated_at 不外泄给授权核心）。 */
function toMetricDef(row: Record<string, unknown>): MetricDef {
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
  }
}

/** 本租户的整份词表。`order by id`：顺序确定，调用方（T4/T6）与我都不必猜。 */
export async function loadCatalog(pool: Pool, org: string): Promise<MetricDef[]> {
  const r = await pool.query(
    `select id, title, description, required_scope, subject_column, select_sql, group_by, params
       from data.metrics
      where org = $1
      order by id`,
    [org],
  )
  return r.rows.map(toMetricDef)
}

// 覆盖式写入：同 (org, id) 幂等（部署脚本会重跑迁移/重复投递词表）。
//
// ⚠️ 冲突分支必须是 **do update**，不是 do nothing：`do nothing` 会让「改过的词表再也投不进去」
//    （第二次投递静默无效——词表是运营面会改的东西，这正是它最需要的语义）。
// ⚠️ 冲突分支**不碰 created_at**：只刷 updated_at。created_at 是「这一行什么时候进来的」，
//    upsert 是改内容不是重建行，抹掉它就丢了唯一的时间锚。
export async function upsertMetric(pool: Pool, org: string, def: MetricDef): Promise<void> {
  await pool.query(
    `insert into data.metrics
       (org, id, title, description, required_scope, subject_column, select_sql, group_by, params)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (org, id) do update set
       title          = excluded.title,
       description    = excluded.description,
       required_scope = excluded.required_scope,
       subject_column = excluded.subject_column,
       select_sql     = excluded.select_sql,
       group_by       = excluded.group_by,
       params         = excluded.params,
       updated_at     = now()`,
    [
      org, def.id, def.title, def.description, def.requiredScope,
      def.subjectColumn, def.selectSql, def.groupBy, JSON.stringify(def.params),
    ],
  )
}

/** 删除：返回是否真命中一行（没命中不是错误）。 */
export async function deleteMetric(pool: Pool, org: string, id: string): Promise<boolean> {
  const r = await pool.query(
    'delete from data.metrics where org = $1 and id = $2',
    [org, id],
  )
  return (r.rowCount ?? 0) > 0
}
