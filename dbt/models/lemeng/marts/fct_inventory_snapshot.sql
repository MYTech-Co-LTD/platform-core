{{
    config(
        materialized='incremental',
        unique_key=['system_book', 'bizday', 'branch_num', 'storehouse_num', 'item_num'],
        incremental_strategy='delete+insert',
        on_schema_change='sync_all_columns'
    )
}}
-- fct_inventory_snapshot.sql — 库存快照构件（W3 2026-10-13）。
-- 【粒度】(system_book, bizday, branch_num, storehouse_num, item_num)。
-- 【语义】T-2 快照（#632 订正：源端发布滞后 16~40h，T-1 通常未发布；历史深可回溯）。inventory_money 保留红字。
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
{% if is_incremental() %}
-- 增量窗口（#1520 W2-P1）：库存快照源端 T-2 发布，7 天 lookback 足够覆盖晚到；
-- 用编译期字面量（incremental_cutoff）才能让 read_parquet 按 bizday 裁剪（#1524 教训）。
where bizday >= {{ incremental_cutoff(7) }}
{% endif %}
