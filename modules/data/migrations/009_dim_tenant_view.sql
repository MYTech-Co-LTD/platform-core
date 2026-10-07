-- 009_dim_tenant_view.sql — 发布维表改为「跨账套去重的租户视图」（#476 口径①，人裁 2026-10-07：方案 C）。
--
-- 为什么改：008 的主键含 system_book（按账套分份发布）。首个消费方（售后）的口径是
-- 「本租户的门店/商品清单」——不分账套。实测两账套**不是包含关系**（3120=271、64188=129、
-- 交集仅 40）⇒ 消费方自行并集/去重会把 owner 的规则复制到每个消费方 ⇒ 按口径① 把去重
-- 收进发布面：本表 = **跨账套去重后的租户视图**，去重规则在 publish-dims.mjs（SQL distinct on）：
--   · 键 = org + 自然键（code / item_code）；
--   · 启用/在售标记：任一账套为真即为真（OR）；
--   · 其余属性：取「在售行」优先，同状态取 system_book 字典序小者（3120 优先，确定性）；
--   · source_book 记录该行取自哪个账套（排障用，消费方无感）。
-- 账套原始数据仍在数据面 staging（本表不含账套粒度；按账套的分析走问数/语义层，不走这里）。
--
-- 008 建的两张表此刻**无任何消费方**（发布后尚未被读）⇒ drop 重建零成本；此后形状变更走新迁移。
drop table if exists data.dim_branch;
drop table if exists data.dim_item;

create table data.dim_branch (
  org          text not null,
  code         text not null,
  name         text not null,
  enable       boolean,
  address      text,
  phone        text,
  region_id    text,
  province     text,
  city         text,
  district     text,
  source_book  text not null,
  snapshot     date not null,
  primary key (org, code)
);

create table data.dim_item (
  org          text not null,
  item_code    text not null,
  bar_code     text,
  name         text not null,
  spec         text,
  unit_name    text,
  sale_cease   boolean,
  eliminate    boolean,
  source_book  text not null,
  snapshot     date not null,
  primary key (org, item_code)
);

create index if not exists data_dim_item_bar_code_idx on data.dim_item (org, bar_code);
create index if not exists data_dim_branch_name_idx on data.dim_branch (org, name);
create index if not exists data_dim_item_name_idx on data.dim_item (org, name);
