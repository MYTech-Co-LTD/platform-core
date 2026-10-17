-- audit_lemeng__client_contribution__net_amount.sql — 客户级费用后贡献的**独立复算**（对账）。
-- 骨架与 fct_client_contribution 同构，但**直接打 parquet、不 ref 任何 mart/staging**——复算若走
-- 上游关系，cast 错会同时污染两边 ⇒ 对账恒绿。契约：dbt singular test 返回任何行即失败。
--
-- ⚠️ **本对账比较「四个金额分量 + 两个计数」，不只是最终值**（W1 教训：两侧同为 0 的比较等于没验）。
--    r_net / c_cost / e_net / n_net 四列金额各自比对，order_count / line_count 两列计数兜住
--    「金额恰好对上但行集错了」的形态。
--
-- 口径（构件头注已详述，此处不复制）：N = R − C − E，客户粒度；R/C 只含批发域（退货冲减），
-- E 为客户费用净额，**含当天只有费用、没有出库的客户**（本对账的 full join 也必须保留它们，
-- 否则两侧一起丢，比对恒绿）。
-- 【state_code 基面】构件侧不筛客户费用 state_code（照 fct_client_expense）；复算侧筛 =3，
--   与 audit_lemeng__expense__client_net 同形——湖上客户费用单由管线请求侧筛审核态
--   （W2 起该对账每日全绿是隐式验证：若湖里存在非 3 行，构件与复算必不一致、那条早就红）。
-- 【窗口】三侧源表全筛 `bizday < 今天（上海时区）`：当天 parquet 仍会补采，不排 Today 两侧
--   会因补采时点差偶发不一致；物化侧同筛对齐窗口。
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
    -- per_order 去单头冗余（v2 两列为随行冗余）——与 fct_hq_outbound.wholesale_dom 同构。
    select system_book, bizday, client_fid, order_no,
           max(total_money) as total_money,
           max(cost_money)  as cost_money
    from wholesale_lines
    group by 1, 2, 3, 4
),
wholesale_dom as (
    select system_book, bizday, client_fid,
           sum(total_money)::numeric(20, 2) as r_net,
           sum(cost_money)::numeric(20, 2)  as c_cost,
           count(*)::bigint                 as order_count
    from wholesale_orders
    group by 1, 2, 3
),
linecount_dom as (
    -- 明细行数从**行级**数（per_order 去重会丢行）——与 fct_hq_outbound.wholesale_lines 同构。
    select system_book, bizday, client_fid, count(*)::bigint as line_count
    from wholesale_lines
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
    -- 客户费用净额 e_net = Σ应付 − Σ应收（flag: false=应付 / true=应收）。**不筛客户**——
    -- 构件侧「只有费用、没有出库」的客户行正是 full join 要保留的，复算按客户过滤就会漏掉。
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
        (coalesce(w.c_cost, 0) - coalesce(d.c_return, 0))::numeric(20, 2) as c_cost,
        coalesce(e.e_net, 0)::numeric(20, 2) as e_net,
        coalesce(w.order_count, 0)::bigint as order_count,
        coalesce(l.line_count, 0)::bigint  as line_count,
        (coalesce(w.r_net, 0) - coalesce(d.r_return, 0)
       - coalesce(w.c_cost, 0) + coalesce(d.c_return, 0)
       - coalesce(e.e_net, 0))::numeric(20, 2) as n_net
    from wholesale_dom w
    full join return_dom   d on w.system_book = d.system_book and w.bizday = d.bizday and w.client_fid = d.client_fid
    full join expense_dom  e on coalesce(w.system_book, d.system_book) = e.system_book
                            and coalesce(w.bizday, d.bizday) = e.bizday
                            and coalesce(w.client_fid, d.client_fid) = e.client_fid
    full join linecount_dom l on coalesce(w.system_book, d.system_book, e.system_book) = l.system_book
                             and coalesce(w.bizday, d.bizday, e.bizday) = l.bizday
                             and coalesce(w.client_fid, d.client_fid, e.client_fid) = l.client_fid
),
materialized as (
    select system_book, bizday, client_fid,
           r_net, c_cost, e_net, n_net, order_count, line_count
    from {{ ref('fct_client_contribution') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday)           as bizday,
    coalesce(a.client_fid, b.client_fid)   as client_fid,
    a.r_net as recheck_r, b.r_net as materialized_r,
    a.c_cost as recheck_c, b.c_cost as materialized_c,
    a.e_net as recheck_e, b.e_net as materialized_e,
    a.n_net as recheck_n, b.n_net as materialized_n,
    a.order_count as recheck_orders, b.order_count as materialized_orders,
    a.line_count as recheck_lines, b.line_count as materialized_lines,
    '客户级费用后贡献：复算与物化不一致（金额四列+计数两列各自比对）' as note
from recheck a
full join materialized b using (system_book, bizday, client_fid)
where a.r_net        is distinct from b.r_net
   or a.c_cost       is distinct from b.c_cost
   or a.e_net        is distinct from b.e_net
   or a.n_net        is distinct from b.n_net
   or a.order_count  is distinct from b.order_count
   or a.line_count   is distinct from b.line_count

union all

select
    null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)

union all

-- 非空转自检（W1 教训）：全域合计若全为 0，六列比对同时失去区分度。真机 R 千万级、
-- E 数万级，全零只可能是构件或复算某一侧整体塌了。
select
    null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
    '物化侧全域合计全为 0：六列比对已失去区分度（不是对上了）'
where not exists (
    select 1 from materialized
    where r_net <> 0 or c_cost <> 0 or e_net <> 0 or n_net <> 0
)
