-- assert_stg_lemeng_item_category_key_unique.sql — 结构断言：item category staging 的**行粒度自然键**必须唯一。
--
-- 契约同族测试：**返回任何行即失败**（dbt singular test）。
--
-- 粒度 = (system_book, snapshot, category_id)。账套 × 快照日 × 品类 id（品类树每日快照一行一节点）
-- 全量实测 330 / 330（树规模小，快照全量可一次扫）
--
-- 为什么值得有：staging 是 marts 的唯一上游，粒度一旦放大（源端分页重放 / 覆盖写退化成追加 /
-- join 扇出），所有下游聚合都会成倍偏大，而**列级 tests 一条都不会红**（每行数值都合法）。
-- 空表边界同既有 assert_stg_*：表为空 ⇒ 返回 0 行 = 通过，本文件只判唯一性这一件事。
select
    system_book,
    snapshot,
    category_id,
    count(*) as row_count
from {{ ref('stg_lemeng_item_category') }}
group by     system_book,
    snapshot,
    category_id
having count(*) > 1
