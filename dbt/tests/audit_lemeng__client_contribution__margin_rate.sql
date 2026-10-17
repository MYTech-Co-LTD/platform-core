-- audit_lemeng__client_contribution__margin_rate.sql — 客户级费用后贡献率的**独立复算**（对账）。
-- 与 audit_lemeng__client_contribution__net_amount 同一复算基面（直接打 parquet、不 ref 上游关系）；
-- 本条额外比较「分子 / 分母 / 商」三样，不只是商——两侧同为 0 时商相等但**没有区分度**
-- （W1 return_rate 的教训）。两侧**各自算商**：分母为 0 的行两侧同为 null，不误报。
--
-- 【比率语义】L1 ratio 在查询粒度上是**先加再除**（sum(N)/sum(R)），不是行率的平均——
--   故物化侧先按指标粒度 (账套,业务日,客户) 聚合 sum，再相除。复算侧同构。
-- 【窗口/state_code】同 net_amount 对账：源表筛 `bizday < 今天（上海）`、客户费用筛 state_code=3、
--   构件侧不筛 state（管线请求侧已筛审核态）；物化侧同筛窗口对齐。
with wholesale_lines as (
    select
        r['system_book']::varchar  as system_book,
        r['bizday']::date          as bizday,
        r['client_fid']::varchar   as client_fid,
        r['order_no']::varchar     as order_no,
        r['total_money']::numeric  as total_money,
        r['cost_money']::numeric   as cost_money
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_wholesale_out_prefix") }}/*/bizday=**/*.parquet'
    ) r
    where r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
),
wholesale_orders as (
    select system_book, bizday, client_fid, order_no,
           max(total_money) as total_money,
           max(cost_money)  as cost_money
    from wholesale_lines
    group by 1, 2, 3, 4
),
wholesale_dom as (
    select system_book, bizday, client_fid,
           sum(total_money)::numeric(20, 2) as r_net,
           sum(cost_money)::numeric(20, 2)  as c_cost
    from wholesale_orders
    group by 1, 2, 3
),
return_dom as (
    select system_book, bizday, client_fid,
           sum(total_money)::numeric(20, 2) as r_return,
           sum(cost_money)::numeric(20, 2)  as c_return
    from (
        select r['system_book']::varchar as system_book,
               r['bizday']::date         as bizday,
               r['client_fid']::varchar  as client_fid,
               r['order_no']::varchar    as order_no,
               max(r['total_money']::numeric) as total_money,
               max(r['cost_money']::numeric)  as cost_money
        from read_parquet(
            's3://{{ var("zos_bucket") }}/{{ var("lemeng_wholesale_return_prefix") }}/*/bizday=**/*.parquet'
        ) r
        where r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
        group by 1, 2, 3, 4
    )
    group by 1, 2, 3
),
expense_dom as (
    -- e_net = Σ应付 − Σ应收（flag: false=应付 / true=应收）。**不筛客户**——构件侧「只有费用、
    -- 没有出库」的客户行（R=0）正是 full join 要保留的，它们分母为 0 → 率不适用，不算错。
    select r['system_book']::varchar as system_book,
           r['bizday']::date         as bizday,
           r['client_fid']::varchar  as client_fid,
           (sum(case when r['other_inout_flag']::boolean = false then coalesce(r['other_inout_money']::numeric, 0) else 0 end)
          - sum(case when r['other_inout_flag']::boolean = true  then coalesce(r['other_inout_money']::numeric, 0) else 0 end))::numeric(20, 2) as e_net
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_client_expense_prefix") }}/*/bizday=**/*.parquet'
    ) r
    where r['state_code']::int = 3
      and r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
    group by 1, 2, 3
),
recheck as (
    select
        coalesce(w.system_book, d.system_book, e.system_book) as system_book,
        coalesce(w.bizday, d.bizday, e.bizday)                as bizday,
        coalesce(w.client_fid, d.client_fid, e.client_fid)    as client_fid,
        (coalesce(w.r_net, 0) - coalesce(d.r_return, 0))::numeric(20, 2) as r_net,
        (coalesce(w.r_net, 0) - coalesce(d.r_return, 0)
       - coalesce(w.c_cost, 0) + coalesce(d.c_return, 0)
       - coalesce(e.e_net, 0))::numeric(20, 2) as n_net
    from wholesale_dom w
    full join return_dom  d on w.system_book = d.system_book and w.bizday = d.bizday and w.client_fid = d.client_fid
    full join expense_dom e on coalesce(w.system_book, d.system_book) = e.system_book
                            and coalesce(w.bizday, d.bizday) = e.bizday
                            and coalesce(w.client_fid, d.client_fid) = e.client_fid
),
materialized as (
    select system_book, bizday, client_fid,
           sum(r_net)::numeric(20, 2) as r_net,
           sum(n_net)::numeric(20, 2) as n_net
    from {{ ref('fct_client_contribution') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
    group by 1, 2, 3
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday)           as bizday,
    coalesce(a.client_fid, b.client_fid)   as client_fid,
    a.r_net as recheck_r, b.r_net as materialized_r,
    a.n_net as recheck_n, b.n_net as materialized_n,
    a.n_net / nullif(a.r_net, 0) as recheck_rate,
    b.n_net / nullif(b.r_net, 0) as materialized_rate,
    '客户级费用后贡献率：复算与物化不一致（分子/分母/商各自比对）' as note
from recheck a
full join materialized b using (system_book, bizday, client_fid)
where a.r_net is distinct from b.r_net
   or a.n_net is distinct from b.n_net
   or a.n_net / nullif(a.r_net, 0) is distinct from b.n_net / nullif(b.r_net, 0)

union all

select null, null, null, null, null, null, null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)

union all

select null, null, null, null, null, null, null, null, null, null,
    '物化侧分子分母全为 0：比对已失去区分度（不是对上了）'
where not exists (select 1 from materialized where r_net <> 0 or n_net <> 0)
