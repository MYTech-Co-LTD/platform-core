-- assert_fct_purchase_concentration_grain_unique.sql — 结构断言：复合粒度必须唯一
-- （三键：system_book, bizday, item_department；各单键都不唯一，同族手写先例）。
--
-- ⚠️ 这条同时守两件事：
--   ① **月度粒度**没被误写成日粒度（bizday 必须是月 1 号）；
--   ② `dim_item` 取最新快照的 join **没有把行放大**（快照表若按 snapshot 分区 join，行数会成倍）。
select
    system_book,
    bizday,
    item_department,
    count(*) as rows_in_grain
from {{ ref('fct_purchase_concentration') }}
group by 1, 2, 3
having count(*) > 1

union all

-- ② 月度粒度守卫：bizday 不是月 1 号 ⇒ 说明有人把日粒度混进来了。
select
    system_book,
    bizday,
    item_department,
    1 as rows_in_grain
from {{ ref('fct_purchase_concentration') }}
where bizday <> date_trunc('month', bizday)::date
