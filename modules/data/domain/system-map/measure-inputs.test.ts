import { describe, expect, it } from 'vitest'
import { resolveMeasureInputs } from './measure-inputs'

// 取自 dbt/models/lemeng/marts/fct_retail_sale.sql 的真实结构（裁剪掉无关列）：
// - sale_amount / return_amount 有各自的 `__gen` 块 + `__rollup`；
// - net_amount 只出现在最终 select（sale_amount__gen − return_amount__gen）；
// - order_count 走 order_count_cte → base_sale 两层 CTE，最终 select 里只是 coalesce(...)。
const SQL = `
{{
    config(materialized='table', enabled=env_var('MAT_ENABLED', 'true'))
}}
with base_sale as (
    select * from {{ ref('stg_lemeng_retail_order_line') }}
    where state = 'FINISHED' and order_transaction_type = 'SALE_ORDER'
    {% if is_incremental() %}
    and bizday >= {{ incremental_cutoff(7) }}
    {% endif %}
),
sale_amount__gen as (
    select system_book, bizday, branch_num, order_no,
      (sum(case when state = 'FINISHED' then sale_money end)
       - sum(case when discount_money > 0 then discount_money else 0 end)) as measure_value
    from base_sale group by system_book, bizday, branch_num, order_no
),
return_amount__gen as (
    select system_book, bizday, branch_num, order_no, order_detail_num,
      (sum(case when order_transaction_type like '%RETURN%'
           then sale_money + order_detail_share_discount else 0 end)) as measure_value
    from base_return group by system_book, bizday, branch_num, order_no, order_detail_num
),
sale_amount__rollup as (
    select system_book, bizday, branch_num, sum(sale_amount__gen.measure_value) as sale_amount__gen
    from sale_amount__gen group by 1, 2, 3
),
return_amount__rollup as (
    select system_book, bizday, branch_num, sum(return_amount__gen.measure_value) as return_amount__gen
    from return_amount__gen group by 1, 2, 3
),
gen_agg as (
    select coalesce(sale_amount__rollup.system_book, return_amount__rollup.system_book) as system_book,
           coalesce(sale_amount__rollup.bizday, return_amount__rollup.bizday) as bizday,
           sale_amount__rollup.sale_amount__gen,
           return_amount__rollup.return_amount__gen
    from sale_amount__rollup full join return_amount__rollup on 1 = 1
),
order_count_cte as (
    select system_book, bizday, branch_num, count(distinct order_no) as order_count
    from base_sale group by 1, 2, 3
)
select
    gen_agg.system_book,
    gen_agg.bizday,
    gen_agg.branch_num,
    coalesce(gen_agg.sale_amount__gen, 0)::numeric(20,2)   as sale_amount,
    coalesce(gen_agg.return_amount__gen, 0)::numeric(20,2) as return_amount,
    (coalesce(gen_agg.sale_amount__gen, 0)
     - coalesce(gen_agg.return_amount__gen, 0))::numeric(20,2) as net_amount,
    coalesce(order_count_cte.order_count, 0)               as order_count
from gen_agg
left join order_count_cte on gen_agg.system_book = order_count_cte.system_book
`

const STAGING = [
  'system_book', 'org', 'bizday', 'branch_num', 'order_no', 'order_detail_num',
  'state', 'order_transaction_type', 'sale_money', 'discount_money', 'order_detail_share_discount',
]
const GRAIN = ['system_book', 'org', 'bizday', 'branch_num']

const opts = { measures: ['sale_amount', 'return_amount', 'net_amount', 'order_count'], stagingColumns: STAGING, exclude: GRAIN }

describe('resolveMeasureInputs', () => {
  it('有 __gen 块的度量：取块里 select/聚合表达式中的列（WHERE 里的过滤列不算）', () => {
    const r = resolveMeasureInputs(SQL, opts)
    // state 在 case 里（口径条件的一部分，算来源）；order_transaction_type 只在 base_sale 的 where 里 ⇒ 不算
    expect(r.inputs.sale_amount).toEqual(['state', 'sale_money', 'discount_money'])
    // order_no / order_detail_num 只出现在 group by —— 是粒度不是来源，被剥掉
    expect(r.inputs.return_amount).toEqual(['order_transaction_type', 'sale_money', 'order_detail_share_discount'])
  })

  it('net_amount（只写在最终 select）：解成度量依赖 + 输入并集', () => {
    const r = resolveMeasureInputs(SQL, opts)
    expect(r.deps.net_amount?.sort()).toEqual(['return_amount', 'sale_amount'])
    expect(r.inputs.net_amount).toEqual([
      'state', 'order_transaction_type', 'sale_money', 'discount_money', 'order_detail_share_discount',
    ])
  })

  it('order_count（走两级 CTE）：解出 count(distinct order_no)；基面 WHERE 的列不算来源', () => {
    const r = resolveMeasureInputs(SQL, opts)
    // base_sale 的 where（state / order_transaction_type）是过滤条件，不是被聚合的值
    expect(r.inputs.order_count).toEqual(['order_no'])
    expect(r.deps.order_count).toBeUndefined()
  })

  it('只出现在 WHERE 里的列不算输入（hour 曾被窗口守卫带进来）', () => {
    const sql = `
with base as (
    select * from stg_lemeng_retail_order_line
    where state = 'FINISHED'
      and not (bizday = current_date and hour >= extract(hour from current_timestamp))
),
amount__gen as (
    select system_book, bizday, branch_num, sum(sale_money) as measure_value
    from base group by system_book, bizday, branch_num
)
select coalesce(amount__gen.measure_value, 0) as amount from amount__gen
`
    const r = resolveMeasureInputs(sql, { measures: ['amount'], stagingColumns: STAGING, exclude: GRAIN })
    expect(r.inputs.amount).toEqual(['sale_money'])
    expect(r.inputs.amount).not.toContain('hour')
    expect(r.inputs.amount).not.toContain('state')
  })

  it('粒度键不作为「值来源」：exclude 生效，且结果只含 staging 里存在的列', () => {
    const r = resolveMeasureInputs(SQL, opts)
    for (const cols of Object.values(r.inputs)) {
      expect(cols.some((c) => GRAIN.includes(c))).toBe(false)
      expect(cols.every((c) => STAGING.includes(c))).toBe(true)
    }
  })

  it('解不出来的度量不产出键（缺席 ≠ 空输入）', () => {
    const r = resolveMeasureInputs(SQL, { ...opts, measures: ['no_such_measure'] })
    expect(r.inputs.no_such_measure).toBeUndefined()
  })

  it('Jinja 与注释不影响标识符扫描', () => {
    const r = resolveMeasureInputs(`-- 注释里有 fake_col\n${SQL}`, opts)
    expect(r.inputs.order_count).toEqual(['order_no'])
  })
})
