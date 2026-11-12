-- assert_stg_lemeng_business_collection_coupon_key_unique.sql — 结构断言：business collection coupon staging 的**行粒度自然键**必须唯一。
--
-- 契约同族测试：**返回任何行即失败**（dbt singular test）。
--
-- 粒度 = (system_book, bizday, branch_num, coupon_type_name)。账套 × 业务日 × 门店 × 券类型
-- 2026-11-01..11-12 窗口实测 3 / 3（样本很小，属稀疏件；结构上按券类型分行）
--
-- 为什么值得有：staging 是 marts 的唯一上游，粒度一旦放大（源端分页重放 / 覆盖写退化成追加 /
-- join 扇出），所有下游聚合都会成倍偏大，而**列级 tests 一条都不会红**（每行数值都合法）。
-- 空表边界同既有 assert_stg_*：表为空 ⇒ 返回 0 行 = 通过，本文件只判唯一性这一件事。
select
    system_book,
    bizday,
    branch_num,
    coupon_type_name,
    count(*) as row_count
from {{ ref('stg_lemeng_business_collection_coupon') }}
group by     system_book,
    bizday,
    branch_num,
    coupon_type_name
having count(*) > 1
