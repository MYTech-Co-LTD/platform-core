{{ config(materialized='table') }}
-- dim_item_category.sql — 商品类别树 + 三分类（spec 2026-11-10-data-scope-rbac-design §4.3）。
--
-- 【为什么需要】数据范围权限按 `category_group`（水果 / 标品 / 耗材 / 其他）裁行，而
--   `stg_lemeng_item` 只有**商品自身**的类别字段（`item_category_id/parent_id/level/name`），
--   没有「这个叶子属于哪个根」。级别 1 的根名正好是 data-analysis `category_path` 的首段
--   （3120/64188 实测：生鲜 / 标品 / 废弃档案 / 广西柳州 / 包装耗材 / 运费/仓储用耗材）。
--
-- 【怎么算】沿 `parent_id` 向上走到 `level = 1` 的祖先，取根名 → 查受控 seed
--   `dim_category_group_map`。**不按叶子名/部门名猜**（spec 明令；猜错 = 静默错裁）。
--
-- 【树从哪来】`stg_lemeng_item` 的摊平字段只带**商品被指派的那个类别**及其父 id ⇒ 本模型把
--   **全部快照**里出现过的类别节点并起来当树（不是只取最新快照：某个中间节点可能今天已无商品
--   直接挂它，但昨天挂过——只取最新会断链）。每个 `(system_book, category_id)` 取最新快照的
--   属性（改名以最新为准）。
--
-- 【失败姿态】走不到 `level=1` 祖先的类别，`top_category_name` 为 null、`category_group` 落
--   `其他`。**新根名**（level=1 不在 seed 里）仍是硬失败（`assert_dim_item_category_root_mapped`）；
--   **祖先不可达**（中间层节点从未被商品直接挂过）是 warn（`assert_dim_item_category_root_resolved`）
--   ——2026-11-11 真机实测 77 个类别 / 1,828 商品（4.3%），源契约无 category_path，
--   补数路径见 issue #1913。`warn_category_group_other` 持续报数。
--
-- 【粒度】`(system_book, category_id)` 唯一（`assert_dim_item_category_unique` 钉住）——
--   `dim_item_latest` 按 `(system_book, item_category_id)` left join，重复会放大商品行。
with recursive
cat_tree as (
    -- 每个类别节点取最新快照的属性；全部快照并集保证父链完整。
    select distinct on (system_book, item_category_id)
        system_book,
        snapshot,
        item_category_id      as category_id,
        item_category_parent_id as parent_id,
        item_category_level   as level,
        item_category_name    as category_name
    from {{ ref('stg_lemeng_item') }}
    where item_category_id is not null
    order by system_book, item_category_id, snapshot desc
),
walk as (
    -- 从每个节点向上走；`hop < 10` 是防环护栏（源若是坏数据也不无限递归）。
    select system_book, category_id, category_id as cur_id, 0 as hop
    from cat_tree
    union all
    select w.system_book, w.category_id, c.parent_id, w.hop + 1
    from walk w
    join cat_tree c
        on c.system_book = w.system_book
       and c.category_id = w.cur_id
    where c.parent_id is not null
      and w.hop < 10
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
