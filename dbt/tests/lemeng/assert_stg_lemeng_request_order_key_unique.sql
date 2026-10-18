-- assert_stg_lemeng_request_order_key_unique.sql — 复合粒度唯一。
select
    system_book,
    bizday,
    order_no,
    item_num,
    count(*) as rows_in_grain
from {{ ref('stg_lemeng_request_order') }}
group by
    system_book,
    bizday,
    order_no,
    item_num
having count(*) > 1
