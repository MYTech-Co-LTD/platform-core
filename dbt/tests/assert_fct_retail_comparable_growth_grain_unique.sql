-- assert_fct_retail_comparable_growth_grain_unique.sql — 结构断言：fct_retail_comparable_growth 的
-- **复合粒度**必须唯一（三键：system_book, period_days, bizday；同族手写先例）。
select
    system_book,
    period_days,
    bizday,
    count(*) as rows_in_grain
from {{ ref('fct_retail_comparable_growth') }}
group by 1, 2, 3
having count(*) > 1
