-- assert_fct_retail_profit_grain_unique.sql — 结构断言：零售毛利模型复合粒度必须唯一。
-- 契约同对账测试：返回任何行即失败。
-- 粒度 (system_book, bizday, branch_num)；单列各自都不唯一，故手写 group by（同 fct_retail_sale 的理由）。
select
    system_book,
    bizday,
    branch_num,
    count(*) as rows_in_grain
from {{ ref('fct_retail_profit') }}
group by
    system_book,
    bizday,
    branch_num
having count(*) > 1
