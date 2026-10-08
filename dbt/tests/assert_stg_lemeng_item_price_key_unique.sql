-- assert_stg_lemeng_item_price_key_unique.sql — 结构断言：价格批 staging 的**行粒度自然键**必须唯一。
--
-- 契约同族测试：**返回任何行即失败**（dbt singular test）。形状与依据同
-- assert_stg_lemeng_branch_key_unique.sql（复合键、单列 unique 判不了、不引 dbt_utils、
-- 覆盖写幂等的护栏、与 audit_* 的分工、空表边界——五条逐字适用，不复制正文）。
--
-- 键 = 事件键 (system_book, bizday, branch_num, item_num, item_grade_num, last_edit_time)：
--   R1 增量模型下行 = 变更事件，同 key 不同 last_edit_time 跨天多行是**合法**的
--   ⇒ 唯一性必须含事件时间；少它则「同一天同一价格改两次」误红，多 bizday 维则跨天重改误红。
select
    system_book,
    bizday,
    branch_num,
    item_num,
    item_grade_num,
    last_edit_time,
    count(*) as rows_in_key
from {{ ref('stg_lemeng_item_price') }}
group by
    system_book,
    bizday,
    branch_num,
    item_num,
    item_grade_num,
    last_edit_time
having count(*) > 1
