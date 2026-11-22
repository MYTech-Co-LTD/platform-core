-- assert_serving_view_matches_main.sql — 服务视图与 staging 权威面逐日**行数+金额**必须相等（#1916 P2；#2665 升级）。
--
-- `vw_lemeng_retail_order_line` / `vw_lemeng_retail_order_line_month` 是 drill 的两个读面
-- （月文件冷腿 + 日腿 + 小时热腿）。它们与 staging（`_DAY_DATA` + 小时）在任一 (账套, 日) 上
-- 行数或 sum(sale_money) 不一致，就是读面边界或月文件内容漂移。
-- ⚠️ #2665 教训：旧版只比**行数**、且比的是两个服务视图**互相**——洞在日内（行数相等、金额少了），
--   「错得一致」让测试绿着漏过 ~20 小时/天的低估窗口。故本版：逐视图对 **staging（权威）**，
--   行数与金额双对账。返回任何行即失败。
with s as (
    select system_book, bizday, count(*) n, sum(sale_money) amt
    from {{ ref('stg_lemeng_retail_order_line') }}
    where bizday >= date '{{ var("serving_check_start", "2026-10-01") }}'
    group by 1, 2
),
v as (
    select 'vw' as view_name, system_book, bizday, count(*) n, sum(sale_money) amt
    from {{ ref('vw_lemeng_retail_order_line') }}
    where bizday >= date '{{ var("serving_check_start", "2026-10-01") }}'
    group by 1, 2, 3
),
m as (
    select 'vw_month' as view_name, system_book, bizday, count(*) n, sum(sale_money) amt
    from {{ ref('vw_lemeng_retail_order_line_month') }}
    where bizday >= date '{{ var("serving_check_start", "2026-10-01") }}'
    group by 1, 2, 3
),
t as (
    select * from v
    union all
    select * from m
)
select t.view_name,
       coalesce(t.system_book, s.system_book) as system_book,
       coalesce(t.bizday, s.bizday) as bizday,
       t.n as serving_rows, s.n as main_rows,
       t.amt as serving_amt, s.amt as main_amt
from t
full join s
  on s.system_book = t.system_book and s.bizday = t.bizday
where coalesce(t.n, -1) <> coalesce(s.n, -1)
   or coalesce(t.amt, -1) <> coalesce(s.amt, -1)
