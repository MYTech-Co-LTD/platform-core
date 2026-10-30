-- audit_lemeng__outbound__region_net — 战区出库净额的**独立复算**（#1181，layered §7 硬约束 7）。
--
-- 为什么不能只靠 mart 自己：`fct_outbound_region` 是「归因层」，它错了（join 方向反、通道判别式写错、
-- 未归属桶漏并）在总量守恒测试里可能仍然绿——只要每条出库行恰好落进某个桶，总和就不变。
-- 本测试**换一种写法**复算同一件事：
--   · 归因用**标量子查询**（而不是 mart 里的 left join 链）——join 键写反时两者必不一致；
--   · 通道判别式在这里**逐字重写**（不 ref 模型里的 CASE），CASE 改错时这里不跟随。
-- 判据：1 分容差；full join 两侧（漏桶 / 多桶都红）。
with base as (
    select f.system_book, f.bizday, f.domain, f.client_fid, f.region_id, f.r_net
    from {{ ref('fct_hq_outbound') }} f
),
indep as (
    select
        b.system_book,
        b.bizday,
        case when b.domain = 'transfer' then '自有门店配送'
             when (select c.client_kind from {{ ref('dim_lemeng_client') }} c
                    where c.system_book = b.system_book and c.client_fid = b.client_fid) = '体系内门店'
             then '体系内批发'
             else '外部批发' end as channel_type,
        coalesce((
            select r.region_l1
            from {{ ref('dim_region') }} r
            where r.system_book = case when b.domain = 'transfer' then b.system_book
                                       else (select c2.home_system_book from {{ ref('dim_lemeng_client') }} c2
                                              where c2.system_book = b.system_book and c2.client_fid = b.client_fid) end
              and r.region_id  = case when b.domain = 'transfer' then b.region_id
                                       else (select c3.region_id from {{ ref('dim_lemeng_client') }} c3
                                              where c3.system_book = b.system_book and c3.client_fid = b.client_fid) end
        ), '未归属') as region_l1_bucket,
        sum(b.r_net)::numeric(20,2) as r_net
    from base b
    group by 1, 2, 3, 4
),
mart as (
    select system_book, bizday, channel_type, region_l1_bucket, r_net
    from {{ ref('fct_outbound_region') }}
)
select coalesce(m.system_book, i.system_book) as system_book,
       coalesce(m.bizday, i.bizday)           as bizday,
       coalesce(m.channel_type, i.channel_type) as channel_type,
       coalesce(m.region_l1_bucket, i.region_l1_bucket) as region_l1_bucket,
       m.r_net as mart_r_net, i.r_net as indep_r_net,
       '战区归因与独立复算不一致：join 方向 / 通道判别式 / 未归属桶' as note
from mart m
full join indep i
       on i.system_book = m.system_book
      and i.bizday = m.bizday
      and i.channel_type = m.channel_type
      and i.region_l1_bucket = m.region_l1_bucket
where abs(coalesce(m.r_net, 0) - coalesce(i.r_net, 0)) > 0.01
union all
-- 结构不变量：外部批发必须落未归属；体系内批发必须有真战区
select system_book, bizday, channel_type, region_l1_bucket, r_net, r_net,
       '通道与战区桶矛盾：外部批发不摊战区、体系内批发必须有真战区'
from {{ ref('fct_outbound_region') }}
where (channel_type = '外部批发' and region_l1_bucket <> '未归属')
   or (channel_type = '体系内批发' and region_l1_bucket = '未归属')
union all
select null, null, null, null, null, null, '两侧都为空：对账在空集上「通过」是空转绿'
where not exists (select 1 from mart)
