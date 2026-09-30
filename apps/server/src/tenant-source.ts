// tenant-source.ts — `platform.tenant_source`（007 迁移）的全部 SQL，**单一事实源**。
//
// 为什么单独一处：这张表有两个写入方 —— admin 的 `PUT /sources`（整体替换）与开通 CLI
// （`scripts/provision-tenant.mjs --source`，只启用）。各写一份 SQL 的话，改列名/冲突目标
// 必须同改两处，漏一处的症状是**运行时 500**，而两份 SQL 在类型系统里长得一模一样，
// 编译器与 reviewer 都拦不住。故 upsert 语句只在这里出现一次，两个写入方都引它。
//
// 「整体替换」的**完整语义也只在一处**（`replaceTenantSources`）：upsert 与「禁用不在列表里的」
// 是一对，拆开写就会出现「只加不删」那种半残实现（删了第二句仍是合法 SQL，静默跑通）。
import type { Pool, PoolClient } from 'pg'

/** 只 enable 的 upsert：开通动作**绝不**因某源这次没传就把它禁用（禁用是整体替换的事）。 */
export const SOURCES_UPSERT_SQL = `insert into platform.tenant_source(tenant_id, source, enabled)
     select $1, s, true from unnest($2::text[]) as s
     on conflict (tenant_id, source) do update set enabled = true`

/** 整体替换的第二句：不在列表里的置 false。**不删行** —— 保留 enabled=false 的痕迹便于对账与审计。 */
export const SOURCES_DISABLE_SQL =
  'update platform.tenant_source set enabled = false where tenant_id = $1 and not (source = any($2::text[]))'

/** 本租户已接入源（GET 的读形状）。 */
export const SOURCES_SELECT_SQL =
  'select source, enabled from platform.tenant_source where tenant_id = $1 order by source'

/** 能执行查询的最小面（`Pool` 与事务用的 `PoolClient` 都满足）。 */
export type SqlExecutor = Pick<Pool | PoolClient, 'query'>

/**
 * **整体替换**（PUT /sources 的唯一实现）：两句按序执行 —— 列表里的 upsert 为 true，
 * 不在列表里的置为 false。
 *
 * ⚠️ 两句**必须在同一事务里**（调用方给 `exec` 传已 begin 的 client）：否则中途失败会留下
 * 「已启用的启用、该禁的没禁」的半应用态 —— 而这正是本端点要防的状态，它比整个请求失败更难查。
 *
 * ⚠️ `sources` 必须是**去重后**的：同一键在同一条 `insert ... on conflict do update` 里出现两次，
 * Postgres 直接报 `ON CONFLICT DO UPDATE command cannot affect row a second time`（21000）
 * —— 在路由上是**客户端可控的 500**，在 CLI 上是**开通命令直接崩**。
 *
 * 去重**收在各调用方**，SQL 层不兜底（本模块不替调用方猜语义，也不静默改它的输入）：
 *   · 路由：`admin.ts` 的 `SourcesBody`（zod 层的 `transform`，去重放行 —— 启用集是集合语义）；
 *   · CLI：`scripts/provision-tenant.mjs` 的 `parseSources`（参数解析处去重）。
 * ⇒ **本模块新增调用方时，去重是调用方的责任**，别假定这里会帮你挡掉。
 *
 * 事务由**调用方**就地开（照 migrate.ts:200-220 / seed.ts:93-100 的既有形状：connect → begin →
 * commit，失败 `rollback().catch(()=>{})` 后原样抛，finally release）—— 本仓没有 withTx 之类
 * 助手，此处也刻意不新立一套。
 */
export async function replaceTenantSources(
  exec: SqlExecutor,
  tenantId: number,
  sources: string[],
): Promise<void> {
  await exec.query(SOURCES_UPSERT_SQL, [tenantId, sources])
  await exec.query(SOURCES_DISABLE_SQL, [tenantId, sources])
}
