-- dim_item_latest.sql — 商品当前档案（W7 Task 2 前置，issue #1536）。
--
-- 为什么需要：`stg_lemeng_item` 是**快照流水**（实测 1,739,901 行 / 40,516 商品 ≈ 42 行/商品，
-- `snapshot` 有 42 个取值）。直接拿它 join 会按快照份数放大行数——实测 7,221 行连成 298,709 行
-- （约 41 倍），金额会被静默放大。
--
-- 本模型只做一件事：**每个商品保留最新一版**，一个商品一行（按 `snapshot` 取最新）。
-- 唯一性由 `dbt/tests/lemeng/assert_dim_item_latest_unique.sql` 钉住。
{{
    config(
        materialized='table',
        unique_key=['system_book', 'item_num'],
        on_schema_change='sync_all_columns'
    )
}}

select distinct on (system_book, item_num)
    {{ subject_org() }} as org,
    system_book,
    item_num,
    item_code,
    item_name,
    item_type,
    unit_name,
    spec,
    snapshot,
    eliminate_flag
from {{ ref('stg_lemeng_item') }}
order by system_book, item_num, snapshot desc
