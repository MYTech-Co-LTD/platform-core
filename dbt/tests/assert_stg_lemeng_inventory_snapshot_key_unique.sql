-- assert_stg_lemeng_inventory_snapshot_key_unique.sql — 复合粒度唯一。
select
    system_book,
    bizday,
    branch_num,
    storehouse_num,
    item_num,
    count(*) as rows_in_grain
from {{ ref('stg_lemeng_inventory_snapshot') }}
group by
    system_book,
    bizday,
    branch_num,
    storehouse_num,
    item_num
having count(*) > 1
