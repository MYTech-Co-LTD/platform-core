-- assert_fct_branch_day_activity_grain_unique.sql — 结构断言：fct_branch_day_activity 的
-- **复合粒度**必须唯一（三键：system_book, bizday, branch_num；同族手写先例）。
select
    system_book,
    bizday,
    branch_num,
    count(*) as rows_in_grain
from {{ ref('fct_branch_day_activity') }}
group by 1, 2, 3
having count(*) > 1
