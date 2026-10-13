-- assert_fct_inventory_snapshot_grain_unique.sql — 复合粒度唯一（五键）。
select
    system_book, bizday, branch_num, storehouse_num, item_num, count(*) as rows_in_grain
from {{ ref('fct_inventory_snapshot') }}
group by 1, 2, 3, 4, 5
having count(*) > 1
