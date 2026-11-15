// lineage.ts — 指标级「数据生产线」：源接口 → 湖（落盘形态）→ staging → marts，字段级。
//
// 与 trail.ts 的分工：trail 只给链路骨架（指标 → 表 → 湖 → 管线）；本文件把**字段**摊开，
// 让人看清每一步加工了什么：哪列直通、哪列被丢掉、哪列是 dbt 注入的、哪列是聚合出来的度量。
//
// 纯函数：字段清单与描述由路由层从仓内声明（契约 JSON / dbt schema.yml）读出后传进来。
// 不做「源字段 → 度量」的精确血缘推断（那需要人工映射表），只按同名判定直通，其余标聚合。

export type LineageColumnStatus = 'passthrough' | 'dropped' | 'added' | 'aggregate'

export interface LineageColumn {
  name: string
  type?: string
  description: string
  status: LineageColumnStatus
}

export interface LineageLake {
  /** 湖前缀，如 `lemeng/retail_order_line` */
  prefix: string
  /** 分区键（顺序即路径顺序） */
  partitions: string[]
  /** 文件名形态（如 `all.parquet`） */
  fileName: string
  /** `hive` / `flat` */
  partitionStyle: string
}

export interface MetricLineage {
  metricId: string
  title: string
  source: { contractId: string | null; columns: LineageColumn[] }
  lake: LineageLake | null
  staging: { model: string | null; columns: LineageColumn[] }
  marts: { model: string | null; columns: LineageColumn[] }
  /** 缺声明时的说明（缺席 ≠ 没这一层） */
  notes: string[]
}

export interface LineageColumnDoc {
  name: string
  type?: string
  description?: string
}

export interface LineageInput {
  metricId: string
  title: string
  contract: {
    id: string
    /** 契约 columns（源/湖层的事实源） */
    columns: LineageColumnDoc[]
    layout?: { prefix?: string; partitionBy?: string[]; fileName?: string; partitionStyle?: string }
  } | null
  staging: { model: string | null; columns: LineageColumnDoc[] }
  marts: { model: string | null; columns: LineageColumnDoc[] }
}

/** 描述里常有 markdown 粗体与换行——默认层要的是「一句人话」，清掉记号并收敛空白。 */
export function plainDescription(raw: string | undefined): string {
  if (raw === undefined) return ''
  return raw
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function buildMetricLineage(input: LineageInput): MetricLineage {
  const notes: string[] = []
  const srcCols = input.contract?.columns ?? []
  const srcNames = new Set(srcCols.map((c) => c.name))
  const stgNames = new Set(input.staging.columns.map((c) => c.name))
  const hasStaging = input.staging.columns.length > 0
  const hasMarts = input.marts.columns.length > 0

  const source: LineageColumn[] = srcCols.map((c) => ({
    name: c.name,
    ...(c.type === undefined ? {} : { type: c.type }),
    description: plainDescription(c.description),
    // 有 staging 才能判「这一列在下一层被丢掉」；没声明就一律按直通展示
    status: hasStaging && !stgNames.has(c.name) ? 'dropped' : 'passthrough',
  }))

  const staging: LineageColumn[] = input.staging.columns.map((c) => ({
    name: c.name,
    ...(c.type === undefined ? {} : { type: c.type }),
    description: plainDescription(c.description),
    status: srcNames.size > 0 && !srcNames.has(c.name) ? 'added' : 'passthrough',
  }))

  const marts: LineageColumn[] = input.marts.columns.map((c) => ({
    name: c.name,
    ...(c.type === undefined ? {} : { type: c.type }),
    description: plainDescription(c.description),
    // 与 staging 同名的列 = 键/直通；其余 = 聚合出来的度量
    status: stgNames.has(c.name) ? 'passthrough' : 'aggregate',
  }))

  const layout = input.contract?.layout
  const lake: LineageLake | null = layout?.prefix === undefined
    ? null
    : {
        prefix: layout.prefix,
        partitions: layout.partitionBy ?? [],
        fileName: layout.fileName ?? 'all.parquet',
        partitionStyle: layout.partitionStyle ?? 'hive',
      }

  if (input.contract === null) notes.push('没有找到对应的源契约——源层字段清单缺席（未知 ≠ 没有）')
  if (!hasStaging) notes.push('staging 列未在 schema.yml 里声明——这一层只显示链路、不显示字段')
  if (!hasMarts) notes.push('marts 列未在 schema.yml 里声明——这一层只显示链路、不显示字段')

  return {
    metricId: input.metricId,
    title: input.title,
    source: { contractId: input.contract?.id ?? null, columns: source },
    lake,
    staging: { model: input.staging.model, columns: staging },
    marts: { model: input.marts.model, columns: marts },
    notes,
  }
}
