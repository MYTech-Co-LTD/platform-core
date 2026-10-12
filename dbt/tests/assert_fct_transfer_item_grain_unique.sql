-- assert_fct_transfer_item_grain_unique.sql — 结构断言：fct_transfer_item 的**复合粒度**必须唯一
-- （三键：system_book, bizday, item_num；同族手写先例）。
select
    system_book,
    bizday,
    item_num,
    count(*) as rows_in_grain
from {{ ref('fct_transfer_item') }}
group by 1, 2, 3
having count(*) > 1
