-- assert_dim_client_region_unique — 客户维的粒度唯一性：`(system_book, client_fid)` 只许一行。
--
-- 为什么需要：`dim_lemeng_client` 的匹配链有三条分支（自动唯一命中 / 受控覆盖 / 都不命中），
-- 三条都用 left join 拼——任何一条 join 键写错（漏 system_book、seed 里同一客户重复登记）都会
-- 让一个客户出多行，而下游按客户 join 出库时会**静默放大金额**（一行客户 → N 行出库）。
-- 单列约束抓不住（system_book / client_fid 各自都不唯一）。
select
    system_book,
    client_fid,
    count(*) as n,
    '客户维粒度不唯一：同一客户出现多行（匹配链 join 写错 / seed 重复登记）' as note
from {{ ref('dim_lemeng_client') }}
group by 1, 2
having count(*) > 1
