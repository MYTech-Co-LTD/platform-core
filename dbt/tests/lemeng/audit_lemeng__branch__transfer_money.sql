-- audit_lemeng__branch__transfer_money.sql — 指标 `lemeng:branch:transfer_money` 的**独立复算**
-- （对账；聚合面与 fct_branch_indicator 逐字同构，但**直接打 parquet、不 ref staging**——
-- 复算走 staging 会让 cast/投影错同时污染两边 ⇒ 对账恒绿）。
-- 契约：dbt singular test 返回任何行即失败；空转自检防「空集上的假绿」。
-- 口径见 fct_branch_indicator.sql 头注（本文件比较：门店配送金额 = 源 transfer_money 的 actual_value 合计）。
-- 锚：店 92 2026-10-01..19 合计 32,114.96（与乐檬源界面逐分对上，handbook §1.7 D10 行）。
with recheck as (
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date        as bizday,
        r['branch_num']::int     as branch_num,
        sum(case when r['metric']::varchar = 'transfer_money' then coalesce(r['actual_value']::numeric, 0) else 0 end)::numeric(20,2) as v
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_branch_indicator_prefix") }}/*/bizday=**/*.parquet'
    ) r
    -- 当日分区可能还在被日内 5 轮刷新 ⇒ 闭窗只对「今天之前」的业务日，与物化侧同判据。
    where r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
    group by 1, 2, 3
),
materialized as (
    select system_book, bizday, branch_num, transfer_money
    from {{ ref('fct_branch_indicator') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday)           as bizday,
    coalesce(a.branch_num, b.branch_num)   as branch_num,
    a.v as recheck_value,
    b.transfer_money as materialized_value,
    '门店配送金额 = Σ transfer_money.actual_value：复算与物化结果不一致' as note
from recheck a
full join materialized b using (system_book, bizday, branch_num)
where a.v is distinct from b.transfer_money

union all

select
    null, null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)
