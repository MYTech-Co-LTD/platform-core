-- 每个类别都必须走到 level=1 的祖先（否则 top_category_name 为 null ⇒ category_group 落 其他）。
-- 断链 = 类别树不完整（父节点从未在任何快照里被商品直接挂过）或源数据坏。
-- 后果与「根未映射」同：category scope 看不见这些商品。故同样是硬失败。
select system_book, category_id, category_name, level, parent_id
from {{ ref('dim_item_category') }}
where top_category_name is null
