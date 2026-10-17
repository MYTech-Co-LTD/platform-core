-- assert_fct_inventory_coverage_grain_unique.sql — 结构断言：覆盖天数构件的复合粒度必须唯一。
--
-- 契约同对账测试：**返回任何行即失败**。粒度 = (system_book, bizday, branch_num, item_num)。
--
-- 为什么这条值得有：覆盖天数是**比率**，粒度一放大就会让同 (店,商品,日) 出现多行，
-- 而比率 L1 的上滚是 `sum(分子)/sum(分母)` ⇒ 多行会被**静默加总**，得到一个看着正常的错数。
select
    system_book,
    bizday,
    branch_num,
    item_num,
    count(*) as rows_in_grain
from {{ ref('fct_inventory_coverage') }}
group by system_book, bizday, branch_num, item_num
having count(*) > 1

union all

-- 分母的口径守卫：日均非空时必须是正数（净销量 ≤0 的行已被置 NULL，见模型头注）。
select
    system_book,
    bizday,
    branch_num,
    item_num,
    1 as rows_in_grain
from {{ ref('fct_inventory_coverage') }}
where avg_daily_net_quantity is not null
  and avg_daily_net_quantity <= 0
