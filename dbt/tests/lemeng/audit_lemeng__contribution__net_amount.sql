-- audit_lemeng__contribution__net_amount.sql — 指标的**独立复算**（对账）。
-- 骨架与 fct_contribution 同构，但**直接打 parquet、不 ref 任何 mart/staging**——复算若走上游关系，
-- cast 错会同时污染两边 ⇒ 对账恒绿。契约：dbt singular test 返回任何行即失败。
--
-- ⚠️ **本对账比较的是「三个分量 + 合计」，不只是最终值**（W1 的教训：`return_rate` 那条两侧同为 0，
-- 比较 0 vs 0 等于没验）。这里把 r_net / c_cost / e_net / n_net 四列**各自比对**——即使某天 n_net
-- 恰好为 0，另外三列仍有区分度；四列全零才会同时失去区分度，而那种情况会被下面的「非空转自检」抓住。
--
-- 口径（构件头注已详述，此处不复制）：N = R − C − E；R/C 来自 transfer+wholesale−return，
-- E 来自门店费用（**含当天无出库的费用行**——本对账也必须算上，否则它会和构件一起错）。
with transfer_lines as (
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
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
    select system_book, bizday,
           sum(out_money)::numeric(20, 2) as r_net,
           sum(subtotal)::numeric(20, 2)  as c_cost
    from transfer_lines group by 1, 2
),
wholesale_orders as (
    select r['system_book']::varchar as system_book,
           r['bizday']::date         as bizday,
           r['order_no']::varchar    as order_no,
           max(r['total_money']::numeric) as total_money,
           max(r['cost_money']::numeric)  as cost_money
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_wholesale_out_prefix") }}/*/bizday=**/*.parquet'
    ) r
    where r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
    group by 1, 2, 3
),
wholesale_dom as (
    select system_book, bizday,
           sum(total_money)::numeric(20, 2) as r_net,
           sum(cost_money)::numeric(20, 2)  as c_cost
    from wholesale_orders group by 1, 2
),
return_orders as (
    select r['system_book']::varchar as system_book,
           r['bizday']::date         as bizday,
           r['order_no']::varchar    as order_no,
           max(r['total_money']::numeric) as total_money,
           max(r['cost_money']::numeric)  as cost_money
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_wholesale_return_prefix") }}/*/bizday=**/*.parquet'
    ) r
    where r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
    group by 1, 2, 3
),
return_dom as (
    select system_book, bizday,
           sum(total_money)::numeric(20, 2) as r_net,
           sum(cost_money)::numeric(20, 2)  as c_cost
    from return_orders group by 1, 2
),
expense as (
    -- 门店费用净额 e_net = Σ应付 − Σ应收（`direction` 是中文字面，不是编码）。**不筛门店**——
    -- 构件侧的 orphan 行正是「无出库可挂的费用」，对账若按门店过滤就会漏掉它们（两侧一起错）。
    select r['system_book']::varchar as system_book,
           r['bizday']::date         as bizday,
           (sum(case when r['direction']::varchar = '应付' then coalesce(r['amount']::numeric, 0) else 0 end)
          - sum(case when r['direction']::varchar = '应收' then coalesce(r['amount']::numeric, 0) else 0 end))::numeric(20, 2) as e_net
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_branch_expense_prefix") }}/*/bizday=**/*.parquet'
    ) r
    group by 1, 2
),
recheck as (
    select
        coalesce(t.system_book, w.system_book, e.system_book) as system_book,
        coalesce(t.bizday, w.bizday, e.bizday)                as bizday,
        (coalesce(t.r_net, 0) + coalesce(w.r_net, 0) - coalesce(d.r_net, 0))::numeric(20, 2) as r_net,
        (coalesce(t.c_cost, 0) + coalesce(w.c_cost, 0) - coalesce(d.c_cost, 0))::numeric(20, 2) as c_cost,
        coalesce(e.e_net, 0)::numeric(20, 2) as e_net,
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
           sum(r_net)::numeric(20, 2)  as r_net,
           sum(c_cost)::numeric(20, 2) as c_cost,
           sum(e_net)::numeric(20, 2)  as e_net,
           sum(n_net)::numeric(20, 2)  as n_net
    from {{ ref('fct_contribution') }}
    group by 1, 2
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday)           as bizday,
    a.r_net as recheck_r, b.r_net as materialized_r,
    a.c_cost as recheck_c, b.c_cost as materialized_c,
    a.e_net as recheck_e, b.e_net as materialized_e,
    a.n_net as recheck_n, b.n_net as materialized_n,
    '费用后贡献额（总仓级）：复算与物化不一致（四列各自比对）' as note
from recheck a
full join materialized b using (system_book, bizday)
where a.r_net is distinct from b.r_net
   or a.c_cost is distinct from b.c_cost
   or a.e_net is distinct from b.e_net
   or a.n_net is distinct from b.n_net

union all

select
    null, null, null, null, null, null, null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)

union all

-- 非空转自检（W1 教训）：两侧的**合计**若同为 0，四列比对也失去区分度。此指标的全域 R 与 E
-- 真机上都远大于 0（实测 R≈千万级 / E≈2.4 万），全零只可能是构件或复算某一侧整体塌了。
select
    null, null, null, null, null, null, null, null, null, null,
    '物化侧全域合计全为 0：四列比对已失去区分度（不是对上了）'
where not exists (
    select 1 from materialized
    where r_net <> 0 or c_cost <> 0 or e_net <> 0 or n_net <> 0
)
