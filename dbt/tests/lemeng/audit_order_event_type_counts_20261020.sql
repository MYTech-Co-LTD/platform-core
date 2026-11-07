{{ config(tags=['audit']) }}
-- audit_order_event_type_counts_20261020.sql — 类型分布**回归锁**（2026-10-20 实测值）。
--
-- 期望：SALE 15,157 / FULL_RETURN 69 / PARTIAL_RETURN 9 / REPAID_RETURN 32（行级，见模型头注）。
-- 口径：按 `order_transaction_type`（SALE 含 CANCELED）。任何其它类型都必须显式暴露（OTHER）。
with actual as (
    select event_type, count(*) as n
    from {{ ref('fct_order_event') }}
    where bizday = '2026-10-20'
    group by 1
),
expected(event_type, n) as (
    values
        ('SALE', 15157),
        ('FULL_RETURN', 69),
        ('PARTIAL_RETURN', 9),
        ('REPAID_RETURN', 32)
)
select
    coalesce(a.event_type, e.event_type) as event_type,
    e.n as expected_rows,
    a.n as actual_rows
from actual a
full join expected e using (event_type)
where a.n is distinct from e.n
  -- 降级边界：首建只回填 30 天；该日滑出窗口后本审计**自动失效**（模型头注已声明范围），
  -- 不制造「窗口外恒红」。窗口内它是硬回归锁。
  and exists (select 1 from {{ ref('fct_order_event') }} where bizday = '2026-10-20')
