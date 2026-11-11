-- 树完整性：每个非根节点的 parent_id 必须能在同一账套的树里找到（#1913）。
-- 断链是采集缺页 / 源树异常的强信号；它会让 root_resolved 也红，但这条先点名「哪条边断了」。
select system_book, category_id, category_name, level, parent_id
from {{ ref('dim_item_category') }}
where level > 1
  and (
    parent_id is null
    or not exists (
      select 1 from {{ ref('dim_item_category') }} p
      where p.system_book = dim_item_category.system_book
        and p.category_id = dim_item_category.parent_id
    )
  )
