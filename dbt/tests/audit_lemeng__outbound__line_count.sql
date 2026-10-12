-- audit_lemeng__outbound__line_count.sql — 指标的**独立复算**（对账；骨架与聚合面同 fct_hq_outbound 逐字同构，
-- 但直接打 parquet、不 ref staging——复算若走 staging，cast 错会同时污染两边 ⇒ 对账恒绿）。
-- 契约：dbt singular test 返回任何行即失败。空转自检防「空集上的假绿」。
-- 口径（裁8/裁1 experimental 事由、基面、退货相减形态）见 fct_hq_outbound.sql 头注，此处不复制。
-- 本文件比较的是：出库明细行数。
with transfer_lines as (
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
        r['branch_num']::int      as branch_num,
        r['order_no']::varchar    as order_no,
        r['out_money']::numeric   as out_money,
        r['subtotal']::numeric    as subtotal
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_transfer_out_prefix") }}/*/bizday=**/*.parquet'
    ) r
    where r['state_code']::int = 3
      and r['out_branch_num']::int = 99
      and r['branch_num']::int <> r['out_branch_num']::int
      and r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
),
transfer_dom as (
    select system_book, bizday, branch_num,
           sum(out_money)::numeric(20,2) as r_net,
           sum(subtotal)::numeric(20,2)  as c_cost,
           count(distinct order_no)      as order_count,
           count(*)                      as line_count
    from transfer_lines group by 1, 2, 3
),
wholesale_orders as (
    select r['system_book']::varchar as system_book,
           r['bizday']::date         as bizday,
           r['branch_num']::int      as branch_num,
           r['order_no']::varchar    as order_no,
           max(r['total_money']::numeric) as total_money,
           max(r['cost_money']::numeric)  as cost_money
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_wholesale_out_prefix") }}/*/bizday=**/*.parquet'
    ) r
    where r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
    group by 1, 2, 3, 4
),
wholesale_lines as (
    select r['system_book']::varchar as system_book,
           r['bizday']::date         as bizday,
           r['branch_num']::int      as branch_num,
           count(*)                  as line_count
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_wholesale_out_prefix") }}/*/bizday=**/*.parquet'
    ) r
    where r['bizday']::date < {now}
    group by 1, 2, 3
),
wholesale_dom as (
    select w.system_book, w.bizday, w.branch_num,
           sum(w.total_money)::numeric(20,2) as r_net,
           sum(w.cost_money)::numeric(20,2)  as c_cost,
           count(distinct w.order_no)        as order_count,
           max(l.line_count)                 as line_count
    from wholesale_orders w
    join wholesale_lines l
      on w.system_book = l.system_book
     and w.bizday = l.bizday
     and w.branch_num = l.branch_num
    group by 1, 2, 3
),
return_orders as (
    select r['system_book']::varchar as system_book,
           r['bizday']::date         as bizday,
           r['branch_num']::int      as branch_num,
           r['order_no']::varchar    as order_no,
           max(r['total_money']::numeric) as total_money,
           max(r['cost_money']::numeric)  as cost_money
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_wholesale_return_prefix") }}/*/bizday=**/*.parquet'
    ) r
    where r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
    group by 1, 2, 3, 4
),
return_dom as (
    select system_book, bizday, branch_num,
           sum(total_money)::numeric(20,2) as r_return,
           sum(cost_money)::numeric(20,2)  as c_return
    from return_orders group by 1, 2, 3
),
branch_latest as (
    select system_book, branch_num, region_id
    from (
        select r['system_book']::varchar as system_book,
               r['branch_num']::int      as branch_num,
               r['region_id']::bigint    as region_id,
               row_number() over (partition by r['system_book']::varchar, r['branch_num']::int order by r['snapshot'] desc) as rn
        from read_parquet(
            's3://{{ var("zos_bucket") }}/{{ var("lemeng_branch_prefix") }}/system_book=*/snapshot=**/*.parquet'
        ) r
    )
    where rn = 1
),
recheck as (
    select
        u.system_book, u.bizday, u.domain, u.branch_num,
        coalesce(b.region_id, 0)::bigint as region_id,
        (u.r_net - coalesce(d.r_return, 0))::numeric(20,2)  as r_net,
        (u.c_cost - coalesce(d.c_return, 0))::numeric(20,2) as c_cost,
        (u.r_net - coalesce(d.r_return, 0) - u.c_cost + coalesce(d.c_return, 0))::numeric(20,2) as g_gross,
        u.order_count,
        u.line_count
    from (
        select system_book, bizday, branch_num, 'transfer' as domain, r_net, c_cost, order_count, line_count from transfer_dom
        union all
        select system_book, bizday, branch_num, 'wholesale' as domain, coalesce(r_net, 0), coalesce(c_cost, 0), coalesce(order_count, 0), coalesce(line_count, 0) from wholesale_dom
    ) u
    left join return_dom d
           on u.domain = 'wholesale'
          and u.system_book = d.system_book
          and u.bizday = d.bizday
          and u.branch_num = d.branch_num
    left join branch_latest b
           on u.system_book = b.system_book
          and u.branch_num = b.branch_num
),
materialized as (
    select system_book, bizday, domain, branch_num, region_id, r_net, c_cost, g_gross, order_count, line_count
    from {{ ref('fct_hq_outbound') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday) as bizday,
    coalesce(a.domain, b.domain) as domain,
    coalesce(a.branch_num, b.branch_num) as branch_num,
    coalesce(a.region_id, b.region_id) as region_id,
    a.line_count as recheck_value,
    b.line_count     as materialized_value,
    '出库明细行数：复算与物化结果不一致（行数可加）' as note
from recheck a
full join materialized b using (system_book, bizday, domain, branch_num, region_id)
where a.line_count is distinct from b.line_count

union all

select
    null, null, null, null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)
