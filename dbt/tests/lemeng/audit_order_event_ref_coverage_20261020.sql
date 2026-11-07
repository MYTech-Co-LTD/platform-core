{{ config(tags=['audit']) }}
-- audit_order_event_ref_coverage_20261020.sql — 退货关联覆盖率**如实证报数**（2026-10-20）。
--
-- 实测：总行 15,267；有 `ref_order_no` 的行 **201**（201/15,267 ≈ 1.3%）。
-- 注意这是「全部行」的覆盖率（其中退货行带原单号 78/110）；不粉饰、不按退货行重算。
with actual as (
    select
        count(*) as total_lines,
        count(*) filter (where ref_order_no is not null and ref_order_no <> '') as lines_with_ref
    from {{ ref('fct_order_event') }}
    where bizday = '2026-10-20'
)
select
    total_lines,
    lines_with_ref,
    15267 as expected_total,
    201   as expected_with_ref
from actual
where (total_lines <> 15267 or lines_with_ref <> 201)
  -- 同类型审计：该日滑出 30 天窗口后自动失效（不假绿也不恒红）。
  and exists (select 1 from {{ ref('fct_order_event') }} where bizday = '2026-10-20')
