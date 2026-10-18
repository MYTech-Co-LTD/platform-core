{{
    config(materialized='table')
}}
-- fct_client_contribution.sql — **客户级费用后贡献**组合构件（#744 甲方案兑现，2026-10-17）。
--
-- 【它为什么存在】同 fct_contribution 的理由：L1 的 select_sql 形状契约是
--   `select <聚合表达式> as value, <维度…> from <单一关系>`——**from 只能一个关系**，
--   「出库 × 费用」必须先落成一张 mart 才写得出声明。本构件与 fct_contribution 的分缝是
--   **对象维度**：fct_contribution 答「门店/战区/总仓」（对象=门店），本构件答「客户」
--   （对象=批发客户）。#744 Task 0 补记② 卡了半年的「出库侧没有 client_fid」已随
--   fct_hq_outbound 扩第 6 粒度键（2026-10-17）解除，本构件是那个前置的直接兑现。
--
-- 【粒度】(system_book, bizday, client_fid)——被 assert_fct_client_contribution_grain_unique 钉住。
--   两侧键都非空：出库侧筛 `domain='wholesale'`（transfer 行 client_fid 恒 NULL，被域筛挡在门外；
--   wholesale 侧真机 2140/2140 非空），费用侧 fct_client_expense 的 client_fid 挂 not_null。
--   ⇒ FULL JOIN 不产生 NULL 键行，schema.yml 敢挂 not_null。
--
-- 【口径（客户公共定义 R/C/E/N）】
--   · R/C/G：**只含批发域**（fct_hq_outbound where domain='wholesale'）——客户对象的出库只有批发；
--     门店费用与配送出库的对象是门店，不是客户，不进本构件（那是 fct_contribution 的地盘）。
--     退货冲减已在上游构件内完成（r_net/c_net 是净额），这里直接透传聚合。
--   · E：客户费用净额 = Σ(应付−应收)，按 (账套,日,客户) 汇总（聚合掉 other_inout_kind）。
--     **含当天只有费用、没有出库的客户**（FULL JOIN 保留）——照 fct_contribution 的教训
--     （53 个孤儿费用组合，left join 会静默丢 E），宁可多一类「只有费用」的客户日行。
--   · N = R − C − E。金额一律 numeric(20,2)；计数列相加可加。
--
-- 【与客户文档的对应】服务 01-03「客户费用后贡献」/ 02-04 的客户下钻 / 08-05 的分子。
--   ⚠️ 客户文档 01-03 的**完整 N** = R − C − (门店费用 + 客户费用)：门店费用挂不到客户
--   （fct_branch_expense.branch_num 是门店，与批发客户的 branch_num=99 发货方不同义），
--   故本构件的 N 只扣客户费用——「客户级完整 N」在数据上不存在挂载依据，definition 已注明。
--   符号语义随裁9（费用应付/应收的方向语义），未回签前 L1 experimental。
--
-- 【org】主体列由 subject_org 宏注入常量（规则 ⑩ 单一形状），不透传、不进 GROUP BY。
with outbound as (
    -- 批发出库按客户聚合：branch_num（发货方 99）与 region_id（幻影战区）对客户口径无意义，聚合掉。
    select
        system_book,
        bizday,
        client_fid,
        sum(r_net)::numeric(20, 2)   as r_net,
        sum(c_cost)::numeric(20, 2)  as c_cost,
        sum(g_gross)::numeric(20, 2) as g_gross,
        sum(order_count)::bigint     as order_count,
        sum(line_count)::bigint      as line_count
    from {{ ref('fct_hq_outbound') }}
    where domain = 'wholesale'
    group by 1, 2, 3
),
expense as (
    -- 客户费用聚合掉费用项目维度：e_net = Σ(应付−应收) 按客户日汇总。
    select
        system_book,
        bizday,
        client_fid,
        sum(e_net)::numeric(20, 2) as e_net,
        sum(bill_count)::bigint    as bill_count
    from {{ ref('fct_client_expense') }}
    group by 1, 2, 3
)
select
    coalesce(o.system_book, e.system_book) as system_book,
    {{ subject_org() }}                    as org,
    coalesce(o.bizday, e.bizday)           as bizday,
    coalesce(o.client_fid, e.client_fid)   as client_fid,
    coalesce(o.r_net, 0)::numeric(20, 2)        as r_net,
    coalesce(o.c_cost, 0)::numeric(20, 2)       as c_cost,
    coalesce(o.g_gross, 0)::numeric(20, 2)      as g_gross,
    coalesce(o.order_count, 0)::bigint          as order_count,
    coalesce(o.line_count, 0)::bigint           as line_count,
    coalesce(e.e_net, 0)::numeric(20, 2)        as e_net,
    coalesce(e.bill_count, 0)::bigint           as bill_count,
    (coalesce(o.r_net, 0) - coalesce(o.c_cost, 0) - coalesce(e.e_net, 0))::numeric(20, 2) as n_net
from outbound o
full join expense e
       on o.system_book = e.system_book
      and o.bizday = e.bizday
      and o.client_fid = e.client_fid
