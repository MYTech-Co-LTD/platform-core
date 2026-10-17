-- assert_fct_retail_quantity_grain_unique.sql — 结构断言：净销量构件的**复合粒度**必须唯一。
--
-- 契约同对账测试：**返回任何行即失败**。粒度 = (system_book, bizday, branch_num, item_num)
-- （2026-10-17 由门店级扩到商品级），各列都不唯一，故手写 group by 判。
--
-- 为什么这条值得有：净销量是「库存覆盖天数」的**分母**。粒度一放大（分组漏列 / join 放大），
-- 净销量就偏大 ⇒ 覆盖天数偏小 ⇒ 补货决策偏激进。而列级 tests 一条都不会红（数值仍合法）。
select
    system_book,
    bizday,
    branch_num,
    item_num,
    count(*) as rows_in_grain
from {{ ref('fct_retail_quantity') }}
group by system_book, bizday, branch_num, item_num
having count(*) > 1
