-- assert_fct_client_expense_grain_unique.sql — 复合粒度唯一（四键）。
select
    system_book, bizday, client_fid, other_inout_kind, count(*) as rows_in_grain
from {{ ref('fct_client_expense') }}
group by 1, 2, 3, 4
having count(*) > 1
