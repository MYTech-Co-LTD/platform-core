-- assert_recon_fact_grain_unique.sql — 结构断言：对账事实表的**复合粒度**必须唯一。
--
-- 粒度 = (system_book, bizday, branch_num)（见 recon_fact.sql 头注「账套 × 对账业务日 × 门店」）。
-- 返回任何行即失败。
--
-- 为什么值得有：这张表是**对账的结论面**——同一家店同一天出现两行，对账两边都会被重复计入，
-- 差额会被放大成「源缺口」，而列级 tests 一条都不会红（每行数值都合法）。FULL JOIN 的两侧
-- 只要有一边按错的键关联，就会静默变多行。
select
    system_book,
    bizday,
    branch_num,
    count(*) as row_count
from {{ ref('recon_fact') }}
group by system_book, bizday, branch_num
having count(*) > 1
