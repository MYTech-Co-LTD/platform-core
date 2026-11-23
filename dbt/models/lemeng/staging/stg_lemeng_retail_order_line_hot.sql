-- stg_lemeng_retail_order_line_hot — 热层「最新批次」的读取包装（#2761，Lambda 速度层）。
--
-- 为什么单独成模型：`gen-data-projection.mjs` 的位点识别不允许「SELECT … 顶层 FROM」的选列区
--   跨到嵌套 select（实测报「第 3 处的选列区里出现嵌套 select」）。stg 的第三腿必须是
--   「纯列 + 主 FROM」形态 ⇒ 把 `run_token = max(...)` 这层子查询放到这里。
--
-- 语义：**快照式**——只读每个账套的最新一批（采集每 10 分钟追加一批）。
--   · 不用 upsert 的原因：upsert 按唯一键覆盖，表达不了「本批比上批少了一行」（源端撤单），
--     那行会永久残留；读最新批次则天然等价于「本批的真实状态」。
--   · 热表是 pg 原生表 ⇒ 普通列名访问（不是 `r['col']`）。
select
  t.batch_id,
  t.system_book,
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
