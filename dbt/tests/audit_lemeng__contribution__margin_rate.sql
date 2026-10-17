-- audit_lemeng__contribution__margin_rate.sql — 指标的**独立复算**（对账）。
-- 直接打 parquet、不 ref 任何 mart/staging（走上游会让 cast 错同时污染两边 ⇒ 对账恒绿）。
--
-- ⚠️ 比较的是「分子 / 分母 / 商」三样，不只是商：两侧同为 0 时商相等但**没有区分度**
-- （W1 `return_rate` 的教训）。分子分母各自比对 ⇒ 即使商恰好为 0 也仍有区分度。
-- 两侧**各自算商**：分母为 0 的行两侧同为 null，不误报。
--
-- 口径同 fct_contribution 头注：N = R − C − E，R/C 来自 transfer+wholesale−return，E 来自门店费用。
with transfer_lines as (
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
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
    select system_book, bizday,
           sum(out_money)::numeric(20, 2) as r_net,
           sum(subtotal)::numeric(20, 2)  as c_cost
    from transfer_lines group by 1, 2
),
wholesale_orders as (
    select r['system_book']::varchar as system_book, r['bizday']::date as bizday, r['order_no']::varchar as order_no,
           max(r['total_money']::numeric) as total_money, max(r['cost_money']::numeric) as cost_money
    from read_parquet('s3://{{ var("zos_bucket") }}/{{ var("lemeng_wholesale_out_prefix") }}/*/bizday=**/*.parquet') r
    where r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
    group by 1, 2, 3
),
wholesale_dom as (
    select system_book, bizday, sum(total_money)::numeric(20, 2) as r_net, sum(cost_money)::numeric(20, 2) as c_cost
    from wholesale_orders group by 1, 2
),
return_orders as (
    select r['system_book']::varchar as system_book, r['bizday']::date as bizday, r['order_no']::varchar as order_no,
           max(r['total_money']::numeric) as total_money, max(r['cost_money']::numeric) as cost_money
    from read_parquet('s3://{{ var("zos_bucket") }}/{{ var("lemeng_wholesale_return_prefix") }}/*/bizday=**/*.parquet') r
    where r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
    group by 1, 2, 3
),
return_dom as (
    select system_book, bizday, sum(total_money)::numeric(20, 2) as r_net, sum(cost_money)::numeric(20, 2) as c_cost
    from return_orders group by 1, 2
),
expense as (
    select r['system_book']::varchar as system_book, r['bizday']::date as bizday,
           (sum(case when r['direction']::varchar = '应付' then coalesce(r['amount']::numeric, 0) else 0 end)
          - sum(case when r['direction']::varchar = '应收' then coalesce(r['amount']::numeric, 0) else 0 end))::numeric(20, 2) as e_net
    from read_parquet('s3://{{ var("zos_bucket") }}/{{ var("lemeng_branch_expense_prefix") }}/*/bizday=**/*.parquet') r
    group by 1, 2
),
recheck as (
    select
        coalesce(t.system_book, w.system_book, e.system_book) as system_book,
        coalesce(t.bizday, w.bizday, e.bizday)                as bizday,
        (coalesce(t.r_net, 0) + coalesce(w.r_net, 0) - coalesce(d.r_net, 0))::numeric(20, 2) as r_net,
        (coalesce(t.r_net, 0) + coalesce(w.r_net, 0) - coalesce(d.r_net, 0)
       - coalesce(t.c_cost, 0) - coalesce(w.c_cost, 0) + coalesce(d.c_cost, 0)
       - coalesce(e.e_net, 0))::numeric(20, 2) as n_net
    from transfer_dom t
    full join wholesale_dom w on t.system_book = w.system_book and t.bizday = w.bizday
    full join return_dom   d on coalesce(t.system_book, w.system_book) = d.system_book
                            and coalesce(t.bizday, w.bizday) = d.bizday
    full join expense      e on coalesce(t.system_book, w.system_book, d.system_book) = e.system_book
                            and coalesce(t.bizday, w.bizday, d.bizday) = e.bizday
),
materialized as (
    select system_book, bizday,
           sum(r_net)::numeric(20, 2) as r_net,
           sum(n_net)::numeric(20, 2) as n_net
    from {{ ref('fct_contribution') }}
    group by 1, 2
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday)           as bizday,
    a.r_net as recheck_r, b.r_net as materialized_r,
    a.n_net as recheck_n, b.n_net as materialized_n,
    a.n_net / nullif(a.r_net, 0) as recheck_rate,
    b.n_net / nullif(b.r_net, 0) as materialized_rate,
    '费用后贡献率（总仓级）：复算与物化不一致（分子/分母/商各自比对）' as note
from recheck a
full join materialized b using (system_book, bizday)
where a.r_net is distinct from b.r_net
   or a.n_net is distinct from b.n_net
   or a.n_net / nullif(a.r_net, 0) is distinct from b.n_net / nullif(b.r_net, 0)

union all

select null, null, null, null, null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)

union all

select null, null, null, null, null, null, null, null,
    '物化侧分子分母全为 0：比对已失去区分度（不是对上了）'
where not exists (select 1 from materialized where r_net <> 0 or n_net <> 0)
