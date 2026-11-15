// focus.ts — 「点一个字段，它的整条路在哪」的纯计算。
//
// 页面只负责把结果画出来：哪些列高亮、哪几层展开、哪两个列之间要连线。
// 纯函数 ⇒ 单测直接喂数据，不用起 DOM。

export interface FocusColumn {
  name: string
  status: 'passthrough' | 'dropped' | 'added' | 'aggregate'
  inputs?: string[]
  dependsOn?: string[]
}

export interface FocusStage {
  columns: readonly FocusColumn[]
  /** 这一层在湖里的落点（分区键） */
  partitions?: readonly string[]
}

export interface FocusInput {
  source: FocusStage
  staging: FocusStage
  marts: FocusStage
}

export interface FocusModel {
  name: string
  /** 点的是聚合度量（反向看来源），否则是字段（前向看去向） */
  reverse: boolean
  /** 每层高亮的列名 */
  source: ReadonlySet<string>
  staging: ReadonlySet<string>
  marts: ReadonlySet<string>
  /** staging 列 → 聚合度量（前向的扇入；反向时是输入列 → 被点的度量） */
  links: ReadonlyArray<readonly [string, string]>
  /** 度量 → 度量（net_amount = sale_amount − return_amount） */
  deps: ReadonlyArray<readonly [string, string]>
  /** 需要高亮的湖分区键 */
  partitions: ReadonlySet<string>
}

const isMeasure = (c: FocusColumn | undefined): boolean => c?.status === 'aggregate'

/** 点某个字段（或度量）后，整条链路上相关的列集合。 */
export function buildFocus(name: string, input: FocusInput): FocusModel | null {
  const srcByName = new Map(input.source.columns.map((c) => [c.name, c]))
  const stgByName = new Map(input.staging.columns.map((c) => [c.name, c]))
  const martByName = new Map(input.marts.columns.map((c) => [c.name, c]))
  const picked = martByName.get(name) ?? stgByName.get(name) ?? srcByName.get(name)
  if (picked === undefined) return null

  const src = new Set<string>()
  const stg = new Set<string>()
  const mart = new Set<string>()
  const links: Array<readonly [string, string]> = []
  const deps: Array<readonly [string, string]> = []

  if (isMeasure(picked)) {
    mart.add(name)
    for (const col of picked.inputs ?? []) {
      if (!stgByName.has(col)) continue
      stg.add(col)
      links.push([col, name])
      if (srcByName.has(col)) src.add(col)
    }
    for (const dep of picked.dependsOn ?? []) {
      if (martByName.has(dep)) deps.push([dep, name])
    }
    // 依赖的度量本身也是这条链的一环
    for (const pred of picked.dependsOn ?? []) if (martByName.has(pred)) mart.add(pred)
  } else {
    if (srcByName.has(name)) src.add(name)
    if (stgByName.has(name)) stg.add(name)
    if (martByName.has(name)) mart.add(name)
    for (const col of input.marts.columns) {
      if (!isMeasure(col)) continue
      if (!(col.inputs ?? []).includes(name)) continue
      mart.add(col.name)
      links.push([name, col.name])
    }
  }

  const partitions = new Set(
    (input.staging.partitions ?? []).filter((p) => src.has(p) || stg.has(p) || mart.has(p)),
  )

  return Object.freeze({
    name,
    reverse: isMeasure(picked),
    source: src,
    staging: stg,
    marts: mart,
    links,
    deps,
    partitions,
  })
}

export interface WindowSlice {
  /** 可见列在整层里的下标（顺序与原始列一致） */
  visible: ReadonlySet<number>
  /** 折叠段：插在第 index 个列之前的占位 */
  gaps: ReadonlyArray<{ before: number; count: number }>
}

/**
 * 聚焦时的「开窗」：只保留命中列上下各 radius 行，其余折成「⋯ 还有 N 列」。
 * 25 列全摊开会把目标顶出画布，窗口让视觉重心始终落在路径上。
 */
export function windowOf(total: number, hits: ReadonlySet<number>, radius = 3): WindowSlice {
  if (hits.size === 0) return { visible: new Set(), gaps: [] }
  const visible = new Set<number>()
  for (const i of hits) {
    for (let j = i - radius; j <= i + radius; j += 1) if (j >= 0 && j < total) visible.add(j)
  }
  if (visible.size === total) return { visible, gaps: [] }
  const gaps: Array<{ before: number; count: number }> = []
  let run = 0
  for (let i = 0; i < total; i += 1) {
    if (visible.has(i)) {
      if (run > 0) { gaps.push({ before: i, count: run }); run = 0 }
    } else run += 1
  }
  if (run > 0) gaps.push({ before: total, count: run })
  return { visible, gaps }
}
