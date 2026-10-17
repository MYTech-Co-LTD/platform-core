{{
    config(materialized='table')
}}
-- fct_contribution.sql — **费用后贡献**组合构件（#744 W2，2026-10-17）。
--
-- 【它为什么存在】L1 的 `select_sql` 形状契约是 `select <聚合表达式> as value, <维度…> from <单一关系>`
--   ——**`from` 只能一个关系**（join/子查询都不行，见 domain/semantic-compiler.ts 的 L1_SELECT_RE）。
--   所以「出库 × 费用」这类跨域口径**必须先落成一张 mart**，才写得出声明。客户 65 项里的
--   `01-03/02-04/08-05`（费用后贡献 N=R−C−E）、`02-07/07-05`（补损率 Q/R）、`03-04`（补贴率）
--   都卡在这一步——当年不是判据不许，是「比写一条声明多一步」，而那一步被推给了至今未立的消费面。
--
-- 【粒度】(system_book, bizday, domain, branch_num, region_id)。
--   ⚠️ 与 fct_hq_outbound **同键但**多一类行：**只有费用、当天没有对应出库**的行（domain='expense'）。
--   为什么必须保留它们：真机实测（2026-10-17）有 **53 个** (账套,业务日,门店) 组合的费用行
--   在出库侧没有对应行。若只从出库出发 left join，**这 53 笔费用会被整个丢掉** ⇒ 总仓级
--   N=R−C−E 的 E **静默少算**（当期全表 e_net 合计 24,571.58，丢的是其中一部分）。宁可多一类行，
--   不要一个悄悄错的数。
--
-- 【⚠️ 门店费用的挂载范围（本构件最关键的一条）】门店费用**只挂到 transfer 域**的行上：
--   `fct_hq_outbound.branch_num` 在**两个域里语义不同**——transfer 是**调入门店（收货门店）**，
--   wholesale 是**发货方编号（99=管理中心/批发仓）**（`contracts/common/lemeng.wholesale_out.json`
--   逐字："发货方编号（99=管理中心/批发仓）"）。而 `fct_branch_expense.branch_num` 是**归属门店**。
--   ⇒ 只有 transfer 行的 branch_num 能与门店费用对齐；wholesale 行 join 上去会**把 99 的费用
--   错记到批发头上**。故 join 条件带 `o.domain = 'transfer'`。
--   ⇒ 两个口径因此**都对**：
--     · **门店级** = 该店 transfer 行（R/C 是该店的、E 是该店的）；
--     · **总仓级** = 全行求和（含 expense 行 ⇒ Σ = ΣR − ΣC − ΣE，正是客户文档的 N）。
--
-- 【⚠️ 战区维度的既存边界】wholesale 行的 `region_id` 来自 branch_num=99 回落 dim_branch ⇒
--   **幻影战区**（真机实测：全部批发落进单个 region_id=9046，与 12 个真战区不重叠）。
--   客户文档 02-04 要求「批发 client_fid→X01 映射」，需出库侧带 client_fid，**不在本批**
--   （#744 Task 0 补记②）。故本构件给门店域单列 `*_store` 分量，让战区/门店级口径**结构上**
--   只走 transfer 域——比「让每个调用方记得过滤 domain」可靠，后者漏一次就是静默错数。
--
-- 【口径构件（客户公共定义）】R=r_net / C=c_cost / G=g_gross / E=e_net / N=n_net = R−C−E。
--   补损与补贴分量按**真机实测的取值字面量**筛（2026-10-16 全量分组：`产品售后补损` /
--   `抖音直播补贴`；客户文档另提「小程序或线下补贴」，**数据里不存在**——L1 definition 已注明）。
--
-- 【精度】金额一律 numeric(20,2)，与两张上游同。
with branch_expense as (
    -- 门店费用按 (账套, 业务日, 门店) 汇总：抹掉 expense_type 维度，同时把补损/补贴两个分量单列。
    select
        system_book,
        bizday,
        branch_num,
        sum(e_net)::numeric(20, 2) as e_net,
        sum(case when expense_type = '产品售后补损' then e_net else 0 end)::numeric(20, 2) as q_loss,
        sum(case when expense_type = '抖音直播补贴' then e_net else 0 end)::numeric(20, 2) as q_subsidy
    from {{ ref('fct_branch_expense') }}
    group by 1, 2, 3
),
outbound as (
    select system_book, bizday, domain, branch_num, region_id, r_net, c_cost, g_gross
    from {{ ref('fct_hq_outbound') }}
),
orphan_expense as (
    -- 当天有费用、却没有任何 transfer 出库行可挂的门店日（见头注：53 个组合，丢了就是 E 少算）。
    -- region_id 给 0（本仓既有的「未映射」哨兵值）：这些行没有出库，无从归属战区；
    -- 而战区级口径走 `*_store`（transfer-only），本就不会看见它们。
    select e.system_book, e.bizday, e.branch_num, e.e_net, e.q_loss, e.q_subsidy
    from branch_expense e
    where not exists (
        select 1
        from outbound o
        where o.domain = 'transfer'
          and o.system_book = e.system_book
          and o.bizday = e.bizday
          and o.branch_num = e.branch_num
    )
)
select
    o.system_book,
    {{ subject_org() }} as org,
    o.bizday,
    o.domain,
    o.branch_num,
    o.region_id,
    o.r_net,
    o.c_cost,
    o.g_gross,
    coalesce(e.e_net, 0)::numeric(20, 2)     as e_net,
    coalesce(e.q_loss, 0)::numeric(20, 2)    as q_loss,
    coalesce(e.q_subsidy, 0)::numeric(20, 2) as q_subsidy,
    (o.r_net - o.c_cost - coalesce(e.e_net, 0))::numeric(20, 2) as n_net,
    -- 门店域（transfer-only）分量：战区级/门店级口径只走这两列（理由见头注）。
    case when o.domain = 'transfer' then o.r_net else 0 end::numeric(20, 2) as r_net_store,
    case when o.domain = 'transfer'
         then (o.r_net - o.c_cost - coalesce(e.e_net, 0)) else 0 end::numeric(20, 2) as n_net_store
from outbound o
-- ★ join 必须带 `domain = 'transfer'`（见头注）：wholesale 行挂门店费用 = 把 99 的费用错记给批发。
left join branch_expense e
       on o.domain = 'transfer'
      and o.system_book = e.system_book
      and o.bizday = e.bizday
      and o.branch_num = e.branch_num

union all

-- 只有费用的行（domain='expense'）：R/C/G 恒 0，N = −E。**必须保留**，否则总仓级 N 的 E 少算。
select
    x.system_book,
    {{ subject_org() }} as org,
    x.bizday,
    'expense' as domain,
    x.branch_num,
    0::bigint as region_id,
    0::numeric(20, 2) as r_net,
    0::numeric(20, 2) as c_cost,
    0::numeric(20, 2) as g_gross,
    x.e_net,
    x.q_loss,
    x.q_subsidy,
    (-x.e_net)::numeric(20, 2) as n_net,
    0::numeric(20, 2) as r_net_store,
    0::numeric(20, 2) as n_net_store
from orphan_expense x
