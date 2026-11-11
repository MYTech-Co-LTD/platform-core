-- 每个类别都必须走到 level=1 的祖先（#1913 起是**硬失败**）。
--
-- 数据源（`stg_lemeng_item_category`，乐檬 item.category.find）提供完整树；走不到根 = 树快照
-- 缺节点（采集断链 / 快照不完整）或源树异常 —— 后果是 `category_group` 落 `其他`，持品类
-- scope 的人看不见这些商品（fail-closed 但静默）。所以在这里响亮失败，而不是降级。
--
-- 历史：此前的实现从商品档案反推祖先，中间层节点物理缺失（77 类 / 1,828 商品），当时把本断言
-- 降为 warn；#1913 接入树接口后恢复为 error。
select system_book, category_id, category_name, level, parent_id
from {{ ref('dim_item_category') }}
where top_category_name is null
