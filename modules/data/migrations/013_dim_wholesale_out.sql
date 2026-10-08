-- 013_dim_wholesale_out.sql — 批发销售单发布表（#499/R3；售后的批发客户侧取价面）。
--
-- 粒度 = 一张批发单的一个商品行（order_detail_num 天然唯一，不再聚合）。
-- 仅 3120 主账套（WO 发货方=3120 管理中心/批发仓；收货方 client_fid=品品甜等外部批发客户）。
--
-- price_minor = round(money ÷ nullif(quantity,0) × 100)：**基本单位分价**——按单结算口径
--   （order_detail_price 与无极副本 basic_unit_price 逐分对平实测；同配送单，档案价不作数）。
-- state_code = 3（制单|审核）才发布；money ≤ 0（纯赠品行/负行）不发布。
--
-- 幂等：发布侧 delete 后整批 insert；迁移本身 drop 重建（首建无消费方）。
drop table if exists data.dim_wholesale_out;

create table data.dim_wholesale_out (
  org              text not null,
  order_no         text not null,
  client_fid       text,
  state_code       int,
  branch_num       int,
  item_code        text not null,
  item_name        text,
  order_detail_num int not null,
  quantity         decimal(14,6),
  money            decimal(14,2),
  price_minor      bigint not null,
  bizday           date not null,
  primary key (org, order_no, item_code, order_detail_num)
);

create index if not exists data_dim_wholesale_out_client_idx on data.dim_wholesale_out (org, client_fid, bizday);
