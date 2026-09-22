-- assert_fct_retail_sale_net_amount_nonnegative.sql — 结构断言：净销售额不得为负。
--
-- 契约同对账测试：**返回任何行即失败**。
--
-- 为什么手写而不挂列级 test：dbt 原生的 `accepted_values` 判的是**等值集合**，判不了「≥ 0」
-- 这种区间；`dbt_utils` 有 range 类测试但要加 `packages.yml`（同 grain 那条测试的理由，不引包）。
--
-- ⚠️ 这是**暂定口径下的哨兵，不是口径本身**：当前实现 = 全部明细行金额合计（不剔退货），
--    真实业务里退货/红冲可能确实产生负数行 ⇒ 本断言将来**可能要按业务确认后放宽或改写**
--    （例如「剔除退货后的净额不得为负」）。在那之前它是一道便宜的绊线：负值一旦出现，
--    说明我们对这份数据的形态理解有缺口，应当被人看见，而不是被静默聚进 BI 报表。
select
    system_book,
    bizday,
    net_amount
from {{ ref('fct_retail_sale') }}
where net_amount < 0
