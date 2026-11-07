-- 唯一性断言：dim_item_latest 每个 (system_book, item_num) 只能有一行。
-- 这条一红，所有按商品 join 的分析都会静默放大（2026-11-07 实测扇出约 41 倍）。
select system_book, item_num, count(*) as n
from {{ ref('dim_item_latest') }}
group by 1, 2
having count(*) > 1
