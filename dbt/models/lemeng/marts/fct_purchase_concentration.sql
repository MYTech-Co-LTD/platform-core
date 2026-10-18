{{
    config(materialized='table')
}}
-- fct_purchase_concentration.sql — **供应商集中度**预聚合构件（#744 W3，2026-10-17）。
--
-- 【它为什么必须预聚合】CR5 = 前 5 净采购额 / 全部净采购额，含**排序取前 5**——是子查询语义，
--   塞不进 L1 的 `select <聚合> as value, <维度…> from <单一关系>` 形状。故在本构件里先算好
--   `total_p` / `top5_p` / `top10_p`，L1 只做一次除法。
--
-- 【粒度】(system_book, bizday, item_department) —— **月度**，不是日。
--   客户文档 01-07/05-06/06-04 的频率栏都是「月｜A」；CR5 **不可按日累加**（排序比率），
--   所以报告期必须进 grain。
--   ⚠️ **列名叫 `bizday`，但值是「业务日所在月的 1 号」**（date 型），不是业务日。为什么仍叫 bizday：
--     问数参数面的契约要求**每条 L1 的 grain 必须含 `bizday`**（`sync-data-semantics.test.ts`
--     的「问数参数面逐条断言」逐条核对），而参数白名单只认 bizday→date_range / system_book / domain。
--     叫 `period_month` 会直接违约、且该指标在问数面**没有任何日期参数**。改叫 bizday 后，
--     用户可以用日期区间筛「哪几个月」（from=to=某月 1 号即单月）。
--   ⚠️ 与仓里其他指标（真·日粒度）**不同粒度**，definition 已写明，别与日粒度指标混算/join。
--
-- 【口径】净采购额 = Σ(purchase_item_money − purchase_item_return_money)，与 `purchase:net_amount`
--   逐字同源。**赠品不计入**（客户文档边界，同 net_amount）。
--   · `total_p` = 该 (账套,月,部门) **全部供应商**的净采购额合计（含负数供应商）；
--   · `top5_p` / `top10_p` = 按供应商净采购额**降序**取前 5 / 前 10 **且净额 > 0** 的合计。
--     客户文档 01-07：「净采购为负的供应商及非正总额单列」⇒ 负数供应商**不进分子**，
--     但仍进分母（否则比率会 > 100%）。这条取舍写进 L1 definition，属客户口径的解释性落地。
--
-- 【部门维度】`fct_purchase` 本身**没有部门列**（D11 summary 不带部门），故经 `dim_item` 取。
--   ⚠️ `dim_item` 是**快照表**（每 snapshot 一份全量）——必须取**最新快照**，否则按 snapshot 放大
--      （与 `fct_hq_outbound` 的 branch_latest 同一范式）。取不到部门的记 `(未映射)`，不丢弃。
--
-- 【服务客户项】01-07 供应商集中度 · 05-06 水果供应商集中度 · 06-04 供应商集中度 ——
--   客户附录三处公式**逐字相同**，差异只在「水果/标品」的部门筛选 ⇒ **一条口径 + 部门维度**，
--   不各声明一条。
with item_latest as (
    select system_book, item_num, item_department_name
    from (
        select
            system_book,
            item_num,
            coalesce(nullif(item_department_name, ''), '(未映射)') as item_department_name,
            row_number() over (
                partition by system_book, item_num
                order by snapshot desc
            ) as rn
        from {{ ref('stg_lemeng_item') }}
    ) t
    where rn = 1
),
supplier_period as (
    -- 先到 (账套, 月, 部门, 供应商) 粒度：CR5 的排序单位是供应商。
    select
        p.system_book,
        date_trunc('month', p.bizday)::date as bizday,
        coalesce(i.item_department_name, '(未映射)') as item_department,
        p.supplier_num,
        sum(p.purchase_item_money - p.purchase_item_return_money)::numeric(20, 2) as net_p
    from {{ ref('fct_purchase') }} p
    left join item_latest i
           on i.system_book = p.system_book
          -- ⚠️ 类型必须显式 cast：`stg_lemeng_item.item_num` 是 **text**（商品编码形态），
          -- 而 `fct_purchase.item_num` 是 **bigint**（D11 契约）。不 cast 会报
          -- `operator does not exist: text = bigint`（2026-10-17 真机首跑就撞上）。
          -- 真机实测 40,371 个商品号全部可无损转 bigint，故往 bigint 靠。
          and i.item_num::bigint = p.item_num
    group by 1, 2, 3, 4
),
totals as (
    select
        system_book,
        bizday,
        item_department,
        sum(net_p)::numeric(20, 2) as total_p,
        count(*)                   as supplier_count
    from supplier_period
    group by 1, 2, 3
),
top_suppliers as (
    -- 只对**净额 > 0** 的供应商排序（客户文档：负额供应商单列，不进分子）。
    select
        system_book,
        bizday,
        item_department,
        sum(case when rn <= 5  then net_p else 0 end)::numeric(20, 2) as top5_p,
        sum(case when rn <= 10 then net_p else 0 end)::numeric(20, 2) as top10_p
    from (
        select
            system_book,
            bizday,
            item_department,
            net_p,
            row_number() over (
                partition by system_book, bizday, item_department
                order by net_p desc
            ) as rn
        from supplier_period
        where net_p > 0
    ) ranked
    group by 1, 2, 3
)
select
    t.system_book,
    {{ subject_org() }} as org,
    t.bizday,
    t.item_department,
    t.total_p,
    t.supplier_count,
    coalesce(s.top5_p, 0)::numeric(20, 2)  as top5_p,
    coalesce(s.top10_p, 0)::numeric(20, 2) as top10_p
from totals t
left join top_suppliers s
       on s.system_book = t.system_book
      and s.bizday = t.bizday
      and s.item_department = t.item_department
