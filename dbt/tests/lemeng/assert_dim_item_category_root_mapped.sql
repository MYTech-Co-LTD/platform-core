-- 根类别必须在受控映射 seed 里（spec 2026-11-10 §4.3 质量门禁）。
-- 为什么是**硬失败**而不是 warn：新根静默落 category_group='其他' ⇒ 持该品类 scope 的人
-- 看不见本属于他的数据，而报表不报错、权限面看起来也「有裁」。这属于正确性问题，不是标签问题。
-- 处置：按告警的根名在 dbt/seeds/dim_category_group_map.csv 补一行（走 PR），不要改 SQL 里的 CASE。
select
    c.system_book,
    c.category_name as top_category_name,
    count(*) as category_count,
    min(c.category_id) as example_category_id
from {{ ref('dim_item_category') }} c
where c.level = 1
  and not exists (
      select 1
      from {{ ref('dim_category_group_map') }} m
      where m.top_category_name = c.category_name
  )
group by 1, 2
