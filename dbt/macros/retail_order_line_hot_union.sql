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
  -- 取批必须**按窗**（system_book + bizday + hour）各取最新，不能取全局最新（#2803 实测）：
  -- 采集 tick 的每个窗口是独立子管线、各写各的 run_token（`${datetime}`），全局 max
  -- 只剩「最后写完的那一窗」⇒ 湖腿闭窗排除两窗（当前小时 + 前一小时）时，另一窗整段缺失。
  -- 2026-11-24 19:20 真机：湖闭窗 6,453 + 全局最新批 1,388 = 7,841，比湖全量 8,144 少 303；
  -- 按窗取最新 = 1,691，6,453 + 1,691 = 8,144，逐行一致。
  select max(h.run_token) from staging.retail_hot h
  where h.system_book = t.system_book
    and h.bizday = t.bizday
    and h.hour = t.hour
)
-- 只补「湖腿闭窗排除掉的那两窗」，且**仅限今天**——与 `closed_before_predicate` 严格互补：
--   · 湖腿 = not (bizday = 上海今天 and hour >= 上海当前小时 - 1)；
--   · 跨日（00–01 点）热表最后一窗是「昨天 h23」，而湖腿此时**包含**它 ⇒ 不按今天过滤
--     就会双算；昨天缺的尾款由湖腿自己提供。
--   · 某窗连续失败时，按窗最新批可能落在闭窗之外（旧小时）⇒ 用同一个 hour 下界剔掉，
--     那部分由湖腿照常读，不会与热腿重叠。
and t.bizday = {{ shanghai_today() }}
and t.hour >= {{ shanghai_hour_now() }} - 1
{% endmacro %}
