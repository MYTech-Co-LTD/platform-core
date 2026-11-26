// brand.ts — 提单时的品牌解析（issue #2892）。
//
// 数据源是 data 模块发布的稳定视图 `data.v_brand_assignment`（跨模块只读，manifest
// `dataDependencies` 已声明）。解析顺序固定：product 分配 > store 分配 > 未分类。
//
// **失败姿态：fail-open**。品牌是分类/筛选维度，不是金额也不是交易前置条件——视图缺失、
// 数据模块迁移未跑、查询报错，都只让这张单变成「未分类」，绝不能阻断售后提单。
// 但必须打 warn（监控据此告警），否则未分类会静默变成常态。
import type { Queryable } from './audit'

export const BRAND_SOURCE = {
  product: 'product',
  store: 'store',
  unavailable: 'unavailable',
} as const

export interface ResolvedBrand {
  code: string
  name: string
  /** 解析层：product | store | unavailable */
  source: 'product' | 'store' | 'unavailable'
  /** 映射来源：source_field | book | mapping | prefix | manual | backfill | '' */
  origin: string
}

const UNCLASSIFIED: ResolvedBrand = { code: '', name: '', source: 'unavailable', origin: '' }

/**
 * 解析品牌。`db` 可以传事务 client（提单）或 pool（其他场景）——只读，不写。
 *
 * SQL 的 order by 是解析优先级的唯一实现：product=0 / store=1。`brand_enabled=false` 的
 * 历史品牌不参与新单解析（但仍留在视图里供历史工单筛选）。
 */
export async function resolveBrand(
  db: Queryable,
  org: string,
  productCode: string,
  storeCode: string,
): Promise<ResolvedBrand> {
  if (!productCode && !storeCode) return UNCLASSIFIED
  try {
    const res = (await db.query(
      `select subject_type, brand_code, brand_name, source
         from data.v_brand_assignment
        where org = $1
          and brand_enabled = true
          and ((subject_type = 'product' and subject_code = $2)
            or (subject_type = 'store'   and subject_code = $3))
        order by case subject_type when 'product' then 0 else 1 end
        limit 1`,
      [org, productCode, storeCode],
    )) as { rows: { subject_type: string; brand_code: string; brand_name: string | null; source: string }[] }
    const row = res.rows[0]
    if (!row) return UNCLASSIFIED
    return {
      code: row.brand_code,
      name: row.brand_name ?? '',
      source: row.subject_type === 'product' ? 'product' : 'store',
      origin: row.source,
    }
  } catch (e) {
    // fail-open：品牌解析失败不阻断提单；warn 是这条路径的唯一信号。
    console.warn('[aftersales] 品牌解析失败（按未分类继续，不阻断提单）:', e instanceof Error ? e.message : e)
    return UNCLASSIFIED
  }
}
