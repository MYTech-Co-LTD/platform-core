-- audit_lemeng__outbound__region_conservation — 战区出库面**不得增删金额**（#1181）。
--
-- 本模型只做归因（换战区、分通道），不重算：`Σ(fct_outbound_region.r_net)` 按
-- `(system_book, bizday)` 必须**逐分等于** `Σ(fct_hq_outbound.r_net)`。
-- 会红的真实故障：left join 放大（dim_client 粒度不唯一 ⇒ 一行出库匹配多行客户）、
-- 分组键写错丢行、`coalesce` 把 null 金额当 0 后又不计入。
-- 订单数/行数同判（整数，精确相等）。
with a as (
    select system_book, bizday,
           sum(r_net)::numeric(20,2) as r_net,
           sum(order_count)::bigint  as order_count,
           sum(line_count)::bigint   as line_count
    from {{ ref('fct_outbound_region') }}
    group by 1, 2
),
b as (
    select system_book, bizday,
           sum(r_net)::numeric(20,2) as r_net,
           sum(order_count)::bigint  as order_count,
           sum(line_count)::bigint   as line_count
    from {{ ref('fct_hq_outbound') }}
    group by 1, 2
)
select coalesce(a.system_book, b.system_book) as system_book,
       coalesce(a.bizday, b.bizday)           as bizday,
       a.r_net as region_r_net,   b.r_net as outbound_r_net,
       a.order_count as region_orders, b.order_count as outbound_orders,
       a.line_count  as region_lines,  b.line_count  as outbound_lines,
       '战区出库面与出库构件不等：join 放大 / 分组丢行 / 金额未原样传递' as note
from a
full join b using (system_book, bizday)
where abs(coalesce(a.r_net, 0) - coalesce(b.r_net, 0)) > 0.01
   or coalesce(a.order_count, 0) <> coalesce(b.order_count, 0)
   or coalesce(a.line_count, 0)  <> coalesce(b.line_count, 0)
union all
-- 空转绿守卫：两侧都空 ⇒ 对账在空集上「通过」不算数
select null, null, null, null, null, null, null, null,
       '两侧都为空：对账在空集上「通过」是空转绿'
where not exists (select 1 from b)
