// dimension-labels.ts — 维度名称解析（issue #857）
//
// ── 为什么要有这一层 ──────────────────────────────────────────────────────────────
// **事实表只存键**（`system_book` / `branch_num` / …），名称是**维度属性**。业务问「某店昨天净额」，
// 回一个 `branch_num=142` 等于没回；账套回 `3120` 而不是「熊喵鲜生」同理。
//
// 行业口径（Kimball 维度建模 + 语义层）：键进事实、名称进维度、**谁做展示谁在查询时解析**。
// 下游消费方（问数 bot / 报表）**只负责排版**，不维护任何 ID→名称表 —— 否则新开门店永远追不上、
// 每租户一套配置、且没有任何测试能拦住它过期。
//
// ── 为什么不在指标的 select_sql 里 join ───────────────────────────────────────────
// 那会让**可加性失真**：同一单号按行重复带名称 ⇒ 合计翻倍；`args.total` 的自动合计也会跟着错。
// 名称是展示属性，只该在回包最后一步贴。
//
// ── 失败语义 ────────────────────────────────────────────────────────────────────
// 维度表缺席 / 查询失败 ⇒ **名称列缺席**，主查询结果照常交付（与新鲜度面同一姿态：
// 「名称未知 ≠ 捏造名称」，且缺账绝不反噬主查询）。

/** 一次查询内可用的维度快照（三张小表，量级几百行，随查随取）。 */
export interface DimensionLookup {
  /** 账套 → 品牌名（`dim_brand` seed）。 */
  brandByBook: Map<string, string>
  /** `` `${账套}|${门店号}` `` → 门店名（`stg_lemeng_branch` 最新快照）。 */
  branchNameByKey: Map<string, string>
  /** `` `${账套}|${战区号}` `` → 战区名称 + 一级战区（`x01_region_names` seed）。 */
  regionByKey: Map<string, { name: string; l1: string | null }>
}

/** 键列 → 紧跟其后插入的标签列。顺序即插入顺序。 */
const LABELS_OF_KEY: Readonly<Record<string, readonly string[]>> = {
  system_book: ['brand_name'],
  branch_num: ['branch_name'],
  region_id: ['region_name', 'region_l1'],
}

/** 维度侧用于查门店名的 SQL：**按门店取最新快照**（今天改名/新开店都跟着走），只取需要的三列。 */
const BRANCH_NAME_SQL = `
  select system_book::varchar as b, branch_num::int as n, name
  from (
    select system_book, branch_num, name,
           row_number() over (partition by system_book, branch_num order by snapshot desc) rn
    from stg_lemeng_branch
  ) t
  where rn = 1`

const BRAND_NAME_SQL = 'select system_book::varchar as b, brand_name from dim_brand'

/**
 * 战区名称（`x01_region_names` seed，git 受控）。
 * ⚠️ 键必须带 `system_book`：两个账套**都有**「中部一区」这类同名战区，id 空间不相交，
 * 只按 region_id 关联会串账套。`region_l1` 为空 = 不归属四向的杂项组（schema.yml 有依据），
 * 原样给 `null`，**不拿二级名字截字符串去编**。
 */
const REGION_NAME_SQL =
  'select system_book::varchar as b, region_id::int as r, region_name, region_l1 from x01_region_names'

/** 执行器形状（与 `runWarehouseSql` 一致；测试可注入）。 */
type Exec = (sql: string) => Promise<{ columns: string[]; rows: unknown[][] }>

/**
 * 从仓库取维度快照。任一维度取不到 ⇒ 返回 `null`（调用方据此**不加**名称列）。
 *
 * 两张表都是**小表**（品牌 2 行、门店 400 行级），逐查现取即可，不引入缓存 —— 缓存会带来
 * 「新开店/改名要等缓存过期」的隐形延迟，而这里的代价是两次索引小查询。
 */
export async function loadDimensionLookup(exec: Exec): Promise<DimensionLookup | null> {
  try {
    const [brand, branch, region] = await Promise.all([
      exec(BRAND_NAME_SQL),
      exec(BRANCH_NAME_SQL),
      exec(REGION_NAME_SQL),
    ])
    const brandByBook = new Map<string, string>()
    for (const row of brand.rows) {
      const book = row[0]
      const name = row[1]
      if (typeof book === 'string' && typeof name === 'string') brandByBook.set(book, name)
    }
    const branchNameByKey = new Map<string, string>()
    for (const row of branch.rows) {
      const book = row[0]
      const branchNum = row[1]
      const name = row[2]
      if (typeof book === 'string' && branchNum != null && typeof name === 'string') {
        branchNameByKey.set(`${book}|${String(branchNum)}`, name)
      }
    }
    const regionByKey = new Map<string, { name: string; l1: string | null }>()
    for (const row of region.rows) {
      const book = row[0]
      const regionId = row[1]
      const name = row[2]
      const l1 = row[3]
      if (typeof book === 'string' && regionId != null && typeof name === 'string') {
        regionByKey.set(`${book}|${String(regionId)}`, {
          name,
          l1: typeof l1 === 'string' && l1 !== '' ? l1 : null,
        })
      }
    }
    return { brandByBook, branchNameByKey, regionByKey }
  } catch {
    return null
  }
}

/**
 * 把标签列**插在对应键列之后**（原 key 保留：可追溯、可下钻）。
 *
 * - 结果里没有任何已知键列 ⇒ 原样返回（`total` 形态的单行 `['total']` 就属于这类）；
 * - 键存在但维度里查不到（新店未进维表 / 账套未登记品牌）⇒ 该格为 `null`，**不猜**。
 */
export function decorateWithLabels(
  result: { columns: string[]; rows: unknown[][] },
  lookup: DimensionLookup,
): { columns: string[]; rows: unknown[][] } {
  const hasKey = result.columns.some((c) => c in LABELS_OF_KEY)
  if (!hasKey) return result

  const columns: string[] = []
  for (const c of result.columns) {
    columns.push(c)
    for (const label of LABELS_OF_KEY[c] ?? []) columns.push(label)
  }

  const bookIdx = result.columns.indexOf('system_book')
  const branchIdx = result.columns.indexOf('branch_num')
  const regionIdx = result.columns.indexOf('region_id')

  const rows = result.rows.map((row) => {
    const book = bookIdx >= 0 && row[bookIdx] != null ? String(row[bookIdx]) : ''
    const branchKey = branchIdx >= 0 && row[branchIdx] != null ? `${book}|${String(row[branchIdx])}` : null
    const region = regionIdx >= 0 && row[regionIdx] != null
      ? lookup.regionByKey.get(`${book}|${String(row[regionIdx])}`)
      : undefined
    const out: unknown[] = []
    for (let i = 0; i < result.columns.length; i++) {
      out.push(row[i])
      const col = result.columns[i]
      if (col === 'system_book') out.push(lookup.brandByBook.get(book) ?? null)
      else if (col === 'branch_num') out.push(branchKey === null ? null : (lookup.branchNameByKey.get(branchKey) ?? null))
      else if (col === 'region_id') {
        out.push(region?.name ?? null)
        out.push(region?.l1 ?? null)
      }
    }
    return out
  })

  return { columns, rows }
}
