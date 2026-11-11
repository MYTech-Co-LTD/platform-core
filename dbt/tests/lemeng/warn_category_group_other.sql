{{ config(severity='warn') }}
-- warn_category_group_other.sql — **哨兵**：有多少商品落进 `其他`（非三类）。
--
-- 为什么是 warn 不是 error：`其他` 本身有合法存在（新品类上线、根映射尚未合并时），
--   硬失败会让整个 lemeng 域的物化失败、冻结全部 relation 的新鲜度水位（同
--   warn_region_unregistered 的裁决）。但 `其他` 的增长意味着**权限面正在少裁数据**——
--   持 水果/标品/耗材 scope 的人都看不见它们，而他们可能本该看见。故必须可见。
--
-- 处置：按 `top_category_name` 去 dim_category_group_map.csv 补映射；null 则先修树（见
--   assert_dim_item_category_root_resolved）。
select
    i.system_book,
    coalesce(i.top_category_name, '<null>') as top_category_name,
    count(*) as item_count
from {{ ref('dim_item_latest') }} i
where i.category_group = '其他'
group by 1, 2
order by item_count desc
