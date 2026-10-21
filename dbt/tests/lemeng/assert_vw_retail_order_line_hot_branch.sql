-- assert_vw_retail_order_line_hot_branch — 视图必须真的把**热侧**（当天 hour= 分区）union 进来。
--
-- 为什么需要单独一条：`assert_vw_retail_order_line_matches_stg` 取闭窗日，而封版后当天热分区
-- 为空（实测 closed-day cold=518429 / hot=0）⇒ 把视图 UNION ALL 的热侧整段删掉它仍然绿。
-- 也就是说闭窗日不变量守的是冷侧与列区，**热侧没有任何常设防线**，而热侧正是「读今天」的那一半。
--
-- 判据为什么取**存在性**而不是行数相等：tick 每 5 分钟重写当天分区，两条计数语句之间有
-- 真实的时间差 ⇒ 等值判据会在 tick 落盘瞬间假红（假红会冻结该域水位）。存在性判据的语义是：
-- **湖热分区今天有行，视图今天却一行都没有** ⇒ 热侧没接线（路径写错 / UNION 漏了 / 谓词写反）。
--
-- 为什么盯「今天」：今天一定在 `_DAY_DATA` 之外（关账后才封版），故今天视图若为 0，只可能是
-- 热侧缺席。实测基线（2026-10-21 16:2x CST）：cold_today=0 / hot_today=5680 / view_today=5680。
with lake as (
    select count(*)::bigint as n
    from read_parquet(
      's3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_order_line_prefix") }}/system_book=*/bizday=*/hour=*/all.parquet'
    ) r
    where cast(r['bizday'] as date) = CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
),
v as (
    select count(*)::bigint as n
    from {{ ref('vw_lemeng_retail_order_line') }}
    where bizday = CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
)
select v.n as vw_today_rows, lake.n as lake_hot_today_rows,
       '热侧没接线：湖的热分区今天有行，视图今天返回 0（漏 UNION / 路径错 / 谓词反）' as note
from v, lake
where lake.n > 0 and v.n = 0
