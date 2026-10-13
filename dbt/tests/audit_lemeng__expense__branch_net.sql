-- audit_audit_lemeng__expense__branch_net.sql.sql — 指标的**独立复算**（对账；聚合面与 fct_branch_expense 逐字同构，但直接打 parquet、
-- 不 ref staging——复算走 staging 会让 cast 错同时污染两边 ⇒ 对账恒绿）。
-- 契约：dbt singular test 返回任何行即失败；空转自检防「空集上的假绿」。
-- 口径见 fct_branch_expense.sql 头注（本文件比较：门店净费用 E=应付−应收）。
with recheck as (
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
        r['branch_num']::int     as branch_num,
        r['expense_type']::varchar       as expense_type,
        (sum(case when r['direction']::varchar = '应付' then coalesce(r['amount']::numeric, 0) else 0 end) - sum(case when r['direction']::varchar = '应收' then coalesce(r['amount']::numeric, 0) else 0 end))::numeric(20,2) as v
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_branch_expense_prefix") }}/*/bizday=**/*.parquet'
    ) r
      -- 湖上只存在审核单（管线请求侧已筛审核态、契约不落状态列）——
      -- 此处无需重复筛 state；bizday 闭窗过滤照旧。
      where r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
    group by 1, 2, 3, 4
),
materialized as (
    select system_book, bizday, branch_num, expense_type, e_net
    from {{ ref('fct_branch_expense') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday)           as bizday,
    coalesce(a.branch_num, b.branch_num)         as branch_num,
    coalesce(a.expense_type, b.expense_type)             as expense_type,
    a.v as recheck_value,
    b.e_net as materialized_value,
    '门店净费用 E=应付−应收：复算与物化结果不一致' as note
from recheck a
full join materialized b using (system_book, bizday, branch_num, expense_type)
where a.v is distinct from b.e_net

union all

select
    null, null, null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)
