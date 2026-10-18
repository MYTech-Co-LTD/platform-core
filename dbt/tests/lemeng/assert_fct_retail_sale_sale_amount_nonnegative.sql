-- assert_fct_retail_sale_sale_amount_nonnegative.sql — 结构断言：**销售侧**金额不得为负。
--
-- 契约同对账测试：**返回任何行即失败**。
--
-- ⚠️ 2026-10-17（issue #813）**断言对象从 `net_amount` 换成 `sale_amount`**：口径改为
--    「销售侧 − 退货侧」后，`net_amount` **可以**为负（某店某日退货 > 销售是合法形态），
--    再拿它判非负就是假红。销售侧本身仍不该为负（那是数据形态理解出缺口的信号）。
--    这正是旧文件头注预告过的放宽（「本断言将来可能要按业务确认后放宽或改写」）。
--
-- 为什么手写而不挂列级 test：dbt 原生的 `accepted_values` 判的是**等值集合**，判不了「≥ 0」
-- 这种区间；`dbt_utils` 有 range 类测试但要加 `packages.yml`（同 grain 那条测试的理由，不引包）。
select
    system_book,
    bizday,
    sale_amount
from {{ ref('fct_retail_sale') }}
where sale_amount < 0
