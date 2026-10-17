-- audit_lemeng__transfer__zero_cost_exposure_amount.sql — 指标的**独立复算**（对账；聚合面与 fct_transfer_line_quality 逐字同构，
-- 但直接打 parquet、不 ref staging——复算走 staging 会让 cast 错同时污染两边 ⇒ 对账恒绿）。
-- 契约：dbt singular test 返回任何行即失败；空转自检防「空集上的假绿」。
-- 口径见 fct_transfer_line_quality.sql 头注（本文件比较：零成本暴露金额 **与缺成本金额**）。
--
-- 【2026-10-17 订正·边界互斥】原复算把零成本面写成 `coalesce(b.subtotal, 0) = 0`——与物化侧**同款错法**
--   ⇒ 两面（零成本 / 缺成本）重叠而对账恒绿（同构复算的口径错两边同错）。现按客户文档 04-06
--   「金额≠0 且**已知**成本=0」+「成本 null **另列**」改为 `b.subtotal = 0`，并**新增两条断言**：
--     ② 缺成本面复算 vs 物化；③ **互斥断言**：`zero_cost_amount + missing_cost_amount` 必须等于
--        基面「无正成本」金额（`subtotal = 0 or subtotal is null`）。任一面把另一面并进来 ⇒ ③ 判红。
--   ⚠️ **射程**：③ 只在源出现 `subtotal is null` 时才有区分度——2026-10-17 实测全湖 0 行 null
--   （6561 行 / 9 天），故今天 ③ 空转过绿；null 一旦出现即生效。这是**已知**且**刻意**的射程，不是遗漏。
with base as (
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
        r['branch_num']::int      as branch_num,
        r['order_no']::varchar    as order_no,
        r['out_money']::numeric   as out_money,
        r['subtotal']::numeric    as subtotal,
        r['lot_number']::varchar  as lot_number
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_transfer_out_prefix") }}/*/bizday=**/*.parquet'
    ) r
    where r['state_code']::int = 3
      and r['out_branch_num']::int = 99
      and r['branch_num']::int <> r['out_branch_num']::int
      and r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
),
per_order as (
    select system_book, bizday, branch_num, order_no,
           max(coalesce(out_money, 0))::numeric(20,2) as order_money
    from base group by 1, 2, 3, 4
),
recheck as (
    select
        b.system_book,
        b.bizday,
        b.branch_num,
        count(*)                                                              as line_count,
        count(*) filter (where b.lot_number is not null and trim(b.lot_number) <> '') as lot_filled_lines,
        sum(case when coalesce(b.out_money, 0) <> 0 and b.subtotal = 0
                 then b.out_money else 0 end)::numeric(20,2)                   as zero_cost_amount,
        sum(case when b.subtotal is null and coalesce(b.out_money, 0) <> 0
                 then b.out_money else 0 end)::numeric(20,2)                   as missing_cost_amount,
        sum(case when coalesce(b.out_money, 0) <> 0 and (b.subtotal = 0 or b.subtotal is null)
                 then b.out_money else 0 end)::numeric(20,2)                   as no_positive_cost_amount,
        count(distinct case when p.order_money < 0 then b.order_no end)        as negative_order_count
    from base b
    join per_order p using (system_book, bizday, branch_num, order_no)
    group by 1, 2, 3
),
materialized as (
    select system_book, bizday, branch_num, line_count, lot_filled_lines,
           zero_cost_amount, missing_cost_amount, negative_order_count
    from {{ ref('fct_transfer_line_quality') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
)

-- ① 零成本面：复算（已知成本=0）vs 物化
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday) as bizday,
    coalesce(a.branch_num, b.branch_num) as branch_num,
    a.zero_cost_amount as recheck_value,
    b.zero_cost_amount as materialized_value,
    '零成本暴露金额：复算与物化结果不一致（金额≠0 且**已知**成本=0）' as note
from recheck a
full join materialized b using (system_book, bizday, branch_num)
where a.zero_cost_amount is distinct from b.zero_cost_amount

union all

-- ② 缺成本面：复算（成本 null）vs 物化
select
    coalesce(a.system_book, b.system_book),
    coalesce(a.bizday, b.bizday),
    coalesce(a.branch_num, b.branch_num),
    a.missing_cost_amount,
    b.missing_cost_amount,
    '缺成本金额：复算与物化结果不一致（金额≠0 且成本为 null）'
from recheck a
full join materialized b using (system_book, bizday, branch_num)
where a.missing_cost_amount is distinct from b.missing_cost_amount

union all

-- ③ **互斥断言**：零成本面与缺成本面不得重叠——两面之和必须恰等于基面「无正成本」金额。
--    物化侧把 null 并进零成本（coalesce(subtotal,0)=0 的旧错法）⇒ 本断言判红（null>0 时）。
select
    b.system_book, b.bizday, b.branch_num,
    a.no_positive_cost_amount,
    (b.zero_cost_amount + b.missing_cost_amount),
    '零成本面与缺成本面不互斥：两面之和 ≠ 基面「无正成本」金额（某行被两面同时计入或漏计）'
from materialized b
join recheck a using (system_book, bizday, branch_num)
where (b.zero_cost_amount + b.missing_cost_amount) is distinct from a.no_positive_cost_amount

union all

select
    null, null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)
