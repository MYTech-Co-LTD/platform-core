// all.ts —— 分析师面 impl 的**显式注册点**（/mcp 装配唯一入口）。
// registry.ts 保持纯（CI 门与 e2e 直接 import 它）；impl 在这里逐个 registerImpl——
// 重复注册即抛（registry 的契约），本模块只被 mcp.ts import 一次。
import { registerImpl } from './registry'
import { guideImpl, harnessCatalogImpl } from './guide'
import { searchImpl, describeMetricImpl, describeDatasetImpl, sampleDimensionValuesImpl } from './discovery'
import { freshnessImpl, qualityImpl, lineageImpl } from './health'
import { previewImpl, queryMetricImpl } from './query'

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
