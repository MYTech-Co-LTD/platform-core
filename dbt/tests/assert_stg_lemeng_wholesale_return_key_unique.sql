-- assert_stg_lemeng_wholesale_return_key_unique.sql — 结构断言：stg_lemeng_wholesale_return 的
-- **复合粒度**必须唯一（单列 unique 判不了复合键；不引 dbt_utils，同族先例）。
--
-- 自然键 = (system_book, bizday, wholesale_return_fid, item_num, order_detail_num)
-- （契约 description）。⚠️ order_detail_num 是**推断键**（官方文档未列、A 阶段恒空集未实证）——
-- 若它恒 null，本断言的 DISTINCT 键里 null 不参与去重 ⇒ 退化为
-- (system_book, bizday, wholesale_return_fid, item_num)，同单同商品多行（分批/分价）会假红；
-- 那正是「键名该核了」的大声信号（修法见契约 description 的 schemaVersion 升档注）。
select
    system_book,
    bizday,
    wholesale_return_fid,
    item_num,
    order_detail_num,
    count(*) as rows_in_grain
from {{ ref('stg_lemeng_wholesale_return') }}
group by 1, 2, 3, 4, 5
having count(*) > 1
