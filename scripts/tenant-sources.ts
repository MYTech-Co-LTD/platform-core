// scripts/tenant-sources.ts — 平台侧装配：`org`（Casdoor org）→ 本租户已接入的源集合。
//
// 为什么在 scripts/ 而不在 modules/data/domain/verified-regression.ts：
//   · `QueryDeps.adoptedSources` 是 `query_metric` 的**裁剪闸门**（未接入源的指标一律
//     `metric_not_declared`），回归重放必须显式装配它，不能默认空集。
//   · 但 B1（三同纪律，`scripts/lint-architecture.mjs`）**禁止 `modules/<id>/` 引用
//     `platform.*` 物理表**——门禁自己的反例就是 `select id from platform.tenant`。
//   · 宿主在请求路径上把 `TENANT_SOURCES` 投影给模块；回归 CLI 没有请求上下文，拿不到投影，
//     只能自己读。那是**平台侧**动作（平台代码的合法 schema 就是 platform），故落在这里，
//     由脚本解析后把值注入 `runRegression`。
//
// SQL 口径与宿主 `apps/server/src/tenant-source.ts` 一致（`SOURCES_ENABLED_SQL`）：
// 只认 `enabled = true`，停用行保留在表里但不属于「已接入」。

export interface TenantSourceExecutor {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

/**
 * `org`（= `platform.tenant.casdoor_org`）→ tenant_id → `enabled = true` 的源集合。
 *
 * 未知租户（`casdoor_org` 无行）⇒ **抛错**：那是配置错误（`--org` 打错），不是「零接入源」。
 * 静默退化成空集只会让 CLI 报出一片与真相无关的红（所有指标都被裁成未声明）。
 */
export async function loadAdoptedSources(
  exec: TenantSourceExecutor,
  org: string,
): Promise<ReadonlySet<string>> {
  const tenant = await exec.query(
    'select id from platform.tenant where casdoor_org = $1',
    [org],
  )
  const tenantId = tenant.rows[0]?.id
  if (tenantId === undefined || tenantId === null) {
    throw new Error(`loadAdoptedSources: 未知租户 org='${org}'（platform.tenant.casdoor_org 无此行）`)
  }
  const sources = await exec.query(
    'select source from platform.tenant_source where tenant_id = $1 and enabled = true order by source',
    [tenantId],
  )
  return new Set(sources.rows.map((r) => String(r.source)))
}
