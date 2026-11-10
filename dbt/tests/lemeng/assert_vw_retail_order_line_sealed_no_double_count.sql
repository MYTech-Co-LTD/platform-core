-- assert_vw_retail_order_line_sealed_no_double_count.sql — 已封版日冷热双算结构断言（#1872）。
--
-- 复算：对 `data.lemeng_daily_sealed` 里的每一天，视图行数必须等于 `_DAY_DATA` 冷腿行数。
-- 若视图更多 ⇒ hot 小时文件被计入（封版表漏了该行，或读侧没走封版表）⇒ 双算。
--
-- 只读 `_DAY_DATA` + 视图 + 封版表；**不读 `_DAILY/*.parquet`**（那正是 #1872 的慢/崩路径）。
-- 返回任何行即失败（dbt singular test 契约）。
with sealed as (
    select system_book, bizday
    from data.lemeng_daily_sealed
    where system_book <> ''
      and bizday >= date '{{ window_start_date() }}'
),
cold as (
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date as bizday,
        count(*)::bigint as n
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_order_line_prefix") }}/_DAY_DATA/system_book=*/bizday=*/all.parquet'
    ) r
    where r['bizday']::date >= date '{{ window_start_date() }}'
      and r['bizday']::date < cast(now() at time zone 'Asia/Shanghai' as date)
    group by 1, 2
),
v as (
    select system_book, bizday, count(*)::bigint as n
    from {{ ref('vw_lemeng_retail_order_line') }}
    where bizday >= date '{{ window_start_date() }}'
    group by 1, 2
)
select
    s.system_book,
    s.bizday,
    coalesce(v.n, 0) as view_rows,
    coalesce(c.n, 0) as cold_rows
from sealed s
left join v on v.system_book = s.system_book and v.bizday = s.bizday
left join cold c on c.system_book = s.system_book and c.bizday = s.bizday
where coalesce(v.n, 0) <> coalesce(c.n, 0)
