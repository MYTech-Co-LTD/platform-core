// all.ts —— 分析师面 impl 的**显式注册点**（/mcp 装配唯一入口）+ ToolboxDeps **唯一装配工厂**。
// registry.ts 保持纯（CI 门与 e2e 直接 import 它）；impl 在这里逐个 registerImpl——
// 重复注册即抛（registry 的契约），本模块只被 mcp.ts import 一次。
import type { Pool } from 'pg'
import { registerImpl, mutatingAllowed, type ToolboxDeps } from './registry'
import { guideImpl, harnessCatalogImpl } from './guide'
import { searchImpl, describeMetricImpl, describeDatasetImpl, sampleDimensionValuesImpl } from './discovery'
import { defaultDbtManifest, freshnessImpl, qualityImpl, lineageImpl } from './health'
import { previewImpl, queryMetricImpl } from './query'
import { analystPool, runWarehouseSql } from '../warehouse'
import type { SqlExecutor } from '../query-service'
import type { Requester } from '../authz'

registerImpl('data_agent_guide', guideImpl)
registerImpl('data_harness_catalog', harnessCatalogImpl)
registerImpl('search_catalog', searchImpl)
registerImpl('describe_metric', describeMetricImpl)
registerImpl('describe_dataset', describeDatasetImpl)
registerImpl('sample_dimension_values', sampleDimensionValuesImpl)
registerImpl('get_freshness', freshnessImpl)
registerImpl('get_quality', qualityImpl)
registerImpl('get_lineage', lineageImpl)
registerImpl('preview_query', previewImpl)
registerImpl('query_metric', queryMetricImpl)

// ── ToolboxDeps 唯一装配点（Wave 2 决策 D-M1）────────────────────────────────────────────
export interface ToolboxBase {
  pool: Pool
  org: string
  requester: Requester | null
  adoptedSources: ReadonlySet<string>
}
export interface ToolboxWiring {
  /** 测试注入的仓库执行器；缺省 = 只读池（analystPool，default_transaction_read_only=on）。 */
  wh?: SqlExecutor
  /** env 覆盖（测试确定性）；缺省 process.env。 */
  env?: Record<string, string | undefined>
}

/**
 * ToolboxDeps 的**唯一装配工厂**：/mcp、POST /toolbox、agent-loop 三处共用，各写一份
 * `{pool, org, requester, adoptedSources, wh, dbtManifest, allowMutating}` 必漂。
 * ⚠️ 只能住在本文件——registry.ts 是 CI 门（check-mcp-toolface）的 import 对象，必须保持纯
 * （不拉 warehouse/pg）；本文件本来就是 impl 注册点，多背一个工厂不破坏任何纯性约定。
 */
export function buildToolboxDeps(base: ToolboxBase, wiring: ToolboxWiring = {}): ToolboxDeps {
  const wh: SqlExecutor = wiring.wh ?? ((sql) => runWarehouseSql(analystPool(), sql))
  return {
    pool: base.pool,
    org: base.org,
    requester: base.requester,
    adoptedSources: base.adoptedSources,
    wh,
    dbtManifest: defaultDbtManifest(),
    allowMutating: mutatingAllowed(wiring.env ?? process.env),
  }
}
