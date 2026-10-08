-- 012_dim_transfer_out.sql — 配送调出单发布表（#499/R2；售后工单金额依据的取价面）。
--
-- 粒度 = 一张配送单的一个商品行（跨批次聚合：同单同商品多批次行的金额/数量在发布侧求和——
-- 工单退款按「这单这商品」算，不细分批次）。仅 3120 主账套（64188=外部批发客户，R2 拍板）。
--
-- price_minor = round(sum(out_money) / nullif(sum(quantity),0) × 100)：
--   **基本单位分价**——按单结算口径（实测配送单实际价 27 ≠ 档案批发价 25，差 8%，
--   见 R2 探针），发布面从单据行现算，不取档案价。
-- state_code = 3（已审核）才发布：制单未审的单金额未定；实测审核与制单同刻，
--   极端晚审的单在其后每日重发时自然进入（staging 该行状态随最近一次采集更新）。
-- out_money 为 0/空的行（纯赠品行）不参与聚合——无结算价可发。
--
-- 幂等（job 每天重跑）：发布侧 delete 后整批 insert；迁移本身 drop 重建（首建无消费方）。
drop table if exists data.dim_transfer_out;

create table data.dim_transfer_out (
  org            text not null,
  order_no       text not null,
  order_type     text,
  state_code     int,
  business_date  text,
  create_time    text,
  audit_time     text,
  branch_code    text not null,
  branch_name    text,
  out_branch_name text,
  item_code      text not null,
  item_grade_num bigint not null default 0,
  item_name      text,
  quantity       decimal(14,6),
  out_money      decimal(14,2),
  price_minor    bigint not null,
  bizday         date not null,
  primary key (org, order_no, item_code, item_grade_num)
);

create index if not exists data_dim_transfer_out_branch_idx on data.dim_transfer_out (org, branch_code, bizday);
