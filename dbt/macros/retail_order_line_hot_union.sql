{% macro retail_order_line_hot_union() %}
{#
  零售明细的「热层」union 腿（#2761，Lambda 速度层）。

  为什么整条腿封在 macro 里（而不是写进模型正文）：
    · `gen-data-projection.mjs` 会把模型里每个「SELECT … 顶层 FROM」位点的列区重写成
      `r['列名']::type` 形态（那是 parquet 专用写法）。热表是 **pg 原生表**，`r['col']` 不适用；
    · 它的位点识别又要求「后续位点必须是行首 select」，且选列区不许出现嵌套 select。
    ⇒ 把整条腿（含「取最新批次」子查询）包进 macro：**生成器只看到 `双花括号占位符`，看不到 select**，
      渲染时才展开。这样既不改生成器，也不改契约形态。

  ⚠️ 列清单必须与 `contracts/` 的零售明细列集**同序同形**（union all 按位置对齐）。
     契约改列时这里要同步 —— 已登记在 spec §4.3 的漂移风险里。
  ⚠️ `subject_org() as org` 必须在第 3 位（与冷腿/湖热腿一致）：行级授权谓词 `WHERE org = <orgId>`
     由 modules/data 恒拼，关系里缺这一列会让整张关系对租户不可见。
#}
union all
select
  t.batch_id,
  t.system_book,
  {{ subject_org() }} as org,
  t.bizday,
  t.hour,
  t.order_no,
  t.order_detail_num,
  t.branch_num,
  t.branch_name,
  t.order_time,
  t.order_operate_time,
  t.state,
  t.order_source,
  t.item_num,
  t.item_code,
  t.sale_money,
  t.discount_money,
  t.payment_money,
  t.quantity,
  t.order_transaction_type,
  t.order_ref_billno,
  t.order_detail_share_discount,
  t.order_detail_std_price,
  t.order_detail_price,
  t.order_detail_online_qty,
  t.order_total_money
from staging.retail_hot t
where t.run_token = (
  select max(h.run_token) from staging.retail_hot h where h.system_book = t.system_book
)
{% endmacro %}
