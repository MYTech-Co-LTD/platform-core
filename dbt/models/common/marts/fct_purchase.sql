{{
    config(materialized='table')
}}
-- fct_purchase.sql — 采购分析构件（W3 余项 2026-10-13，#640）。
-- 【粒度】(system_book, bizday, supplier_num, item_num) —— summary_types=[supplier,item] 的聚合粒度。
-- 【语义】summary 型直落（无口径再加工，构件 = 原样列别名）。
--   ⚠️ 采购**收货**口径（≠采购订单，客户文档边界）；同品比较须用 base_unit；
--   不同维度查询结果**不可重复相加**（客户文档边界）。
--   ⚠️ branch_nums=[99] 固定采集（3120 门店配送制不采购，采购全在管理中心）——
--   本构件**无门店维度**，不代表门店采购。
select
    system_book,
    {{ subject_org() }} as org,
    bizday,
    supplier_num,
    supplier_code,
    supplier_name,
    item_num,
    item_code,
    item_name,
    item_spec,
    base_unit,
    purchase_item_amount::numeric(20,6) as purchase_item_amount,
    purchase_item_money::numeric(20,2) as purchase_item_money,
    purchase_present_amount::numeric(20,6) as purchase_present_amount,
    purchase_present_money::numeric(20,2) as purchase_present_money,
    purchase_item_return_amount::numeric(20,6) as purchase_item_return_amount,
    purchase_item_return_money::numeric(20,2) as purchase_item_return_money,
    amount_total::numeric(20,6) as amount_total,
    money_total::numeric(20,2) as money_total
from {{ ref('stg_lemeng_item_purchase') }}
