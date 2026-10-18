-- assert_fct_request_fulfillment_grain_unique.sql — 复合粒度唯一（四键）。
select
    system_book, bizday, branch_num, item_num, count(*) as rows_in_grain
from {{ ref('fct_request_fulfillment') }}
group by 1, 2, 3, 4
having count(*) > 1
