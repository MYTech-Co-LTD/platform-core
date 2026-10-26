-- assert_fct_branch_indicator_grain_unique.sql — 复合粒度唯一（三键，同族手写先例）。
select
    system_book, bizday, branch_num, count(*) as rows_in_grain
from {{ ref('fct_branch_indicator') }}
group by 1, 2, 3
having count(*) > 1
