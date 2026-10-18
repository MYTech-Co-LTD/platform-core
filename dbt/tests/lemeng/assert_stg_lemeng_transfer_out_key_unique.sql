-- assert_stg_lemeng_transfer_out_key_unique.sql — 结构断言：调出单 staging 的**行粒度自然键**必须唯一。
--
-- 契约同族测试：**返回任何行即失败**（dbt singular test）。形状与依据同
-- assert_stg_lemeng_branch_key_unique.sql（复合键、单列 unique 判不了、不引 dbt_utils、
-- 覆盖写幂等的护栏、与 audit_* 的分工、空表边界——五条逐字适用，不复制正文）。
--
-- 键 = 事件键 (system_book, bizday, order_no, item_num, item_grade_num, lot_number)：
--   bizday = 单据制单日（每分区写一次不重写 ⇒ 同分区同键唯一）；
--   同单同商品可分批次多行 ⇒ lot_number 入键；item_grade_num 为 null 的主商品行
--   在 group by 语义下自成一组，不误报。
select
    system_book,
    bizday,
    order_no,
    item_num,
    item_grade_num,
    lot_number,
    count(*) as rows_in_key
from {{ ref('stg_lemeng_transfer_out') }}
group by
    system_book,
    bizday,
    order_no,
    item_num,
    item_grade_num,
    lot_number
having count(*) > 1
