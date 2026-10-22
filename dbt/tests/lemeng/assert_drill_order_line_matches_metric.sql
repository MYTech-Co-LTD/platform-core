-- assert_drill_order_line_matches_metric.sql — 两处 FINISHED 声明同源不变量（spec 2026-10-22 §2.6）。
--
-- 它守的是本批**唯一新增的重复声明**：`state = 'FINISHED'` 在两个地方各写了一遍——
--   · `detail.filter`（下钻面 WHERE）；
--   · `expression` 的 CASE（聚合面没有 detail.filter 可用）。
-- 两处漂移 ⇒ 同一个源答出两个行集 / 两个金额，而且**不会报错**。本测试是它的解毒剂。
--
-- 形态同 audit_* / Phase 1 的 assert_drill_*：返回任何行即失败；full join 缺一侧按 0 计
--（inner join 对「单侧局部丢分区」结构性失明）；金额 numeric(20,2) = 1 分容差；
-- 只测**闭窗日**（bizday < 上海今天：当日分区被 tick 持续重写，两侧时点不同不可比）；
-- 两侧皆空 ⇒ 空转绿守卫报一行。
with drill as (
    select system_book, bizday,
           count(*)::bigint                as line_count,
           sum(sale_money)::numeric(20,2)  as amount
    from {{ ref('vw_lemeng_retail_order_line') }}
    where state = 'FINISHED'
    group by 1, 2
),
metric as (
    select system_book, bizday,
           count(case when state = 'FINISHED' then 1 end)::bigint as line_count,
           sum(case when state = 'FINISHED' then sale_money else 0 end)::numeric(20,2) as amount
    from {{ ref('stg_lemeng_retail_order_line') }}
    group by 1, 2
)
select coalesce(a.system_book, b.system_book) as system_book,
       coalesce(a.bizday, b.bizday)           as bizday,
       a.line_count as drill_lines,  b.line_count as metric_lines,
       a.amount     as drill_amount, b.amount     as metric_amount,
       '下钻行域与聚合表达式漂移（detail.filter 与 expression 的 FINISHED 条件不一致，或单侧分区缺失）' as note
from drill a
full join metric b using (system_book, bizday)
where coalesce(a.bizday, b.bizday) < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
  and (coalesce(a.line_count, 0) <> coalesce(b.line_count, 0)
       or abs(coalesce(a.amount, 0) - coalesce(b.amount, 0)) > 0.01)

union all

select null, null, null, null, null, null,
       '空转绿：闭窗日两侧有一侧为空，对账在空集上「通过」是空转绿（不是对上了）'
where (select count(*) from drill  where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)) = 0
   or (select count(*) from metric where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)) = 0
