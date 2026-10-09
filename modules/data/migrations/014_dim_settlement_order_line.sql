-- 014_dim_settlement_order_line.sql — 工单挂原单取价面（#517 段②；spec
-- docs/superpowers/specs/2026-10-09-500-ticket-settlement-price-design.md §4）。
--
-- 粒度 = **原单行**：MO=配送单×商品×grade 行；WO=批发单×明细行（order_detail_num）。
-- 工单建单时按 (org, order_no, item_code, line_key) 精确取行冻结 price_minor——
-- **发布侧不做跨行聚合**（与 012 的批次并 grade 行不同，本面沿用其结果行）。
--
-- 只收已审（state_code=3）且金额为正的行（沿用 012/013 判据；赠品行无结算价不进面）。
-- price_minor = round(金额 ÷ 数量 × 100)：**基本单位分价**，按单结算口径
--   （MO=out_money÷quantity，WO=money÷quantity；实测按单结算价 ≠ 档案价，见 012 头注）。
-- store_code：MO=调入门店 branch_code（现成）；WO=经客户档案对照表解析的门店码
--   （override → 精确同名 → dim_branch，规则在 publish-dims——本表只存解析结果）。
-- order_no 空间 MO*/WO* 天然不相交 ⇒ PK 不需要 source；source 列仅作展示与审计。
--
-- 幂等（job 每天重跑）：发布侧 delete 后整批 insert；迁移本身 drop 重建（首建无消费方）。
drop table if exists data.dim_settlement_order_line;

create table data.dim_settlement_order_line (
  org          text not null,
  source       text not null,
  store_code   text not null,
  store_name   text,
  order_no     text not null,
  order_bizday date not null,
  order_time   text,
  item_code    text not null,
  item_name    text,
  line_key     text not null,
  quantity     decimal(14,6),
  money        decimal(14,2),
  price_minor  bigint not null,
  primary key (org, order_no, item_code, line_key)
);

create index if not exists data_dim_settlement_order_line_store_idx
  on data.dim_settlement_order_line (org, store_code, order_bizday);
