-- audit_lemeng__transfer__batch_fill_rate.sql — 指标的**独立复算**（对账；聚合面与 fct_transfer_line_quality 逐字同构，
-- 但直接打 parquet、不 ref staging——复算走 staging 会让 cast 错同时污染两边 ⇒ 对账恒绿）。
-- 契约：dbt singular test 返回任何行即失败；空转自检防「空集上的假绿」。
-- 口径见 fct_transfer_line_quality.sql 头注（本文件比较：批号填写率（全量版））。
with base as (
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
        r['branch_num']::int      as branch_num,
        r['order_no']::varchar    as order_no,
        r['out_money']::numeric   as out_money,
        r['subtotal']::numeric    as subtotal,
        r['lot_number']::varchar  as lot_number
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_transfer_out_prefix") }}/*/bizday=**/*.parquet'
    ) r
    where r['state_code']::int = 3
      and r['out_branch_num']::int = 99
      and r['branch_num']::int <> r['out_branch_num']::int
      and r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
),
per_order as (
    select system_book, bizday, branch_num, order_no,
           max(coalesce(out_money, 0))::numeric(20,2) as order_money
    from base group by 1, 2, 3, 4
),
recheck as (
    select
        b.system_book,
        b.bizday,
        b.branch_num,
        count(*)                                                              as line_count,
        count(*) filter (where b.lot_number is not null and trim(b.lot_number) <> '') as lot_filled_lines,
        sum(case when coalesce(b.out_money, 0) <> 0 and coalesce(b.subtotal, 0) = 0
                 then b.out_money else 0 end)::numeric(20,2)                   as zero_cost_amount,
        count(distinct case when p.order_money < 0 then b.order_no end)        as negative_order_count
    from base b
    join per_order p using (system_book, bizday, branch_num, order_no)
    group by 1, 2, 3
),
materialized as (
    select system_book, bizday, branch_num, line_count, lot_filled_lines, zero_cost_amount, negative_order_count,
           lot_filled_lines::numeric / nullif(line_count, 0) as fill_rate
    from {{ ref('fct_transfer_line_quality') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday) as bizday,
    coalesce(a.branch_num, b.branch_num) as branch_num,
    a.fill_rate as recheck_value,
    b.fill_rate as materialized_value,
    '批号填写率（全量版）：复算与物化结果不一致（两侧各自算商）' as note
from recheck a
full join materialized b using (system_book, bizday, branch_num)
where a.fill_rate is distinct from b.fill_rate

union all

select
    null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)
