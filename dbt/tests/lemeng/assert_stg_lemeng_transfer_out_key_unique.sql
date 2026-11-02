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
--
-- ⚠️ **`use_unit` 入键**（2026-11-02）：源侧（乐檬调出单接口）会把同一 (单号, 商品, 批次)
--   按**两种计量单位各记一行**——2026-01-30 实测 3 个键：商品 997「柚子手提袋」，
--   一行 `quantity=2 / use_unit=扎`、一行 `quantity=1 / use_unit=个`，其余 30 列逐字相同，
--   两行金额都是 0.00。**重采同一天原样复现**（不是管线写重），`select distinct *` 也压不掉
--   （两行不同）。业务上「同商品不同单位」就是**两条不同的行**，故把 `use_unit` 纳入自然键；
--   真正危险的**同键同单位值冲突**（会双计金额）仍落进 having count(*) > 1。
select
    system_book,
    bizday,
    order_no,
    item_num,
    item_grade_num,
    lot_number,
    use_unit,
    count(*) as rows_in_key
from {{ ref('stg_lemeng_transfer_out') }}
group by
    system_book,
    bizday,
    order_no,
    item_num,
    item_grade_num,
    lot_number,
    use_unit
having count(*) > 1
