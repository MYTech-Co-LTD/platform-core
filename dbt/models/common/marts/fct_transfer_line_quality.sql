{{
    config(materialized='table')
}}
-- fct_transfer_line_quality.sql — 总仓配送出库**行质量构件**（W1 2026-10-12；服务 04-05/04-06/04-07）。
--
-- 【它为什么存在】04-05 批号填写率 / 04-06 零成本暴露 / 04-07 负金额调整是**行级/单头级**的面，
--   聚合构件表（fct_hq_outbound）承载不了，而 L1 单 FROM 不允许指向 staging ⇒ 这三个面的
--   聚合口径落本表（口径在 ④ 定义一次）。粒度 (system_book, bizday, branch_num)。
-- 【基面】与 fct_hq_outbound 的 transfer 域完全同款（state_code=3、out_branch_num=99、排除店间直调）。
-- 【口径逐列（客户文档数据条件逐条落位）】
--   · line_count / lot_filled_lines：04-05 全量版（X08 需批号清单未批 ⇒ 考核版待 X08；空白串视为
--     未填——客户文档「空白和占位字符视为无效」）。
--   · zero_cost_amount / zero_cost_rows：04-06「金额≠0 且已知成本=0」；成本 **null 另列**
--     （missing_cost_amount——客户文档「null 不当 0」，两类暴露不相加）。
--   · negative_order_count / negative_amount：04-07「单头金额<0 的单数与合计」；负数可能是退补/
--     冲红/调整，「不按绝对值变正收入，也不一律称退货」（客户文档原话）。
-- 【wholesale 侧边界】D02 的行级质量面随 v2 补列的勾稽批次另出（本表只 transfer 域）。
with base as (
    select
        system_book,
        bizday,
        branch_num,
        order_no,
        out_money,
        subtotal,
        lot_number
    from {{ ref('stg_lemeng_transfer_out') }}
    where state_code = 3
      and out_branch_num = 99
      and branch_num <> out_branch_num
),
per_order as (
    select
        system_book, bizday, branch_num, order_no,
        max(coalesce(out_money, 0))::numeric(20,2) as order_money
    from base
    group by 1, 2, 3, 4
)
select
    system_book,
    {{ subject_org() }} as org,
    bizday,
    branch_num,
    count(*)                                                          as line_count,
    count(*) filter (
        where lot_number is not null and trim(lot_number) <> ''
    )                                                                 as lot_filled_lines,
    sum(case when coalesce(out_money, 0) <> 0 and coalesce(subtotal, 0) = 0
             then out_money else 0 end)::numeric(20,2)                as zero_cost_amount,
    count(*) filter (
        where coalesce(out_money, 0) <> 0 and coalesce(subtotal, 0) = 0
    )                                                                 as zero_cost_rows,
    sum(case when subtotal is null and coalesce(out_money, 0) <> 0
             then out_money else 0 end)::numeric(20,2)                as missing_cost_amount,
    count(distinct case when order_money < 0 then order_no end)       as negative_order_count,
    sum(case when order_money < 0 then order_money else 0 end)::numeric(20,2) as negative_amount
from base b
join per_order p using (system_book, bizday, branch_num, order_no)
group by 1, 2, 3
