-- assert_dim_lemeng_branch_key_unique.sql — 结构断言：门店维的行粒度自然键必须唯一。
--
-- 契约同族测试：**返回任何行即失败**（dbt singular test）。
--
-- 为什么必须判：本模型是 `stg_lemeng_branch` **left join** `dim_region` 的产物。只要 join 键
-- 在维侧不唯一（`dim_region` 里同一 `(system_book, region_id)` 出现两行），维就被**放大**——
-- 门店数随战区重复数成倍增长，而每一列看上去都合法。`dim_region` 侧另有
-- `assert_dim_region_key_unique.sql` 直接守这条前提；本文件守**结果**（放大是下游唯一看得见的症状）。
--
-- 键为什么是 `(system_book, snapshot, branch_num)`：与 `assert_stg_lemeng_branch_key_unique.sql`
-- 逐字同键（本模型粒度与 staging 一致）。单列各自都不唯一 —— `branch_num` 在两账套的快照里会重排，
-- `snapshot` / `system_book` 是分区键、每行都重复 ⇒ 给任一个单列挂 `unique` 必红。
--
-- ⚠️ 空表边界：表为空时返回 0 行 = 通过，而那个"通过"没有信息量（同 `assert_stg_lemeng_branch_key_unique.sql`）。
select
    system_book,
    snapshot,
    branch_num,
    count(*) as rows_in_key
from {{ ref('dim_lemeng_branch') }}
group by
    system_book,
    snapshot,
    branch_num
having count(*) > 1
