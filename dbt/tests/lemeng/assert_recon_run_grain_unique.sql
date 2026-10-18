-- assert_recon_run_grain_unique.sql — 结构断言：recon_run 的复合粒度必须唯一
-- （system_book, bizday, control；同族手写先例）。
select
    system_book,
    bizday,
    control,
    count(*) as rows_in_grain
from {{ ref('recon_run') }}
group by 1, 2, 3
having count(*) > 1
