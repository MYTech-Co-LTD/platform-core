-- assert_stg_forms_submission_key_unique.sql — 结构断言：表单提交 staging 的**行粒度自然键**必须唯一。
--
-- 契约同族测试：**返回任何行即失败**（dbt singular test）。
--
-- 粒度 = (org, submission_id)：submission_id 是提交主键，org 是主体列（同一 id 跨租户不共用）。
-- 为什么值得有：forms 域是「采集 → 提交 → 指派/催办」的源头，一份提交出现两行会让
-- 催办名单重复、提交率被算成 >100%，而列级 tests 一条都不会红。
--
-- 取证（2026-11-12）：在 platform-core-data（mytech 数据面）的 `staging.stg_forms_submission`
-- 上实测 `count(*)` = `count(distinct (org, submission_id))` = 1（当前仅 1 条提交，样本很小；
-- shanhai 实例**未物化 forms 域**，`staging.stg_forms_submission` 不存在 ⇒ 那边没法取证）。
-- 本断言会随 tables 档在该域已物化的实例上跑：样本一旦变大，这条就是真的护栏。
select
    org,
    submission_id,
    count(*) as row_count
from {{ ref('stg_forms_submission') }}
group by org, submission_id
having count(*) > 1
