-- assert_serving_view_matches_main.sql — 月感知服务视图与主视图逐日行数必须相等（#1916 P2）。
--
-- `vw_lemeng_retail_order_line_month` 是 drill 读历史范围用的服务视图（按 month 分区裁剪）。
-- 它手写 25 列投影 + 月/热两腿，任何一处漂移都会让 drill 数变——本测试按 (账套, 日) 对账。
-- 返回任何行即失败。
with a as (
    select system_book, bizday, count(*) n
    from {{ ref('vw_lemeng_retail_order_line') }}
    where bizday >= date '{{ var("serving_check_start", "2026-10-01") }}'
    group by 1, 2
),
b as (
    select system_book, bizday, count(*) n
    from {{ ref('vw_lemeng_retail_order_line_month') }}
    where bizday >= date '{{ var("serving_check_start", "2026-10-01") }}'
    group by 1, 2
)
select coalesce(a.system_book, b.system_book) as system_book,
       coalesce(a.bizday, b.bizday) as bizday,
       a.n as main_rows, b.n as serving_rows
from a full join b on a.system_book = b.system_book and a.bizday = b.bizday
where coalesce(a.n, -1) <> coalesce(b.n, -1)
