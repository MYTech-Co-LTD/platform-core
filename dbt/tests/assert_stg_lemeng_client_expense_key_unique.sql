-- assert_stg_lemeng_client_expense_key_unique.sql — 复合粒度唯一（other_inout_bill_no 即自然键）。
select
    system_book,
    bizday,
    other_inout_bill_no,
    count(*) as rows_in_grain
from {{ ref('stg_lemeng_client_expense') }}
group by 1, 2, 3
having count(*) > 1
