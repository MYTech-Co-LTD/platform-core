{{
    config(materialized='table')
}}
-- fct_retail_comparable_growth.sql — **可比门店（like-for-like）两期对照构件**（01-05 / 07-06 的落点；
-- 2026-10-17「问 0」第二例：把「可比门店集合」从客户输入改为**可推导**）
--
-- 【它为什么存在】客户 01-05 的公式是 `增长率＝Σ_B本期L/Σ_B上期L − 1`，其中 **B（可比门店集合）
--   是「这一对期间」的属性，不是单期的属性** ⇒ 消费方「两次调用各取一期再相除」**结构性做不到**
--   （两次调用的行集不同 ⇒ 分母口径错）。所以 B 必须在构件里定死，两期金额必须同表同粒度同集合。
--
-- 【B 怎么推（客户文档「闭店日和新开店须按规则排除」）】
--   · **不是新开店**：`first_seen <= 上期开始`（门店在一个快照里出现过的最早日期）
--   · **不是闭店**：`last_seen >= 本期结束`
--   · **两期内都启用**：`bool_and(enable)` over `[上期开始, 本期结束]` 的每日快照
--   · **有零售业务**：两期中至少一期有零售行（否则批发客户/仓库/配送节点会混进分母——
--     与 03-05 的 `retail_active` 同一条约束，实测 400 个「账套×门店」里 173 个零零售）
--   ⚠️ 这四条**都可从自有数据推出**，不需要客户营业日历（日历只做 override）。
--
-- 【口径】L = `Σsale_money`（客户 01-05 用 `sale_money/return_money`；本构件取**销售额毛额**，
--   不冲退货——与 certified 净额口径（#430 不冲退货）**不同**，判定「正向销售」时按客户原式取毛额）。
-- 【营业店日归一化】客户第二式 `(本期L/本期营业店日)/(上期L/上期营业店日)−1` 的输入
--   = `cur_store_days` / `pri_store_days`（B 在期内**有销售**的店日数）。
-- 【窗口】周期 = `period_days`（当前只出 **7 天**；客户频率是**月**，但本湖只有 25 天历史 ⇒
--   月对月尚无数据。加周期 = 在 `periods` 里多一个值，代码路径相同）。
-- 【已知边界】
--   · 快照起点（09-26）晚于零售起点（09-23）⇒ 有效 `bizday` 从 `d_min + 2*period_days - 1` 起算。
--   · 观察窗内 **excluded_new / excluded_closed 实测均为 0**（没有店在窗内新开或关闭）⇒
--     这两条排除逻辑**当前是空转的**，随历史变长才会生效。**刻意保留**（客户文档明确要求）。
with params as (
    select 7 as period_days
),
bounds as (
    select
        greatest(
            (select min(snapshot) from {{ ref('stg_lemeng_branch') }}),
            (select min(bizday)   from {{ ref('stg_lemeng_retail_order_line') }})
        ) as d_min,
        (select max(bizday) from {{ ref('stg_lemeng_retail_order_line') }}
          where bizday < cast(now() at time zone 'Asia/Shanghai' as date)) as d_max
),
periods as (
    select
        g.d::date as bizday,
        p.period_days,
        (g.d::date - (p.period_days - 1) * interval '1 day')::date as cur_start,
        (g.d::date - (2 * p.period_days - 1) * interval '1 day')::date as pri_start,
        (g.d::date - p.period_days * interval '1 day')::date as pri_end
    from params p
    cross join bounds b
    cross join lateral generate_series(
        b.d_min + (2 * p.period_days - 1) * interval '1 day',
        b.d_max,
        interval '1 day'
    ) as g(d)
),
seen as (
    select system_book, branch_num, min(snapshot) as first_seen, max(snapshot) as last_seen
    from {{ ref('stg_lemeng_branch') }}
    group by 1, 2
),
enabled as (
    select b.system_book, b.branch_num, p.bizday, p.period_days,
           bool_and(b.enable) as enabled_all
    from {{ ref('stg_lemeng_branch') }} b
    join periods p on b.snapshot between p.pri_start and p.bizday
    group by 1, 2, 3, 4
),
per_branch as (
    select
        s.system_book,
        s.branch_num,
        p.bizday,
        p.period_days,
        sum(case when s.bizday between p.cur_start and p.bizday
                 then s.sale_money else 0 end)::numeric(20,2) as cur_amount,
        sum(case when s.bizday between p.pri_start and p.pri_end
                 then s.sale_money else 0 end)::numeric(20,2) as pri_amount,
        count(distinct case when s.bizday between p.cur_start and p.bizday
                            then s.bizday end) as cur_store_days,
        count(distinct case when s.bizday between p.pri_start and p.pri_end
                            then s.bizday end) as pri_store_days
    from {{ ref('stg_lemeng_retail_order_line') }} s
    join periods p on s.bizday between p.pri_start and p.bizday
    group by 1, 2, 3, 4
),
classified as (
    -- 每一对 (账套, 门店, 期间) 判定：可比 / 新开 / 闭店 / 停用 / 无零售业务
    select
        e.system_book,
        e.bizday,
        e.period_days,
        e.branch_num,
        coalesce(pb.cur_amount, 0)::numeric(20,2) as cur_amount,
        coalesce(pb.pri_amount, 0)::numeric(20,2) as pri_amount,
        coalesce(pb.cur_store_days, 0)     as cur_store_days,
        coalesce(pb.pri_store_days, 0)     as pri_store_days,
        case
            when sn.first_seen > pp.pri_start        then 'excluded_new'
            when sn.last_seen  < pp.bizday       then 'excluded_closed'
            when not e.enabled_all                   then 'excluded_disabled'
            when pb.branch_num is null               then 'excluded_no_retail'
            else 'comparable'
        end as comparable_status
    from enabled e
    join periods pp on pp.bizday = e.bizday and pp.period_days = e.period_days
    join seen sn on sn.system_book = e.system_book and sn.branch_num = e.branch_num
    left join per_branch pb
           on pb.system_book = e.system_book
          and pb.branch_num = e.branch_num
          and pb.bizday = e.bizday
          and pb.period_days = e.period_days
)
select
    system_book,
    {{ subject_org() }} as org,
    period_days,
    bizday,
    count(*) filter (where comparable_status = 'comparable')::int           as comparable_count,
    count(*) filter (where comparable_status = 'excluded_new')::int        as excluded_new,
    count(*) filter (where comparable_status = 'excluded_closed')::int     as excluded_closed,
    count(*) filter (where comparable_status = 'excluded_disabled')::int   as excluded_disabled,
    count(*) filter (where comparable_status = 'excluded_no_retail')::int  as excluded_no_retail,
    coalesce(sum(case when comparable_status = 'comparable'
                      then cur_amount end), 0)::numeric(20,2)              as cur_amount,
    coalesce(sum(case when comparable_status = 'comparable'
                      then pri_amount end), 0)::numeric(20,2)              as pri_amount,
    coalesce(sum(case when comparable_status = 'comparable'
                      then cur_store_days end), 0)::int                    as cur_store_days,
    coalesce(sum(case when comparable_status = 'comparable'
                      then pri_store_days end), 0)::int                    as pri_store_days,
    (coalesce(sum(case when comparable_status = 'comparable' then cur_amount end), 0)
     / nullif(coalesce(sum(case when comparable_status = 'comparable' then pri_amount end), 0), 0)
     - 1)::numeric(12,6)                                                   as growth_rate
from classified
group by 1, 3, 4
