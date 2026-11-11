{{ config(severity='warn') }}
-- warn: 品类的 level=1 祖先是否可达（spec 2026-11-10 §4.3）。
--
-- 【为什么是 warn 不是 error（2026-11-11 真机实测）】商品维只带**商品自己被指派的那个类别**
-- 及其 `parent_id`——中间层节点（level 2–4）若没有任何商品直接挂它，就不在任何快照里出现，
-- 祖先链在 lake 上**物理不可达**。实测：281 个类别里 77 个（level 3:36 / 4:29 / 5:12）走不到
-- 根，涉及 1,828 个在售商品（4.3%）⇒ `category_group` 落 `其他`。源契约没有
-- `category_path`/`parent_name` 字段（`contracts/common/lemeng.item.json` 已核），无法就地补。
--
-- 后果是**fail-closed**（不是算错）：这 1,828 个商品对持 水果/标品/耗材 scope 的人不可见，
-- admin / 全店不受影响。用 error 会让整个 lemeng 域物化失败、冻结全部新鲜度水位——代价与收益
-- 不成比例（同 `warn_region_unregistered` 的裁决）。补数路径：接乐檬品类树接口或一次性导入
-- 祖先节点（issue #1913），不要按 `item_department_name` 猜（实测同名部门跨多个根：
-- root=标品/废弃档案 都有 dept=零食部 ⇒ 按部门映射会错）。
--
-- 【留作判据】这 77 个类别应随品类树接入而下降；长期非 0 ⇒ 说明接入未落地或源树变了。
select system_book, category_id, category_name, level, parent_id
from {{ ref('dim_item_category') }}
where top_category_name is null
