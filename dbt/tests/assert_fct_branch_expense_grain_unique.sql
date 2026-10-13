-- assert_fct_branch_expense_grain_unique.sql — 复合粒度唯一（四键，同族手写先例）。
select
    system_book, bizday, branch_num, expense_type, count(*) as rows_in_grain
from {{ ref('fct_branch_expense') }}
group by 1, 2, 3, 4
having count(*) > 1
