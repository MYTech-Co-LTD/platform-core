{{
    config(materialized='table')
}}
-- fct_hq_outbound.sql — 总仓出库构件长表（W1 2026-10-12；口径模型，layered ④：**口径在这里定义一次**）。
--
-- 【它为什么存在】客户公共定义 R（出库净额）= D01 配送 + D02 批发 − D03 批发退货，**跨三份湖表**；
--   L1 的 select_sql 只允许单 FROM（scripts/sync-data-semantics.mjs 的 deriveRelation 硬约束）⇒
--   跨模型聚合必须落成**一张 marts 长表**（sync 错误文案原话：跨模型聚合属 marts 层的活）。
--   本表即 R/C/G 构件的唯一落点（dbt/README.md §5.1 构件列约定表 transfer/wholesale 行）。
--
-- 【粒度】(system_book, bizday, domain, branch_num, region_id)——被 assert_fct_hq_outbound_grain_unique 钉住。
--   domain ∈ {'transfer','wholesale'}：客户文档 01-01 明令「不将内部配送与（批发）相加为同一口径再下钻」
--   之前先分域；branch_num=收货门店（transfer=调入店，wholesale=单头门店）；region_id=战区（X01）。
--
-- 【基面（口径，改这里必须先改 l1_metrics.yml 的 definition——口径先行）】
--   · transfer：state_code=3（审核）且 out_branch_num=99（总仓发货）且 branch_num <> out_branch_num
--     （排除店间直调——客户文档 01-01「不得混入店间调拨」）。
--   · wholesale：全部湖上单（管线请求侧已筛审核态 state_codes=[3]）；退货（D03）只在这里扣，
--     **与 D02 负金额红字不得重复扣**（客户文档 D03 边界；观测面 = lemeng:transfer:negative_order_count）。
--
-- 【R 构件的口径决定（裁8，experimental 的事由）】
--   · transfer 侧 R = Σ 行级 out_money（总部结算口径；列契约 description 载「工单金额依据的源」）。
--     客户公式的 D01.total_money 是**单头随行冗余**——行级相加重复计，不可用；两口径的差（含税总额 vs
--     实际调出）由真机对拍勾稽。**待客户回签裁8 前全部指标 experimental**。
--   · wholesale 侧 R = Σ per_order max(total_money)（v2 补采的单头列）− Σ 退货单头 total_money。
--     ⚠️ per_order 级 join 退货会因「一单多次退货」放大 ⇒ 先各自聚到店日再相减（本文件实现形态，
--     **别改回行级 join**）。C 同构（cost_money / subtotal）。
--   · D03 A 阶段恒空集：退货侧 sum 为空集时 coalesce 0——空是合法业务态，不是缺数。
--
-- 【region_id 回落（X01 种子语义）】X01（战区生效期映射，客户填）未就位 ⇒ 先回落 dim_branch 当前
--   档案 region_id；未映射 → 0（「未映射单列」，客户文档原则「未映射单列，不分摊」）。
--   ⚠️ 客户文档 D12 边界警告「历史战区不可套当前档案」⇒ 回落期产出的战区下钻一律 experimental。
--
-- 【org】主体列由 subject_org 宏注入常量（规则 ⑩ 单一形状），不透传、不进 GROUP BY。
-- 【精度】::numeric(20,2)——pg_duckdb 无精度 numeric 跨引擎拒算（fct_retail_sale 头注详）。
with transfer_lines as (
    select
        system_book,
        bizday,
        branch_num,
        order_no,
        sum(out_money)::numeric(20,2) as r_money,
        sum(subtotal)::numeric(20,2)  as c_money
    from {{ ref('stg_lemeng_transfer_out') }}
    where state_code = 3
      and out_branch_num = 99
      and branch_num <> out_branch_num
    group by 1, 2, 3, 4
),
transfer_dom as (
    select
        system_book,
        bizday,
        branch_num,
        sum(r_money)            as r_net,
        sum(c_money)            as c_cost,
        count(distinct order_no) as order_count,
        count(*)                as line_count
    from transfer_lines
    group by 1, 2, 3
),
wholesale_dom as (
    -- per_order 去单头冗余（v2 两列为随行冗余）；先聚店日，退货侧另聚后相减（防 per_order join 放大）
    select
        system_book,
        bizday,
        branch_num,
        sum(total_money)::numeric(20,2) as r_net,
        sum(cost_money)::numeric(20,2)  as c_cost,
        count(distinct order_no)        as order_count,
        count(*)                        as line_count
    from (
        select system_book, bizday, branch_num, order_no,
               max(total_money) as total_money,
               max(cost_money)  as cost_money
        from {{ ref('stg_lemeng_wholesale_out') }}
        group by 1, 2, 3, 4
    ) o
    group by 1, 2, 3
),
return_dom as (
    select
        system_book,
        bizday,
        branch_num,
        sum(total_money)::numeric(20,2) as r_return,
        sum(cost_money)::numeric(20,2)  as c_return
    from (
        select system_book, bizday, branch_num, order_no,
               max(total_money) as total_money,
               max(cost_money)  as cost_money
        from {{ ref('stg_lemeng_wholesale_return') }}
        group by 1, 2, 3, 4
    )
    group by 1, 2, 3
),
-- dim_branch 是日更快照（每 snapshot 一份全量）——join 最新快照取 region_id，否则按 snapshot 放大
branch_latest as (
    select system_book, branch_num, region_id
    from (
        select system_book, branch_num, region_id,
               row_number() over (partition by system_book, branch_num order by snapshot desc) as rn
        from {{ ref('stg_lemeng_branch') }}
    )
    where rn = 1
)
select
    u.system_book,
    {{ subject_org() }} as org,
    u.bizday,
    u.domain,
    u.branch_num,
    coalesce(b.region_id, 0) as region_id,
    (u.r_net - coalesce(d.r_return, 0))::numeric(20,2)  as r_net,
    (u.c_cost - coalesce(d.c_return, 0))::numeric(20,2) as c_cost,
    (u.r_net - coalesce(d.r_return, 0) - u.c_cost + coalesce(d.c_return, 0))::numeric(20,2) as g_gross,
    u.order_count,
    u.line_count
from (
    select system_book, bizday, branch_num, 'transfer' as domain, r_net, c_cost, order_count, line_count
    from transfer_dom
    union all
    select system_book, bizday, branch_num, 'wholesale' as domain,
           coalesce(w.r_net, 0), coalesce(w.c_cost, 0), coalesce(w.order_count, 0), 0
    from (
        select system_book, bizday, branch_num, r_net, c_cost, order_count
        from wholesale_dom
    ) w
) u
left join return_dom d
       on u.domain = 'wholesale'
      and u.system_book = d.system_book
      and u.bizday = d.bizday
      and u.branch_num = d.branch_num
left join branch_latest b
       on u.system_book = b.system_book
      and u.branch_num = b.branch_num
