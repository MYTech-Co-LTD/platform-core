-- assert_fct_hq_outbound_grain_unique.sql — 结构断言：fct_hq_outbound 的**复合粒度**必须唯一
-- （五键：system_book, bizday, domain, branch_num, region_id；各单键都不唯一，同族手写先例）。
select
    system_book,
    bizday,
    domain,
    branch_num,
    region_id,
    count(*) as rows_in_grain
from {{ ref('fct_hq_outbound') }}
group by 1, 2, 3, 4, 5
having count(*) > 1
