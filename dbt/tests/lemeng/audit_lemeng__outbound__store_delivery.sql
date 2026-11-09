{{ config(tags=['audit']) }}
-- audit_lemeng__outbound__store_delivery — 「门店配送金额（出库口径）」独立复算（2026-11-09）。
-- 口径：= transfer 域全部 r_net（不含 wholesale；体系内批发是 64188 调入镜像，不另加）。
-- 复算直接打 fct_hq_outbound，不 ref 归因模型里的 CASE。
with recheck as (
    select system_book, bizday, sum(r_net)::numeric(20,2) as v
    from {{ ref('fct_hq_outbound') }}
    where domain = 'transfer'
    group by 1, 2
),
mart as (
    select system_book, bizday, sum(r_net)::numeric(20,2) as v
    from {{ ref('fct_outbound_region') }}
    where channel_type = '自有门店配送'
    group by 1, 2
)
select coalesce(m.system_book, r.system_book) as system_book,
       coalesce(m.bizday, r.bizday)           as bizday,
       m.v as mart_value, r.v as recheck_value,
       '门店配送金额与独立复算不一致' as note
from mart m
full join recheck r using (system_book, bizday)
where abs(coalesce(m.v, 0) - coalesce(r.v, 0)) > 0.01
union all
select null, null, null, null, '两侧都为空：对账在空集上「通过」是空转绿'
where not exists (select 1 from mart)
