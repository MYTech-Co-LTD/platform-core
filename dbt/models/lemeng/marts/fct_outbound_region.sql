-- fct_outbound_region.sql — **战区出库面**（配送 / 体系内批发 / 外部批发 三分列）（#1181，2026-10-30）。
--
-- 【它为什么存在】「各战区出库金额」原先答不出来：`fct_hq_outbound` 的批发 `region_id` 是
--   `branch_num = 99`（管理中心/批发仓）回落的**幻影战区**（实测 10-20 起 453 行 / 129.1 万全部
--   落进 `region_id = 9046`），直接把批发放进战区表等于把 37% 的出库记到一个不存在的区。
--   本模型把「战区」重新归因，并把出库按**通道**分开：
--     · `自有门店配送`：transfer 域，战区 = 调入门店的战区（`fct_hq_outbound.region_id`，本来就对）；
--     · `体系内批发`：wholesale 域且客户是**另一个账套的门店**（`dim_lemeng_client.client_kind`），
--       战区 = 那家门店的战区；
--     · `外部批发`：其余 wholesale，**战区不硬摊**（2026-10-30 用户裁决）⇒ `region_l1_bucket = '未归属'`。
--
-- 【为什么不改 fct_hq_outbound】那是既有 mart：列集 / 粒度 / 已声明的 certified 指标都钉在上面，
--   为「多一个战区口径」去改它 = 动认证面。本模型只读它、**不重算任何金额**（`r_net/order_count/
--   line_count` 原样求和），守恒由 `audit_lemeng__outbound__region_conservation` 钉住。
--
-- 【粒度】`(system_book, bizday, channel_type, region_l1_bucket)`。
--   一级战区桶而不是 region_id：两账套的 region_id 空间不相交（3120 的 25383 ≠ 64188 的 25426），
--   但共享同一套一级名（东部/南部/西部/中部战区）⇒ **只有 region_l1 能跨账套合并**（同
--   `lemeng:contribution:region_l1_net` 的 `region_l1_bucket` 口径，空值显式落 `未归属`）。
--
-- 【join 语义】全部 `left join`：宁可落 `未归属` 也不丢行——丢行 = 静默少数，守恒测试会红但
--   根因难查；`未归属` 是**可见**的缺口。
{{
    config(materialized='table')
}}
with
o as (
    select system_book, bizday, domain, branch_num, client_fid, region_id,
           r_net, order_count, line_count
    from {{ ref('fct_hq_outbound') }}
),
dc as (
    select system_book, client_fid, client_kind, home_system_book,
           region_id as client_region_id
    from {{ ref('dim_lemeng_client') }}
),
dr as (
    select system_book, region_id, region_l1
    from {{ ref('dim_region') }}
)
select
    o.system_book,
    {{ subject_org() }} as org,
    o.bizday,
    case
        when o.domain = 'transfer' then '自有门店配送'
        when dc.client_kind = '体系内门店' then '体系内批发'
        else '外部批发'
    end::varchar as channel_type,
    -- 一级战区桶：transfer 用门店战区；wholesale 用客户本体门店战区；都没有 ⇒ 未归属
    coalesce(r.region_l1, '未归属')::varchar as region_l1_bucket,
    sum(o.r_net)::numeric(20,2)      as r_net,
    sum(o.order_count)::bigint       as order_count,
    sum(o.line_count)::bigint        as line_count
from o
left join dc
       on dc.system_book = o.system_book
      and dc.client_fid  = o.client_fid
left join dr r
       on r.system_book = case when o.domain = 'transfer' then o.system_book else dc.home_system_book end
      and r.region_id  = case when o.domain = 'transfer' then o.region_id  else dc.client_region_id end
group by 1, 2, 3, 4, 5
