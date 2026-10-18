-- assert_stg_lemeng_branch_expense_key_unique.sql — 复合粒度唯一（bill_no 即自然键，账套日分区兜底）。
select
    system_book,
    bizday,
    bill_no,
    count(*) as rows_in_grain
from {{ ref('stg_lemeng_branch_expense') }}
group by 1, 2, 3
having count(*) > 1
