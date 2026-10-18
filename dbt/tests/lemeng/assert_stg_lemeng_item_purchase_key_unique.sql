-- assert_stg_lemeng_item_purchase_key_unique.sql — 复合粒度唯一（#640）。
-- 自然键 = (system_book, bizday, supplier_num, item_num)——summary_types=[supplier,item] 的聚合粒度。
select
    system_book,
    bizday,
    supplier_num,
    item_num,
    count(*) as rows_in_grain
from {{ ref('stg_lemeng_item_purchase') }}
group by
    system_book,
    bizday,
    supplier_num,
    item_num
having count(*) > 1
