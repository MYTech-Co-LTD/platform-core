-- assert_fct_hq_outbound_grain_unique.sql — 结构断言：fct_hq_outbound 的**复合粒度**必须唯一
-- （**六键**：system_book, bizday, domain, branch_num, region_id, client_fid；各单键都不唯一，
-- 同族手写先例。client_fid 是 2026-10-17 加的第 6 键——批发按客户拆行，transfer 域恒 NULL）。
select
    system_book,
    bizday,
    domain,
    branch_num,
    region_id,
    client_fid,
    count(*) as rows_in_grain
from {{ ref('fct_hq_outbound') }}
group by 1, 2, 3, 4, 5, 6
having count(*) > 1
