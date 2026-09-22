-- assert_fct_retail_sale_grain_unique.sql — 结构断言：口径模型的**复合粒度**必须唯一。
--
-- 契约同对账测试：**返回任何行即失败**。
--
-- 为什么单列的 dbt `unique` test 判不了：粒度是 **复合键 (system_book, bizday)**，
-- 两个列**各自都不唯一**（同一账套有很多天、同一天有很多账套）⇒ 给任一个单列挂 `unique` 必红。
-- 不引 `dbt_utils.unique_combination_of_columns` 的理由：那要加 `packages.yml`（多一层依赖、
-- 解析期还要联网），而这条判据本身就是一句 group by —— 手写比引包便宜。
--
-- 为什么这条值得有（粒度漂移是**静默**的）：一旦 fct 因为 join 放大或分组漏列而多出一行，
-- 所有按它聚合的指标（净销售额、订单数）就会**偏大**，而 column 级 tests 一条都不会红
-- （数值仍然合法、非空）。这是 layered §5.1「多层兜底」里最便宜的一层。
--
-- ⚠️ 命名与对账测试区分开：`audit_*.sql` 是**指标对账**（每个声明指标一条，机检规则 ⑦ 逐个查在不在），
--    `assert_*.sql` 是**结构断言**（不按指标数，故没有机检查条数——靠 dbt test 真跑）。
select
    system_book,
    bizday,
    count(*) as rows_in_grain
from {{ ref('fct_retail_sale') }}
group by
    system_book,
    bizday
having count(*) > 1
