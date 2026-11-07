-- assert_fct_order_event_grain_unique.sql — 结构断言：fct_order_event 的**行级事件粒度**
-- 必须唯一（system_book, bizday, order_no, order_detail_num）。各单键都不唯一；
-- 复用热/冷 glob 重叠若有重复，这里会亮。
select
    system_book,
    bizday,
    order_no,
    order_detail_num,
    count(*) as rows_in_grain
from {{ ref('fct_order_event') }}
group by 1, 2, 3, 4
having count(*) > 1
