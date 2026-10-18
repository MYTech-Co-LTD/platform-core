-- assert_stg_lemeng_client_key_unique.sql — 结构断言：客户档案 staging 的**快照自然键**必须唯一。
--
-- 契约同族测试：**返回任何行即失败**（dbt singular test）。形状与依据同
-- assert_stg_lemeng_branch_key_unique.sql（复合键、单列 unique 判不了、不引 dbt_utils、
-- 覆盖写幂等的护栏、与 audit_* 的分工、空表边界——五条逐字适用，不复制正文）。
--
-- 键 = (system_book, snapshot, client_fid)：每快照分区整量覆盖写 ⇒ 同分区同客户唯一。
select
    system_book,
    snapshot,
    client_fid,
    count(*) as rows_in_key
from {{ ref('stg_lemeng_client') }}
group by
    system_book,
    snapshot,
    client_fid
having count(*) > 1
