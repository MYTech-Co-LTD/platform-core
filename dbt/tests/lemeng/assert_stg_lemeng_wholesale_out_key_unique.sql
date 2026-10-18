-- assert_stg_lemeng_wholesale_out_key_unique.sql — 结构断言：批发单 staging 的**行粒度自然键**必须唯一。
--
-- 契约同族测试：**返回任何行即失败**（dbt singular test）。形状与依据同
-- assert_stg_lemeng_branch_key_unique.sql（复合键、单列 unique 判不了、不引 dbt_utils、
-- 覆盖写幂等的护栏、与 audit_* 的分工、空表边界——五条逐字适用，不复制正文）。
--
-- 键 = 事件键 (system_book, bizday, order_no, order_detail_num)：
--   bizday = 制单日（每分区写一次不重写 ⇒ 同分区同键唯一）；order_detail_num 同单内唯一
--   ⇒ 无需 item/lot 维（与调出单按 lot 拆行不同，批发单行号天然唯一）。
select
    system_book,
    bizday,
    order_no,
    order_detail_num,
    count(*) as rows_in_key
from {{ ref('stg_lemeng_wholesale_out') }}
group by
    system_book,
    bizday,
    order_no,
    order_detail_num
having count(*) > 1
