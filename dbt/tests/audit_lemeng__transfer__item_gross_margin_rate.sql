-- audit_lemeng__transfer__item_gross_margin_rate.sql — 指标的**独立复算**（对账；聚合面与
-- fct_transfer_item 逐字同构，但直接打 parquet、不 ref staging）。ratio 比较：两侧各自算 g/r
--（分母 0/null 行两侧同为 null，is distinct from 不误报）。口径见 fct_transfer_item.sql 头注。
with item_lines as (
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
        r['item_num']::bigint     as item_num,
        sum(r['out_money']::numeric)::numeric(20,2) as r_net,
        sum(r['subtotal']::numeric)::numeric(20,2)  as c_cost
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_transfer_out_prefix") }}/*/bizday=**/*.parquet'
    ) r
    where r['state_code']::int = 3
      and r['out_branch_num']::int = 99
      and r['branch_num']::int <> r['out_branch_num']::int
      and r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
    group by 1, 2, 3
),
recheck as (
    select system_book, bizday, item_num,
           (r_net - c_cost)::numeric(20,2) as g_gross,
           r_net, c_cost
    from item_lines
),
materialized as (
    select system_book, bizday, item_num, g_gross, r_net, c_cost
    from {{ ref('fct_transfer_item') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday) as bizday,
    coalesce(a.item_num, b.item_num) as item_num,
    (a.g_gross / nullif(a.r_net, 0)) as recheck_value,
    (b.g_gross / nullif(b.r_net, 0)) as materialized_value,
    '商品出库毛利率：复算与物化结果不一致' as note
from recheck a
full join materialized b using (system_book, bizday, item_num)
where (a.g_gross / nullif(a.r_net, 0)) is distinct from (b.g_gross / nullif(b.r_net, 0))

union all

select
    null, null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)
