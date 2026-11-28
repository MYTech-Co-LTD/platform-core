-- 058_settlement_line_org_day_index.sql — 结算行的 (org, order_bizday) 索引（全门店商品搜索）
--
-- 背景：售后访客端的商品搜索支持「不选门店」——直接在我可见门店的近 30 天结算行里找
-- 历史商品名/编码。原有索引 data_dim_settlement_order_line_store_idx 的第二列是 store_code，
-- 不带门店条件时无法按日期剪枝 ⇒ 622 MB 堆表全扫（生产实测冷查询 3.8 s）。
--
-- 本索引用 include 而不是把三列都放进键：order_bizday 之后的列不参与排序/剪枝，
-- 只作覆盖列。这样近 30 天的聚合可以走 index-only scan（store_code 过滤、item_code/item_name
-- 聚合全部在索引内）：生产实测 475 ms → 15 ms，完整搜索 SQL 50 ms 量级。
--
-- 幂等：create index if not exists（迁移会被重复执行）。
create index if not exists data_dim_settlement_order_line_org_day_idx
  on data.dim_settlement_order_line (org, order_bizday)
  include (store_code, item_code, item_name);
