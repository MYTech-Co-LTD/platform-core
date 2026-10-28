-- audit_lemeng__transfer__cost_coverage_pct.sql — 指标的**独立复算**（对账；聚合面与
-- fct_transfer_line_quality 逐字同构，但直接打 parquet、不 ref staging——复算走 staging 会让
-- cast 错同时污染两边 ⇒ 对账恒绿）。
-- 契约：dbt singular test 返回任何行即失败；空转自检防「空集上的假绿」。
-- 口径见 fct_transfer_line_quality.sql 头注与正典 §1.4.2（哨兵值不可反解）。
--
-- 【钉什么】三件，任一件破坏都判红：
--   ① 分子 `costed_amount`、分母 `out_money_amount` 复算 vs 物化（逐店日）；
--   ② **恒等式**：`costed_amount + zero_cost_amount + missing_cost_amount = out_money_amount`
--      —— 三面互斥且完备。任一面把另一面并进来（历史上 2026-10-17 的 `coalesce(subtotal,0)=0`
--      就是这么错的）都会破坏它；
--   ③ 覆盖率本身不在此比较（比率不可加、逐店日复算已在 ①② 约束住两端）。
--
-- ⚠️ **射程**：② 的区分度依赖「三面各自的谓词不同」。源端 `subtotal` 从不送 null（2026-10-28 实测
-- 全湖 0 行）⇒ `missing_cost_amount` 恒 0，② 中的 null 支路今天空转；null 一旦出现即生效。
-- 这是**已知且刻意**的射程（与 audit_lemeng__transfer__zero_cost_exposure_amount 同款披露），不是遗漏。
with base as (
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
        r['branch_num']::int      as branch_num,
        r['out_money']::numeric   as out_money,
        r['subtotal']::numeric    as subtotal
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_transfer_out_prefix") }}/*/bizday=**/*.parquet'
    ) r
    where r['state_code']::int = 3
      and r['out_branch_num']::int = 99
      and r['branch_num']::int <> r['out_branch_num']::int
      and r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
),
recheck as (
    select
        b.system_book,
        b.bizday,
        b.branch_num,
        sum(coalesce(b.out_money, 0))::numeric(20,2)                       as out_money_amount,
        sum(case when b.subtotal is not null and b.subtotal <> 0
                 then coalesce(b.out_money, 0) else 0 end)::numeric(20,2)  as costed_amount,
        sum(case when coalesce(b.out_money, 0) <> 0 and b.subtotal = 0
                 then b.out_money else 0 end)::numeric(20,2)               as zero_cost_amount,
        sum(case when b.subtotal is null and coalesce(b.out_money, 0) <> 0
                 then b.out_money else 0 end)::numeric(20,2)               as missing_cost_amount
    from base b
    group by 1, 2, 3
),
materialized as (
    select system_book, bizday, branch_num,
           out_money_amount, costed_amount, zero_cost_amount, missing_cost_amount
    from {{ ref('fct_transfer_line_quality') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday) as bizday,
    coalesce(a.branch_num, b.branch_num) as branch_num,
    a.costed_amount as recheck_value,
    b.costed_amount as materialized_value,
    '成本覆盖率分子（有成本金额）：复算与物化不一致' as note
from recheck a
full join materialized b using (system_book, bizday, branch_num)
where a.costed_amount is distinct from b.costed_amount

union all

select
    coalesce(a.system_book, b.system_book),
    coalesce(a.bizday, b.bizday),
    coalesce(a.branch_num, b.branch_num),
    a.out_money_amount,
    b.out_money_amount,
    '成本覆盖率分母（出库金额合计）：复算与物化不一致'
from recheck a
full join materialized b using (system_book, bizday, branch_num)
where a.out_money_amount is distinct from b.out_money_amount

-- ② 恒等式：有成本 + 零成本 + 缺成本 = 出库金额合计（互斥且完备）
union all

select
    b.system_book, b.bizday, b.branch_num,
    (b.costed_amount + b.zero_cost_amount + b.missing_cost_amount),
    b.out_money_amount,
    '恒等式破坏：costed + zero_cost + missing_cost ≠ out_money_amount（三面不互斥或不全）'
from materialized b
where (b.costed_amount + b.zero_cost_amount + b.missing_cost_amount) is distinct from b.out_money_amount

union all

select
    null, null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)
