{{
    config(materialized='table')
}}
-- fct_transfer_item.sql — 总仓配送出库**商品粒度**构件（W1 2026-10-12；服务 06-03 商品出库毛利率）。
--
-- 【与 fct_hq_outbound 的关系】同一基面（state_code=3 且 out_branch_num=99 且排除店间直调）、
--   同一套 R/C 构件口径（行级 out_money / subtotal），但按商品聚合——客户 06-03 要按 item_num
--   出毛利率。两条域不能混：本表只 transfer 域（批发侧商品毛利随 D02 v2 补列的勾稽另批）。
-- 【粒度】(system_book, bizday, item_num)——被 assert_fct_transfer_item_grain_unique 钉住。
-- 【org / 精度】同 fct_hq_outbound（宏注入 / ::numeric(20,2)）。
-- 【批发明细成本的勾稽边】客户文档 06-03 数据条件「批发明细先与单头成本勾稽，差额单列或经批准
--   分配；不能将整张单头成本分配给每个商品」——本表 transfer 侧用行级 subtotal（天然行级，无此问题）；
--   该条款是**不给 wholesale 出商品粒度毛利**的原因之一。
with item_lines as (
    select
        system_book,
        bizday,
        item_num,
        sum(out_money)::numeric(20,2) as r_net,
        sum(subtotal)::numeric(20,2)  as c_cost
    from {{ ref('stg_lemeng_transfer_out') }}
    where state_code = 3
      and out_branch_num = 99
      and branch_num <> out_branch_num
    group by 1, 2, 3
)
select
    system_book,
    {{ subject_org() }} as org,
    bizday,
    item_num,
    r_net,
    c_cost,
    (r_net - c_cost)::numeric(20,2) as g_gross
from item_lines
