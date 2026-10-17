-- assert_fct_contribution_grain_unique.sql — 结构断言：fct_contribution 的**复合粒度**必须唯一
-- （五键：system_book, bizday, domain, branch_num, region_id —— 与 fct_hq_outbound 逐字同粒度；
-- 各单键都不唯一，同族手写先例）。
--
-- ⚠️ 这条断言同时是**「门店费用没有把行放大」的守卫**：branch_expense 已按
-- (账套,业务日,门店) 汇总过，join 上去必须是 1:1；若哪天有人改回逐 expense_type join，
-- 这里会立刻红——那正是「按单据逐行连接费用 ⇒ 一对多放大」这条客户文档禁忌的可机检落点。
select
    system_book,
    bizday,
    domain,
    branch_num,
    region_id,
    count(*) as rows_in_grain
from {{ ref('fct_contribution') }}
group by 1, 2, 3, 4, 5
having count(*) > 1
