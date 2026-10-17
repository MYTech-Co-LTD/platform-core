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
-- 【粒度】(system_book, bizday, domain, branch_num, region_id) —— **与 fct_hq_outbound 逐字同粒度**。
--   为什么**不折叠 domain**：折叠后同一 (账套,业务日,门店) 会把 transfer 与 wholesale 并成一行，
--   而两者的 `branch_num` **语义不同**（见下），并完就再也分不开。保留 domain ⇒ 门店级口径
--   天然只落在 transfer 行上，99 行（纯批发）自动隔离，不需要任何过滤条件。
--
-- 【⚠️ 门店费用的挂载范围（本构件最关键的一条）】门店费用**只挂到 transfer 域**的行上：
--   `fct_hq_outbound.branch_num` 在**两个域里语义不同**——transfer 是**调入门店（收货门店）**，
--   wholesale 是**发货方编号（99=管理中心/批发仓）**（`contracts/common/lemeng.wholesale_out.json`
--   逐字："发货方编号（99=管理中心/批发仓）"）。而 `fct_branch_expense.branch_num` 是**归属门店**。
--   ⇒ 只有 transfer 行的 branch_num 能与门店费用对齐；wholesale 行 join 上去会**把 99 的费用
--   错记到批发头上**。故 join 条件带 `o.domain = 'transfer'`。
--   ⇒ 两个口径因此**都对**：
--     · **门店级** = 该店 transfer 行（R/C 是该店的、E 是该店的）；
--     · **总仓级** = 全行求和（wholesale 行 e_net 恒 0 ⇒ Σ = ΣR − ΣC − ΣE，正是客户文档的 N）。
--   ⚠️ 这两者的 E 口径**不同**（门店级只有门店费用；总仓级含客户费用时需另算）——见 L1 definition。
--
-- 【⚠️ 战区维度的既存边界（继承，不在本构件修）】wholesale 行的 `region_id` 来自
--   `fct_hq_outbound` 对 branch_num=99 的 dim_branch 回落 ⇒ **批发归属战区的语义可疑**。
--   本构件原样继承。客户文档 02-01 要求「批发 client_fid 关联 X01 映射」，那需要出库侧带
--   client_fid 才能做，**不在本批**（见 #744 Task 0 补记②）。
--
-- 【口径构件（客户公共定义）】R=r_net / C=c_cost / G=g_gross（出库侧原样透传）/
--   E=e_net（门店费用净额）/ N=n_net = R−C−E。补损与补贴分量按**真机实测的取值字面量**筛
--   （2026-10-16 全量分组实测：`产品售后补损` / `抖音直播补贴`；客户文档另提「小程序或线下补贴」，
--   **数据里不存在**——definition 按实际写，并注明该差异）。
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
    -- ── 门店域（transfer-only）分量 ────────────────────────────────────────────────
    -- 为什么单列而不是让调用方按 domain 过滤：**战区/门店级口径当前只能覆盖 transfer 域**——
    --   ① 门店费用的对象是「归属门店」，只有 transfer 行的 branch_num 对得上；
    --   ② 客户文档 02-04 要求批发按 client_fid→X01 映射归战区，而本仓出库侧**没有 client_fid**
    --      （见 #744 Task 0 补记②），批发行的 region_id 是 branch_num=99 回落 dim_branch 的
    --      **幻影战区**（真机实测：全部批发落进单个 region_id=9046，与 12 个真战区不重叠）。
    --   ⇒ 战区级/门店级口径必须走这两列；全域列（r_net/n_net）只服务总仓级。
    --   把边界做进结构，比「让每个调用方记得过滤」可靠——后者漏一次就是静默错数。
    case when o.domain = 'transfer' then o.r_net else 0 end::numeric(20, 2) as r_net_store,
    case when o.domain = 'transfer'
         then (o.r_net - o.c_cost - coalesce(e.e_net, 0)) else 0 end::numeric(20, 2) as n_net_store
from {{ ref('fct_hq_outbound') }} o
-- ★ join 必须带 `domain = 'transfer'`（见头注）：wholesale 行挂门店费用 = 把 99 的费用错记给批发。
left join branch_expense e
       on o.domain = 'transfer'
      and o.system_book = e.system_book
      and o.bizday = e.bizday
      and o.branch_num = e.branch_num
