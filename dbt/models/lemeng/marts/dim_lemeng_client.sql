-- dim_lemeng_client.sql — **批发客户维**（客户 → 体系内门店 / 战区归属）（#1181，2026-10-30）。
--
-- 【它为什么存在】出库侧的「战区」在批发行上是个**假值**：`fct_hq_outbound` 的批发 `region_id`
--   是 `branch_num = 99`（管理中心/批发仓）回落 `dim_branch` 的**幻影战区**（实测：10-20 起 453 行
--   / 129.1 万全部落进 `region_id = 9046`「所有区域」，与 12 个真战区不重叠）。客户文档 02-04 要求
--   批发按 `client_fid → 战区` 归集 ⇒ 缺的就是这张映射。已有指标的 definition 把这条边界写死了
--   （`lemeng:contribution:region_net`「按战区归批发仍需 X01 client→region 映射（未就位）」），
--   本维就是那块缺失的映射。
--
-- 【为什么能自动算出来】实测（2026-10-30）：3120 的 95 个批发客户里，**57 个客户名逐字等于
--   64188 的门店名**（54.6 万，41%）；64188 的 129 家门店**名字全部唯一**。也就是说「客户」在
--   集团拓扑里就是「另一个账套的门店」——货从 3120（总仓）批给 64188 的门店，再由门店零售。
--   于是匹配规则可以完全由数据推出，不需要客户填台账。
--
-- 【匹配规则（唯一一条）】客户名（btrim 后）在**另一个账套**的门店名里**恰好命中 1 家** ⇒
--   体系内门店，战区取那家门店的。
--   · **同账套门店不参与**（3120 自己的门店不是 3120 的客户）；
--   · **命中 ≥ 2 家 = 歧义 ⇒ 不匹配**（不猜；猜错就是把钱记错战区）；
--   · **命中 0 家 ⇒ 外部客户**（`region_id is null`，下游按「未归属」呈现、**不硬摊战区**——
--     2026-10-30 用户裁决：外部批发商跨区采购很常见，硬塞一个战区出来的数字是假的）。
--
-- 【覆盖 seed】`x01_client_region_overrides` 处理自动匹配救不了的两类：名字写法不一致的别名
--   （客户台账写「腾冲1店」、门店档案写「品品甜保山腾冲1店」）、业务人工指定的归属。
--   覆盖**优先于**自动匹配，键是 `(source_system_book, client_fid)` ⇒ 客户改名不影响生效。
--   seed 0 行是合规态（没有要覆盖的数据就不造数据）。
--
-- 【粒度】`(system_book, client_fid)` —— **只取最新快照**（客户档案日更快照；本维回答「现在是谁」，
--   不做 as-of。历史归属需要时由消费方按 `snapshot ≤ bizday` 另建，不在本维混两种语义）。
--
-- 【为什么不把 region 写进 fct_hq_outbound】那会改动既有 mart 的列集与 certified 指标语义面；
--   本维 + 下游 `fct_outbound_region` 的组合可在**不动原 mart**的前提下换口径
--   （计划 `2026-10-30-outbound-region-and-wholesale-drill.md` Phase A Task 2）。
{{
    config(materialized='table')
}}
with
-- 最新快照（同 dim_lemeng_branch 口径：`snapshot desc` 取 row_number = 1）
cli as (
    select system_book, client_fid, client_name, client_type, client_actived, client_del_tag, snapshot
    from (
        select system_book, client_fid, client_name, client_type, client_actived, client_del_tag, snapshot,
               row_number() over (partition by system_book, client_fid order by snapshot desc) as rn
        from {{ ref('stg_lemeng_client') }}
    ) t
    where rn = 1
),
br as (
    select system_book, branch_num, btrim(name) as name, region_id
    from (
        select system_book, branch_num, name, region_id,
               row_number() over (partition by system_book, branch_num order by snapshot desc) as rn
        from {{ ref('stg_lemeng_branch') }}
    ) t
    where rn = 1
),
-- 唯一命中：另一账套、同名门店恰好 1 家；≥2 家直接排除（歧义不猜）
hit as (
    select c.system_book, c.client_fid,
           min(b.system_book) as home_system_book,
           min(b.branch_num)  as home_branch_num,
           min(b.region_id)   as region_id
    from cli c
    join br b
      on b.system_book <> c.system_book
     and b.name = btrim(c.client_name)
    group by 1, 2
    having count(*) = 1
),
-- 受控覆盖（人工指定 / 别名）
ovr as (
    -- ⚠️ 显式 cast：seed 是 **0 行 CSV**，dbt 的类型推断对它不可靠（实测把 system_book 推断成 integer
    -- ⇒ join 时 `operator does not exist: text = integer`）。列类型必须由这里钉死，不吃推断。
    select source_system_book::varchar as source_system_book,
           client_fid::varchar         as client_fid,
           home_system_book::varchar   as home_system_book,
           home_branch_num::bigint     as home_branch_num,
           region_id::int              as region_id
    from {{ ref('x01_client_region_overrides') }}
),
-- 覆盖只给了门店、没给 region_id 时，从该门店补
ovr_branch as (
    select o.*, b.region_id as branch_region_id
    from ovr o
    left join br b
           on b.system_book = o.home_system_book
          and b.branch_num  = o.home_branch_num
)
select
    c.system_book,
    {{ subject_org() }} as org,
    c.client_fid,
    c.client_name,
    -- **渠道归属**：体系内门店 / 外部客户。与客户自己的 `client_type`（等级/性质）不是一回事，别混用。
    case when o.client_fid is not null or h.client_fid is not null
         then '体系内门店' else '外部客户' end::varchar as client_kind,
    coalesce(o.home_system_book, h.home_system_book)::varchar as home_system_book,
    coalesce(o.home_branch_num,  h.home_branch_num)::bigint  as home_branch_num,
    coalesce(o.region_id, o.branch_region_id, h.region_id)::int as region_id,
    r.region_name::varchar as region_name,
    r.region_l1::varchar   as region_l1,
    case when o.client_fid is not null then 'override'
         when h.client_fid is not null then 'name_unique'
         else 'none' end::varchar as match_rule,
    c.snapshot,
    c.client_type,
    c.client_actived,
    c.client_del_tag
from cli c
left join hit h
       on h.system_book = c.system_book
      and h.client_fid  = c.client_fid
left join ovr_branch o
       on o.source_system_book = c.system_book
      and o.client_fid         = c.client_fid
-- 战区维（受控 seed）：两账套 id 空间不相交 ⇒ join 必须带 system_book
left join {{ ref('dim_region') }} r
       on r.system_book = coalesce(o.home_system_book, h.home_system_book)
      and r.region_id  = coalesce(o.region_id, o.branch_region_id, h.region_id)
