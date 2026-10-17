{{
    config(materialized='table')
}}
-- fct_inventory_coverage.sql — **库存覆盖天数**构件（#771，2026-10-17）。
--
-- 【为谁服务】客户项 `03-07`：覆盖天数＝报告日可售库存数量 / 日均净销量。
--   分子 = `fct_inventory_snapshot`（按门店×商品汇总仓库）；分母 = `fct_retail_quantity`。
--
-- 【N 的裁决（2026-10-17 用户拍板）】**月日均** = 当月 1 日 ~ 报告日的净销量合计 ÷ 当月已过天数。
--   ⚠️ 这是**解释性落地**（客户原文只说「ΣN日/可比营业日数」「批准窗口N」，没定 N）：
--     · 用**当月至今**而不是滚动 30 天——「月日均」的字面读法；
--     · 分母的「天数」用**自然日**（`extract(day from bizday)`），不是「营业日」：
--       X01 营业日历 seed **是空的**（客户未填），拿不到真实的营业日集合。
--       等 X01 有数据后，这里应换成「当月已过的营业日数」——那是一处**已知可改进点**。
--
-- 【⚠️ 净销量 ≤ 0 ⇒ 分母置 NULL】（客户文档：「净销量≤0 单列，**不强算天数**」）
--   不置 NULL 的话，负数日均会算出**负的覆盖天数**（看起来像个正经数字，其实是错数）。
--
-- 【粒度】(system_book, bizday, branch_num, item_num) —— 与客户「门店×商品×单位」对齐
--   （单位维度本仓未拆——同一商品只落 `base_unit` 口径，属已知边界）。
with inv as (
    -- 仓库汇总范围固定（客户文档）：按门店×商品把各仓库存加总。
    select
        system_book,
        bizday,
        branch_num,
        item_num,
        sum(inventory_quantity)::numeric(20, 3) as inventory_quantity
    from {{ ref('fct_inventory_snapshot') }}
    group by 1, 2, 3, 4
),
qty as (
    select system_book, bizday, branch_num, item_num, net_quantity
    from {{ ref('fct_retail_quantity') }}
),
mtd as (
    -- 当月至今的累计净销量（窗口到当前行为止）。
    select
        system_book,
        bizday,
        branch_num,
        item_num,
        sum(net_quantity) over (
            partition by system_book, branch_num, item_num, date_trunc('month', bizday)
            order by bizday
            rows between unbounded preceding and current row
        )::numeric(20, 3) as mtd_net_quantity
    from qty
)
select
    i.system_book,
    {{ subject_org() }} as org,
    i.bizday,
    i.branch_num,
    i.item_num,
    i.inventory_quantity,
    coalesce(m.mtd_net_quantity, 0)::numeric(20, 3) as mtd_net_quantity,
    (extract(day from i.bizday))::numeric(10, 0)    as days_elapsed,
    -- 净销量 ≤ 0（含当月在报告日之前一笔都没卖过）⇒ 日均置 NULL：客户文档要求「不强算天数」。
    case
        when coalesce(m.mtd_net_quantity, 0) > 0
         and extract(day from i.bizday) > 0
        then (coalesce(m.mtd_net_quantity, 0) / extract(day from i.bizday))::numeric(20, 6)
        else null
    end as avg_daily_net_quantity
from inv i
left join mtd m
       on m.system_book = i.system_book
      and m.bizday = i.bizday
      and m.branch_num = i.branch_num
      and m.item_num = i.item_num
