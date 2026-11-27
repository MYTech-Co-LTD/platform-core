// brand.ts — 提单时的品牌 / 门店等级解析（issue #2892 / #2924）。
//
// 数据源是 data 模块发布的稳定视图（跨模块只读，manifest `dataDependencies` 已声明）：
//   · 品牌：product 级覆盖 `data.v_brand_assignment` > 门店画像 `data.v_store_profile` > 未分类；
//   · 等级：门店画像 `data.v_store_profile` > 未分级（没有商品级等级）。
//
// **失败姿态：fail-open**。品牌/等级是分类/筛选维度，不是金额也不是交易前置条件——视图缺失、
// 数据模块迁移未跑、查询报错，都只让这张单变成「未分类/未分级」，绝不能阻断售后提单。
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

export interface ResolvedStoreLevel {
  code: string
  name: string
  /** 映射来源：manual | ...；未分级 = 'unavailable' */
  source: string
}

const UNCLASSIFIED: ResolvedBrand = { code: '', name: '', source: 'unavailable', origin: '' }
const UNLEVELED: ResolvedStoreLevel = { code: '', name: '', source: 'unavailable' }

/**
 * 解析品牌。`db` 可以传事务 client（提单）或 pool（其他场景）——只读，不写。
 *
 * product 优先于 store；停用的字典品牌不参与新单解析（历史工单仍可按快照筛选）。
 * 门店品牌来自 `v_store_profile`，只在该门店品牌仍在启用字典里时生效。
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
      `select 'product'::text as source, a.brand_code, a.brand_name, a.source as origin
         from data.v_brand_assignment a
        where a.org = $1
          and a.subject_type = 'product'
          and a.subject_code = $2
          and a.brand_enabled = true
       union all
       select 'store'::text, p.brand_code, r.name, p.brand_source
         from data.v_store_profile p
         join data.v_brand_registry r
           on r.org = p.org and r.code = p.brand_code
        where p.org = $1
          and p.store_code = $3
          and p.brand_code is not null
          and r.enabled = true
       limit 1`,
      [org, productCode, storeCode],
    )) as { rows: { source: string; brand_code: string; brand_name: string | null; origin: string }[] }
    const row = res.rows[0]
    if (!row) return UNCLASSIFIED
    return {
      code: row.brand_code,
      name: row.brand_name ?? '',
      source: row.source === 'product' ? 'product' : 'store',
      origin: row.origin,
    }
  } catch (e) {
    // fail-open：品牌解析失败不阻断提单；warn 是这条路径的唯一信号。
    console.warn('[aftersales] 品牌解析失败（按未分类继续，不阻断提单）:', e instanceof Error ? e.message : e)
    return UNCLASSIFIED
  }
}

/** 解析门店等级。没有商品级等级；只读门店画像。 */
export async function resolveStoreLevel(
  db: Queryable,
  org: string,
  storeCode: string,
): Promise<ResolvedStoreLevel> {
  if (!storeCode) return UNLEVELED
  try {
    const res = (await db.query(
      `select p.level_code, lr.name as level_name, p.level_source
         from data.v_store_profile p
         join data.v_store_level_registry lr
           on lr.org = p.org and lr.code = p.level_code
        where p.org = $1
          and p.store_code = $2
          and p.level_code is not null
          and lr.enabled = true
        limit 1`,
      [org, storeCode],
    )) as { rows: { level_code: string; level_name: string | null; level_source: string }[] }
    const row = res.rows[0]
    if (!row) return UNLEVELED
    return {
      code: row.level_code,
      name: row.level_name ?? '',
      source: row.level_source || 'manual',
    }
  } catch (e) {
    console.warn('[aftersales] 门店等级解析失败（按未分级继续，不阻断提单）:', e instanceof Error ? e.message : e)
    return UNLEVELED
  }
}
