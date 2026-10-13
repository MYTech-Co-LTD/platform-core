{{
    config(materialized='table')
}}
-- fct_inventory_snapshot.sql — 库存快照构件（W3 2026-10-13）。
-- 【粒度】(system_book, bizday, branch_num, storehouse_num, item_num)。
-- 【语义】T-1 日结快照（不可回溯——错过即丢）。inventory_money 保留红字。
select
    system_book,
    {{ subject_org() }} as org,
    bizday,
    branch_num,
    storehouse_num,
    item_num,
    inventory_quantity::numeric(20,6) as inventory_quantity,
    inventory_money::numeric(20,2) as inventory_money,
    carry_cost_price::numeric(20,8) as carry_cost_price,
    difference_quantity::numeric(20,6) as difference_quantity,
    difference_money::numeric(20,2) as difference_money
from {{ ref('stg_lemeng_inventory_snapshot') }}
