-- audit_lemeng__wholesale__order_line — 批发明细指标的**独立复算**（#1182；layered §7 硬约束 7）。
--
-- 两侧：
--   · 下钻面（`vw_lemeng_wholesale_out`，直读湖）+ 行域 `state_code = 3`；
--   · 聚合面（`stg_lemeng_wholesale_out`）按指标 expression 的 CASE 语义复算。
-- 判据：按 (账套, 制单日) 对齐——行数精确相等、金额 1 分容差；只测**闭窗日**
-- （当天分区被管线重写，两侧时点不同不可比）；两侧皆空 ⇒ 空转绿守卫报一行。
with v as (
    select system_book, bizday,
           count(*)::bigint                as line_count,
           sum(money)::numeric(20,2)       as amount
    from {{ ref('vw_lemeng_wholesale_out') }}
    where state_code = 3
    group by 1, 2
),
s as (
    select system_book, bizday,
           count(case when state_code = 3 then 1 end)::bigint as line_count,
           sum(case when state_code = 3 then money else 0 end)::numeric(20,2) as amount
    from {{ ref('stg_lemeng_wholesale_out') }}
    group by 1, 2
)
select coalesce(a.system_book, b.system_book) as system_book,
       coalesce(a.bizday, b.bizday)           as bizday,
       a.line_count as drill_lines, b.line_count as metric_lines,
       a.amount     as drill_amount, b.amount    as metric_amount,
       '批发明细与聚合面不同量（视图丢行 / CASE 语义漂移 / 分区缺失）' as note
from v a
full join s b using (system_book, bizday)
where coalesce(a.bizday, b.bizday) < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
  and (coalesce(a.line_count, 0) <> coalesce(b.line_count, 0)
       or abs(coalesce(a.amount, 0) - coalesce(b.amount, 0)) > 0.01)
union all
select null, null, null, null, null, null, '两侧都为空：对账在空集上「通过」是空转绿'
where not exists (select 1 from s)
