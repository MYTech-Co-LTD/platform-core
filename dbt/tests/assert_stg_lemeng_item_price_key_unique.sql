-- assert_stg_lemeng_item_price_key_unique.sql — 结构断言：价格批 staging 的**行粒度自然键**必须唯一。
--
-- 契约同族测试：**返回任何行即失败**（dbt singular test）。形状与依据同
-- assert_stg_lemeng_branch_key_unique.sql（复合键、单列 unique 判不了、不引 dbt_utils、
-- 覆盖写幂等的护栏、与 audit_* 的分工、空表边界——五条逐字适用，不复制正文）。
--
-- 键 = (system_book, snapshot, branch_num, item_num, item_grade_num)：
--   分区键两列 + 门店号 + 商品号 + 分级号（主商品行 grade 为 null —— group by 对 null
--   的分组语义恰好把主商品行归成一组，不误报）。
select
    system_book,
    snapshot,
    branch_num,
    item_num,
    item_grade_num,
    count(*) as rows_in_key
from {{ ref('stg_lemeng_item_price') }}
group by
    system_book,
    snapshot,
    branch_num,
    item_num,
    item_grade_num
having count(*) > 1
