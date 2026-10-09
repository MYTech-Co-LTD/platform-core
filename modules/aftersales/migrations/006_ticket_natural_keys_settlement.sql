-- 006_ticket_natural_keys_settlement.sql — 工单自然键化 + 挂原单冻结列（#500/#517 段③；spec
-- docs/superpowers/specs/2026-10-09-500-ticket-settlement-price-design.md §6.2/§6.3）。
--
-- 自然键化（005 同款死列化）：product_id/store_id 摘 FK/not null（**不 drop**，保 001 全量重跑），
-- 新引用列 = dim_item.item_code / dim_branch.code（text not null default ''，与模块内其余 text 列口径一致）。
--
-- 挂原单冻结列（settlement_* 六列）：建单时按 (org, order_no, item_code, line_key) 从
-- data.dim_settlement_order_line 取行冻结——**金额依据随工单定死**，后续调价/促销不得改写。
--   · settlement_price_minor：基本单位分价（该行的 price_minor 逐字冻结）
--   · settlement_bizday：该行的制单日（审计用「价的时点」）
--   · source/order_no/item_code/line_key：依据四元组（票面可追溯到具体那张 MO/WO 的那一行）
--
-- 旧快照列 basic_quantity / basic_unit_price_minor **本迁移不动**：存量 pending 工单的退款计算
-- 仍读它们（路由侧 COALESCE(settlement_price_minor, basic_unit_price_minor) 做兼容桥）；新单自
-- settlement_price_minor 取价。退役（drop）留给后续迁移——005/006 同一口径：先断写，不急删。
--
-- 幂等：alter 全部 if exists / drop constraint if exists，重复执行不报错。
alter table aftersales.ticket
  alter column product_id drop not null,
  alter column store_id drop not null;
alter table aftersales.ticket drop constraint if exists ticket_product_id_fkey;
alter table aftersales.ticket drop constraint if exists ticket_store_id_fkey;

alter table aftersales.ticket
  add column if not exists product_code            text not null default '',
  add column if not exists store_code              text not null default '',
  add column if not exists settlement_source       text not null default '',
  add column if not exists settlement_order_no     text not null default '',
  add column if not exists settlement_item_code    text not null default '',
  add column if not exists settlement_line_key     text not null default '',
  add column if not exists settlement_price_minor  bigint,
  add column if not exists settlement_bizday       date;
