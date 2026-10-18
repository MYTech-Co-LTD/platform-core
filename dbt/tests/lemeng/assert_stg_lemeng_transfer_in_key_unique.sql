-- assert_stg_lemeng_transfer_in_key_unique.sql — 复合粒度唯一。
select
    system_book,
    bizday,
    order_no,
    item_num,
    lot_number,
    count(*) as rows_in_grain
from {{ ref('stg_lemeng_transfer_in') }}
group by
    system_book,
    bizday,
    order_no,
    item_num,
    lot_number
having count(*) > 1
