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
  /** 仅 marts 的聚合度量：聚合表达式中引用到的 staging 列名（用来画连线）。 */
  inputs?: string[]
  /** 仅 marts 的聚合度量：它由哪些度量组合而来（net_amount = sale_amount − return_amount）。 */
  dependsOn?: string[]
  /** staging SQL 里有、schema.yml 没写文档的列（描述退回契约）。 */
  undocumented?: boolean
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
  staging: { model: string | null; columns: LineageColumnDoc[]; sqlColumns?: readonly string[] }
  marts: { model: string | null; columns: LineageColumnDoc[] }
  /** 聚合度量 → 它用到的 staging 列（由 marts SQL 解出；缺省 = 不知道）。 */
  martsInputs?: Readonly<Record<string, readonly string[]>>
  /** 聚合度量 → 它组合的其它度量（度量之间的依赖，缺省 = 不知道）。 */
  martsDeps?: Readonly<Record<string, readonly string[]>>
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
  const sqlCols = input.staging.sqlColumns ?? []
  // 「本层有没有这一列」以 **staging SQL 为准**（schema.yml 的列文档可能漏写：
  // 2026-11-15 实测 `order_total_money` 在 SQL 与契约里都有、却不在 schema.yml ⇒ 页面曾误判成「被丢掉」）。
  const stgNames = new Set([...input.staging.columns.map((c) => c.name), ...sqlCols])
  // 显示也要跟上：SQL 有、文档缺的列补出来（类型/描述退回源契约），否则页面上会「凭空少一列」，
  // 而 marts 的度量恰好用它 ⇒ 聚焦时这条链就断了。
  const documented = new Set(input.staging.columns.map((c) => c.name))
  const extras: LineageColumn[] = sqlCols
    // 只补「契约里确有此列」的：staging 的列就是契约列，SQL 扫出来的别的一律不认
    // （2026-11-15 实测 `cast(x as colname)` / `cast(y as varchar)` 会混进来）。
    .filter((name) => !documented.has(name) && srcNames.has(name))
    .map((name) => {
      const fromContract = srcCols.find((c) => c.name === name)
      return {
        name,
        ...(fromContract?.type === undefined ? {} : { type: fromContract.type }),
        description: plainDescription(fromContract?.description),
        status: 'passthrough' as const,
        undocumented: true,
      }
    })
  const hasStaging = input.staging.columns.length > 0 || extras.length > 0
  const hasMarts = input.marts.columns.length > 0

  const source: LineageColumn[] = srcCols.map((c) => ({
    name: c.name,
    ...(c.type === undefined ? {} : { type: c.type }),
    description: plainDescription(c.description),
    // 有 staging 才能判「这一列在下一层被丢掉」；没声明就一律按直通展示
    status: hasStaging && !stgNames.has(c.name) ? 'dropped' : 'passthrough',
  }))

  const staging: LineageColumn[] = [
    ...input.staging.columns.map((c) => ({
      name: c.name,
      ...(c.type === undefined ? {} : { type: c.type }),
      description: plainDescription(c.description),
      status: (srcNames.size > 0 && !srcNames.has(c.name) ? 'added' : 'passthrough') as LineageColumnStatus,
    })),
    ...extras,
  ]

  const marts: LineageColumn[] = input.marts.columns.map((c) => ({
    name: c.name,
    ...(c.type === undefined ? {} : { type: c.type }),
    description: plainDescription(c.description),
    // 与 staging 同名的列 = 键/直通；其余 = 聚合出来的度量
    status: stgNames.has(c.name) ? 'passthrough' : 'aggregate',
    ...(input.martsInputs?.[c.name] === undefined ? {} : { inputs: [...input.martsInputs[c.name]!] }),
    ...(input.martsDeps?.[c.name] === undefined ? {} : { dependsOn: [...input.martsDeps[c.name]!] }),
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
