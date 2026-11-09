{{ config(tags=['audit']) }}
-- audit_lemeng__outbound__amount — 「出库金额（集团去重口径）」独立复算（2026-11-09）。
-- 口径：门店配送（transfer 全量）+ 外部批发（wholesale 中非体系内四战区）。
--          **不含**体系内批发（3120→64188 门店，是 64188 调入 transfer 的镜像）。
-- 判据：两侧按 (system_book, bizday) 逐分相等；空集不判绿。
with raw as (
    select
        f.system_book,
        f.bizday,
        f.domain,
        f.r_net,
        (select c.client_kind from {{ ref('dim_lemeng_client') }} c
          where c.system_book = f.system_book and c.client_fid = f.client_fid) as client_kind,
        coalesce((
            select r.region_l1
            from {{ ref('dim_region') }} r
            where r.system_book = case when f.domain = 'transfer' then f.system_book
                                       else (select c2.home_system_book from {{ ref('dim_lemeng_client') }} c2
                                              where c2.system_book = f.system_book and c2.client_fid = f.client_fid) end
              and r.region_id = case when f.domain = 'transfer' then f.region_id
                                     else (select c3.region_id from {{ ref('dim_lemeng_client') }} c3
                                            where c3.system_book = f.system_book and c3.client_fid = f.client_fid) end
        ), '未归属') as region_l1_bucket
    from {{ ref('fct_hq_outbound') }} f
),
recheck as (
    select system_book, bizday, sum(r_net)::numeric(20,2) as v
    from raw
    where domain = 'transfer'
       or coalesce(client_kind = '体系内门店'
                   and region_l1_bucket in ('东部战区','南部战区','西部战区','中部战区'), false) = false
    group by 1, 2
),
mart as (
    select system_book, bizday, sum(r_net)::numeric(20,2) as v
    from {{ ref('fct_outbound_region') }}
    where channel_type in ('自有门店配送','外部批发')
    group by 1, 2
)
select coalesce(m.system_book, r.system_book) as system_book,
       coalesce(m.bizday, r.bizday)           as bizday,
       m.v as mart_value, r.v as recheck_value,
       '出库金额（集团去重）与独立复算不一致：门店配送 + 外部批发 ≠ 复算' as note
from mart m
full join recheck r using (system_book, bizday)
where abs(coalesce(m.v, 0) - coalesce(r.v, 0)) > 0.01
union all
select null, null, null, null, '两侧都为空：对账在空集上「通过」是空转绿'
where not exists (select 1 from mart)
