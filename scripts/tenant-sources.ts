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
// **SQL 不在本文件**：`platform.tenant` / `platform.tenant_source` 的查询唯一事实源是
// `apps/server/src/tenant-source.ts`（头注写明了理由：各写一份 ⇒ 改列名漏一处 = 运行时
// 500 / CLI 直接崩）。本文件只编排，复用 `resolveTenantIdByOrg` + `listEnabledSources`。
import {
  listEnabledSources,
  resolveTenantIdByOrg,
  type SqlExecutor,
} from '../apps/server/src/tenant-source.ts'

export type { SqlExecutor }

/**
 * `casdoor_org` 解析不到平台租户。**类型化**是刻意的：摄入侧要靠它区分
 * 「这条事件不属于本平台」与「数据库/链路坏了」——前者跳过该条，后者必须炸整轮
 * （静默跳过会让水位越过没处理的数据）。不要再靠错误文案匹配判类。
 */
export class UnknownTenantError extends Error {
  readonly code = 'UNKNOWN_TENANT' as const
  constructor(org: string) {
    super(`loadAdoptedSources: 未知租户 org='${org}'（platform.tenant.casdoor_org 无此行）`)
    this.name = 'UnknownTenantError'
  }
}

/** 判定未知租户错误（兼容带 `code='UNKNOWN_TENANT'` 的等价错误对象，文案可变、行为不变）。 */
export function isUnknownTenantError(e: unknown): e is UnknownTenantError {
  if (e instanceof UnknownTenantError) return true
  return typeof e === 'object' && e !== null && 'code' in e
    && (/** @type {{code?: unknown}} */ (e)).code === 'UNKNOWN_TENANT'
}

/**
 * `org`（= `platform.tenant.casdoor_org`）→ tenant_id → `enabled = true` 的源集合。
 *
 * 未知租户（`casdoor_org` 无行）⇒ **抛 `UnknownTenantError`**：那是配置错误（`--org` 打错），
 * 不是「零接入源」。静默退化成空集只会让 CLI 报出一片与真相无关的红（所有指标都被裁成未声明）。
 */
export async function loadAdoptedSources(
  exec: SqlExecutor,
  org: string,
): Promise<ReadonlySet<string>> {
  const tenantId = await resolveTenantIdByOrg(exec, org)
  if (tenantId === null) throw new UnknownTenantError(org)
  return new Set(await listEnabledSources(exec, tenantId))
}
