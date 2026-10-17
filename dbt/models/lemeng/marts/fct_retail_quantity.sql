{{
    config(materialized='table')
}}
-- fct_retail_quantity.sql — **零售净销量**构件（#769，2026-10-17）。
--
-- 【它为谁服务】客户项 `03-07` 库存覆盖天数的**分母**：
--   日均净销量＝ΣN日(sale_num−return_num)/可比营业日数；覆盖天数＝可售库存/日均净销量。
--   ⚠️ 「N」先按裁5 **只出分子/分母**（2026-10-17 首次交付）；此后用户裁决 **N = 月日均**
--   （当月至今的日均），覆盖天数由 `fct_inventory_coverage` + `inventory:coverage_days` 交付。
--
-- 【粒度 (system_book, bizday, branch_num, item_num)】—— 2026-10-17 由门店级**扩到商品级**：
--   覆盖天数的客户粒度是「门店×商品×单位」，分母必须同粒度。门店级汇总照常可用（对表达式求和）。
--
-- 【为什么单开一张 mart，而不并进 fct_retail_sale】两者的**基面不同**：
--   · `fct_retail_sale` 的净额口径是「FINISHED + SALE_ORDER」，且按裁1 **不冲退货单**（平台 sale_money 语义）；
--   · 本构件的净销量按客户原文 `sale_num − return_num`，**必须把退货行减掉**。
--   同一个模型里塞两种基面，会让「口径只定义一次」变成「一个模型两套口径」——那是歧义温床。
--
-- 【⚠️ quantity 对退货行也是正数（真机实证 2026-10-17，3120 全量）】
--   所以净销量**只能按单据类型分类，不能靠符号**：
--     SALE_ORDER            FINISHED  416,516 行  713,804.49
--     SALE_ORDER            CANCELED    9,875 行   23,394.69   ← 作废销售，不计
--     FULL_ORDER_RETURN     FINISHED    1,569 行    5,240.70
--     PARTIAL_ORDER_RETURN  FINISHED      268 行      495.40
--     NO_ORDER_RETURN       FINISHED       49 行      131.51
--     REPAID_RETURN         REPAID      1,601 行    3,929.69
--     REPAID_RETURN         CANCELED       41 行      113.31   ← 作废退货，不计
--
-- 【两处解释性落地（客户原文没细到这一层，L1 标 experimental）】
--   ① `REPAID_RETURN`（已退款退货）**计入退货**；
--   ② `state=CANCELED` 的销售与退货**都不计**。
--   用 `like '%RETURN%'` 而不是枚举 IN：单据类型是**外部系统**的枚举，新增退货类型时
--   宁可自动纳入，也不要静默漏减（漏减 = 净销量虚高 = 覆盖天数虚高 = 补货决策偏保守）。
--
-- 【粒度】(system_book, bizday, branch_num) —— 与 fct_retail_sale 同粒度，便于消费面并排取用。
with base as (
    select
        system_book,
        bizday,
        branch_num,
        item_num,
        case when order_transaction_type = 'SALE_ORDER' and state = 'FINISHED'
             then quantity else 0 end as sale_quantity,
        case when order_transaction_type like '%RETURN%' and state in ('FINISHED', 'REPAID')
             then quantity else 0 end as return_quantity
    from {{ ref('stg_lemeng_retail_order_line') }}
)
select
    system_book,
    {{ subject_org() }} as org,
    bizday,
    branch_num,
    item_num,
    sum(sale_quantity)::numeric(20, 3)                          as sale_quantity,
    sum(return_quantity)::numeric(20, 3)                        as return_quantity,
    (sum(sale_quantity) - sum(return_quantity))::numeric(20, 3) as net_quantity
from base
group by system_book, bizday, branch_num, item_num
