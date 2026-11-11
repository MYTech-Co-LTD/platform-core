{{ config(materialized='table') }}
-- dim_item_category.sql — 商品类别树 + 三分类（spec 2026-11-10-data-scope-rbac-design §4.3）。
--
-- 【数据源（#1913，2026-11-11 改）】直接读**类别树快照** `stg_lemeng_item_category`
--   （乐檬接口 nhsoft.base.ai.item.category.find，L0 管线每日采集）。
--   旧实现是从商品档案反推祖先：`stg_lemeng_item` 只带商品被指派的叶子，中间层节点若没有
--   商品直接挂它就**不在任何快照里出现** ⇒ 真机实测 77 个类别（1,828 商品 / 4.3%）走不到根。
--   树快照把 L1–L5 全节点直接给出（3120 163 / 64188 167），反推路径整体退役。
--
-- 【怎么算】每个快照取「每个 category_id 的最新一行」→ 沿 `parent_id` 走到 `level = 1` 的祖先，
--   取根名 → 查受控 seed `dim_category_group_map`。**不按叶子名/部门名猜**（spec 明令）。
--
-- 【失败姿态】树缺祖先（走不到 level=1）⇒ `top_category_name` 为 null、`category_group` 落
--   `其他`。数据源契约保证树完整，故 `assert_dim_item_category_root_resolved` 是**硬失败**；
--   新根名未映射仍是硬失败（`assert_dim_item_category_root_mapped`）。
--
-- 【粒度】`(system_book, category_id)` 唯一（`assert_dim_item_category_unique` 钉住）——
--   `dim_item_latest` 按 `(system_book, item_category_id)` left join，重复会放大商品行。
with recursive
cat_tree as (
    -- 每个节点取最新快照的属性；同一 category_id 跨快照改名以最新为准。
    select distinct on (system_book, category_id)
        system_book,
        category_id,
        parent_id,
        level,
        category_name
    from {{ ref('stg_lemeng_item_category') }}
    order by system_book, category_id, snapshot desc
),
walk as (
    -- 从每个节点向上走；`hop < 12` 是防环护栏（实测最深 5 层，留余量）。
    select system_book, category_id, category_id as cur_id, 0 as hop
    from cat_tree
    union all
    select w.system_book, w.category_id, c.parent_id, w.hop + 1
    from walk w
    join cat_tree c
        on c.system_book = w.system_book
       and c.category_id = w.cur_id
    where c.parent_id is not null
      and w.hop < 12
),
root_of as (
    select w.system_book, w.category_id, c.category_name as top_category_name
    from walk w
    join cat_tree c
        on c.system_book = w.system_book
       and c.category_id = w.cur_id
    where c.level = 1
)
select
    c.system_book,
    {{ subject_org() }} as org,
    c.category_id,
    c.parent_id,
    c.level,
    c.category_name,
    r.top_category_name,
    coalesce(m.category_group, '其他') as category_group
from cat_tree c
left join root_of r
    on r.system_book = c.system_book
   and r.category_id = c.category_id
left join {{ ref('dim_category_group_map') }} m
    on m.top_category_name = r.top_category_name
