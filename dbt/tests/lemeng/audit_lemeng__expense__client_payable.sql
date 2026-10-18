-- audit_audit_lemeng__expense__client_payable.sql.sql — 指标的**独立复算**（对账；聚合面与 fct_client_expense 逐字同构，但直接打 parquet、
-- 不 ref staging——复算走 staging 会让 cast 错同时污染两边 ⇒ 对账恒绿）。
-- 契约：dbt singular test 返回任何行即失败；空转自检防「空集上的假绿」。
-- 口径见 fct_client_expense.sql 头注（本文件比较：客户应付费用 EP）。
with recheck as (
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
        r['client_fid']::varchar     as client_fid,
        r['other_inout_kind']::varchar       as other_inout_kind,
        sum(case when r['other_inout_flag']::boolean = false then coalesce(r['other_inout_money']::numeric, 0) else 0 end)::numeric(20,2) as v
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_client_expense_prefix") }}/*/bizday=**/*.parquet'
    ) r
    where r['state_code']::int = 3
      and r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
    group by 1, 2, 3, 4
),
materialized as (
    select system_book, bizday, client_fid, other_inout_kind, ep_payable
    from {{ ref('fct_client_expense') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday)           as bizday,
    coalesce(a.client_fid, b.client_fid)         as client_fid,
    coalesce(a.other_inout_kind, b.other_inout_kind)             as other_inout_kind,
    a.v as recheck_value,
    b.ep_payable as materialized_value,
    '客户应付费用 EP：复算与物化结果不一致' as note
from recheck a
full join materialized b using (system_book, bizday, client_fid, other_inout_kind)
where a.v is distinct from b.ep_payable

union all

select
    null, null, null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)
