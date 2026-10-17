-- assert_fct_client_contribution_grain_unique.sql — 结构断言：fct_client_contribution 的
-- **复合粒度**必须唯一（三键：system_book, bizday, client_fid；同族手写先例）。
--
-- ⚠️ 这条断言同时守两件事：① 出库侧/费用侧聚合的键没有漏（漏一个 ⇒ 同键多行）；
--    ② FULL JOIN 的键两侧类型对齐（类型不齐 ⇒ join 不上 ⇒ 行数膨胀，这里立刻红）。
select
    system_book,
    bizday,
    client_fid,
    count(*) as rows_in_grain
from {{ ref('fct_client_contribution') }}
group by 1, 2, 3
having count(*) > 1
