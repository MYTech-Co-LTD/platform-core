-- audit_lemeng__request__day_fulfillment_rate.sql — 截止日满足率的独立复算（#677）。
-- 契约：dbt singular test 返回任何行即失败；空转自检防假绿。
-- 复算直接打 parquet（D15+D16 双源）、不 ref staging（骨架同族；口径与两向偏差边界
-- 见 fct_request_fulfillment.sql 头注，此处不复制）。
-- 本文件比较的是：粒度行内的满足率 = fulfilled_line_count / requested_line_count
-- （率不可加，对账按粒度行比商，同 outbound__gross_margin_rate 的形态）。
with request_lines as (
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
        r['branch_num']::int      as branch_num,
        r['item_num']::bigint     as item_num,
        sum(r['quantity']::numeric(20,6)) as requested_quantity,
        count(*)                  as requested_line_count
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_request_order_prefix") }}/*/bizday=**/*.parquet'
    ) r
    where r['quantity']::numeric(20,6) > 0
      and r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
    group by 1, 2, 3, 4
),
shipped as (
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
        r['branch_num']::int      as branch_num,
        r['item_num']::bigint     as item_num,
        sum(r['quantity']::numeric(20,6)) as shipped_quantity
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_transfer_in_prefix") }}/*/bizday=**/*.parquet'
    ) r
    where r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
    group by 1, 2, 3, 4
),
recheck as (
    select
        q.system_book,
        q.bizday,
        q.branch_num,
        q.item_num,
        case when coalesce(s.shipped_quantity, 0) >= q.requested_quantity
             then q.requested_line_count else 0
        end::numeric(20,6)
            / nullif(q.requested_line_count, 0) as line_rate
    from request_lines q
    left join shipped s
           on q.system_book = s.system_book
          and q.bizday = s.bizday
          and q.branch_num = s.branch_num
          and q.item_num = s.item_num
),
materialized as (
    select
        system_book, bizday, branch_num, item_num,
        fulfilled_line_count::numeric(20,6) / nullif(requested_line_count, 0) as line_rate
    from {{ ref('fct_request_fulfillment') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday)           as bizday,
    coalesce(a.branch_num, b.branch_num)   as branch_num,
    coalesce(a.item_num, b.item_num)       as item_num,
    a.line_rate as recheck_value,
    b.line_rate as materialized_value,
    '截止日满足率（行内商）：复算与物化结果不一致' as note
from recheck a
full join materialized b using (system_book, bizday, branch_num, item_num)
where a.line_rate is distinct from b.line_rate

union all

select
    null, null, null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)
