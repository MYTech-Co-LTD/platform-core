-- dim_item_latest.sql — 商品当前档案（W7 Task 2 前置，issue #1536）。
--
-- 为什么需要：`stg_lemeng_item` 是**快照流水**（实测 1,739,901 行 / 40,516 商品 ≈ 42 行/商品，
-- `snapshot` 有 42 个取值）。直接拿它 join 会按快照份数放大行数——实测 7,221 行连成 298,709 行
-- （约 41 倍），金额会被静默放大。
--
-- 本模型只做一件事：**每个商品保留最新一版**，一个商品一行（按 `snapshot` 取最新）。
-- 唯一性由 `dbt/tests/lemeng/assert_dim_item_latest_unique.sql` 钉住。
--
-- 数据范围权限（spec 2026-11-10 §4.3）在这里补上 `category_group`：category scope 按
-- `(system_book, item_num)` 子查询裁行，读的就是本模型的这两列。类别树/映射在
-- `dim_item_category`（单独模型，避免本模型再长一棵递归 CTE）；`top_category_name` 保留供
-- 分析面追溯「这个商品为什么落这个组」。
--
-- ⚠️ join **必须**带 `system_book`：两账套类别 id 空间不相交，裸 `category_id` 会串账套。
-- ⚠️ join 是 left：类别缺失（源数据缺字段）仍照出商品行，`category_group` 为 null ⇒ scope 的
--    category 谓词会把它裁掉（fail-closed）；该情形由 `assert_dim_item_category_root_mapped`
--    （硬）与 `assert_dim_item_category_root_resolved` / `warn_category_group_other`（warn）盯着。
{{
    config(
        materialized='table',
        unique_key=['system_book', 'item_num'],
        on_schema_change='sync_all_columns'
    )
}}

select distinct on (i.system_book, i.item_num)
    {{ subject_org() }} as org,
    i.system_book,
    i.item_num,
    i.item_code,
    i.item_name,
    i.item_type,
    i.unit_name,
    i.spec,
    i.snapshot,
    i.item_category_id,
    c.top_category_name,
    c.category_group,
    i.eliminate_flag
from {{ ref('stg_lemeng_item') }} i
left join {{ ref('dim_item_category') }} c
    on c.system_book = i.system_book
   and c.category_id = i.item_category_id
order by i.system_book, i.item_num, i.snapshot desc
