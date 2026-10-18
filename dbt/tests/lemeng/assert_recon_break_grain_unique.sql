-- assert_recon_break_grain_unique.sql — 结构断言：recon_break 的复合粒度必须唯一
-- （system_book, bizday, control, branch_num；同族手写先例）。
select
    system_book,
    bizday,
    control,
    branch_num,
    count(*) as rows_in_grain
from {{ ref('recon_break') }}
group by 1, 2, 3, 4
having count(*) > 1
