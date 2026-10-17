{{
    config(materialized='table')
}}
-- fct_branch_day_activity.sql — 门店 × 日 **活动骨架**（03-05 连续无业绩天数的落点；2026-10-17 最小案例）
--
-- 【它为什么存在】零售事实只在「有单」的店日有行——「店开着、当天零销售」**没有行**。
--   03-05 要的「连续无业绩天数」必须建立在**完整店日序列**上，否则缺口被当成「不存在」而不是「零」。
--
-- 【核心裁决：日历可推导，不等客户交表】客户营业日历（`dbt/seeds/x01_branch_calendar.csv`）
--   **只作 override**，不是解锁前置：
--     · 门店存在性 / 是否营业 = `stg_lemeng_branch` **每日快照**的 as-of（latest snapshot ≤ bizday）
--     · 当日有销售 = 有行且 `sum(sale_money) > 0`
--     · 无行但门店当日存在且账套当日有采集 ⇒ **真零天**（`zero_sales`）
--   2026-10-17 实测：店×日空格子 129 个，其中 **125（96.9%）门店当日存在** ⇒ 绝大多数缺口是真零天。
--
-- 【射程与已知盲区（必须读）】
--   · `retail_active` = 该 (账套, 门店) 在**观察窗内**是否有过零售销售。
--     实测 400 个「账套×门店」里 **173 个零零售**（批发客户/仓库/配送节点）——它们的
--     `zero_sales` 不构成「经营异常」信号 ⇒ 消费侧应按 `retail_active` 收缩（见 L1 definition）。
--   · **盲区**：整窗零零售的门店无法与「窗内一直闭店」区分（只有 25 天历史）。
--     补法 = 客户营业日历到位后按 `is_open` 区分，或观察窗拉长。**这是刻意暴露的，不是遗漏。**
--   · `collection_covered` 是**账套×日**级别的弱代理（该账套当日有任意零售行）；
--     它**不能**证明某一家店当天被完整采集 ⇒ 「断数 vs 零销售」的最终判定仍需 X09 采集日志。
--
-- 【口径】正向销售 = `sum(sale_money) > 0`（客户 03-05「当日正向销售＝max(Σsale_money,0)」）。
-- 【窗口】截至**上海昨日**（`bizday < 今天`），与全仓审计口径一致：当日为部分天。
with bounds as (
    select min(snapshot) as d_start
    from {{ ref('stg_lemeng_branch') }}
),
days as (
    -- 自然日序列（连续，含真零天）；末日在上海昨日，避免把「当天的部分采集」误判成零销售
    select g.d::date as bizday
    from generate_series(
             (select d_start from bounds),
             (select max(bizday) from {{ ref('stg_lemeng_retail_order_line') }}
               where bizday < cast(now() at time zone 'Asia/Shanghai' as date)),
             interval '1 day'
         ) as g(d)
),
branch_set as (
    select distinct system_book, branch_num
    from {{ ref('stg_lemeng_branch') }}
),
spine as (
    select b.system_book, d.bizday, b.branch_num
    from branch_set b
    cross join days d
),
-- as-of 快照：门店在**那一天**的档案状态（存在性 / 是否营业 / 战区）
asof as (
    select
        s.system_book,
        s.bizday,
        s.branch_num,
        db.enable     as branch_enabled,
        db.region_id  as region_id
    from spine s
    left join lateral (
        select b.enable, b.region_id
        from {{ ref('stg_lemeng_branch') }} b
        where b.system_book = s.system_book
          and b.branch_num = s.branch_num
          and b.snapshot <= s.bizday
        order by b.snapshot desc
        limit 1
    ) db on true
),
sales as (
    select
        system_book,
        bizday,
        branch_num,
        sum(sale_money)::numeric(20,2) as sale_money,
        count(distinct order_no)       as order_count
    from {{ ref('stg_lemeng_retail_order_line') }}
    where bizday < cast(now() at time zone 'Asia/Shanghai' as date)
    group by 1, 2, 3
),
coverage as (
    select system_book, bizday
    from sales
    group by 1, 2
),
retail_active as (
    select system_book, branch_num
    from sales
    group by 1, 2
),
classified as (
    select
        a.system_book,
        a.bizday,
        a.branch_num,
        a.region_id,
        (a.branch_enabled is true)          as branch_enabled,
        (r.system_book is not null)         as retail_active,
        coalesce(s.sale_money, 0)::numeric(20,2) as sale_money,
        coalesce(s.order_count, 0)          as order_count,
        (c.system_book is not null)         as collection_covered,
        case
            when a.branch_enabled is null  then 'branch_absent'
            when a.branch_enabled = false  then 'branch_disabled'
            when c.system_book is null     then 'not_collected'
            when coalesce(s.sale_money, 0) > 0 then 'has_sales'
            else 'zero_sales'
        end                                 as data_status
    from asof a
    left join sales s
           on s.system_book = a.system_book
          and s.bizday     = a.bizday
          and s.branch_num = a.branch_num
    left join coverage c
           on c.system_book = a.system_book
          and c.bizday     = a.bizday
    left join retail_active r
           on r.system_book = a.system_book
          and r.branch_num = a.branch_num
),
grouped as (
    -- gaps-and-islands：非 zero_sales 的一天开一个新组；组内逐日累计 = 连续无业绩天数
    select
        *,
        sum(case when data_status = 'zero_sales' then 0 else 1 end)
            over (partition by system_book, branch_num order by bizday
                  rows between unbounded preceding and current row) as streak_group
    from classified
)
select
    system_book,
    {{ subject_org() }} as org,
    bizday,
    branch_num,
    region_id,
    branch_enabled,
    retail_active,
    sale_money,
    order_count,
    collection_covered,
    data_status,
    sum(case when data_status = 'zero_sales' then 1 else 0 end)
        over (partition by system_book, branch_num, streak_group order by bizday
              rows between unbounded preceding and current row)::int as consecutive_no_sales_days
from grouped
