-- assert_dim_region_key_unique.sql — 结构断言：战区维的自然键 `(system_book, region_id)` 必须唯一。
--
-- 契约同族测试：**返回任何行即失败**（dbt singular test）。
--
-- 为什么值得单独一条：`dim_region` 被 `dim_lemeng_branch` **left join** 在 `(system_book, region_id)`
-- 上。维侧一重复，门店维就**成倍放大**（`assert_dim_lemeng_branch_key_unique.sql` 才看得见症状，
-- 但那时已经指不到病根）。这条把病根钉在维上：本表手工维护（`branchindicator` 年频枚举 + UI 树
-- 读一级），**重跑枚举时最容易多贴一行**，而多贴的那行每一列看上去都合法。
--
-- 为什么是**复合**键、不是给 `region_id` 单挂 `unique`：两个账套的 id 空间当前不相交
-- （schema.yml 记的口径），但那是**观察**、不是约束——真要出现两账套撞 id，`region_id` 单列
-- `unique` 会**假红**（数据其实完全正确），而复合键照样判得准。
--
-- ⚠️ 空表边界：表为空时返回 0 行 = 通过（seed 恒有 27 行，本表不会为空；此注只为与同族文件口径一致）。
select
    system_book,
    region_id,
    count(*) as rows_in_key
from {{ ref('dim_region') }}
group by
    system_book,
    region_id
having count(*) > 1
