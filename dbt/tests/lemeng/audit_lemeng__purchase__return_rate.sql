-- audit_lemeng__purchase__return_rate.sql — 指标的**独立复算**（对账；聚合面与 fct_purchase 同构，
-- 但**直接打 parquet、不 ref staging**——复算若走 staging，cast 错会同时污染两边 ⇒ 对账恒绿）。
-- 契约：dbt singular test 返回任何行即失败。空转自检防「空集上的假绿」。
-- 本文件比较的是：采购退货率 = 采购退货金额 / 采购收货金额。
-- ⚠️ 两侧**各自算商**（不是比分子分母再相除）：分母为 0 的行两侧同为 null，不误报。
-- ⚠️ 部门维度未进 grain（待 W3 随 CR5 补），本文件按 (账套, 业务日) 对齐。
with src as (
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
        r['purchase_item_return_money']::numeric(14, 2) as return_money,
        r['money_total']::numeric(14, 2)                as money_total
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_item_purchase_prefix") }}/*/bizday=**/*.parquet'
    ) r
),
recheck as (
    select
        system_book,
        bizday,
        sum(return_money) / nullif(sum(money_total), 0) as return_rate
    from src
    group by 1, 2
),
materialized as (
    select
        system_book,
        bizday,
        sum(purchase_item_return_money) / nullif(sum(money_total), 0) as return_rate
    from {{ ref('fct_purchase') }}
    group by 1, 2
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday)           as bizday,
    a.return_rate as recheck_value,
    b.return_rate as materialized_value,
    '采购退货率：复算与物化结果不一致（两侧各自算商，分母 0 行两侧同为 null 不误报）' as note
from recheck a
full join materialized b using (system_book, bizday)
where a.return_rate is distinct from b.return_rate

union all

select
    null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)
