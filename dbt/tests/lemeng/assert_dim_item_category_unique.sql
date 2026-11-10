-- 唯一性断言：dim_item_category 每个 (system_book, category_id) 只能有一行。
-- 这条一红，dim_item_latest 按类别 left join 就会放大商品行（同 assert_dim_item_latest_unique 的成因）。
select system_book, category_id, count(*) as n
from {{ ref('dim_item_category') }}
group by 1, 2
having count(*) > 1
