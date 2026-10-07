-- 008_dim_snapshots.sql — 已发布维表快照（ADR 2026-10-07 跨模块数据消费契约，形状②）。
--
-- 这两张表是 data 模块**对外发布的维表快照**（门店/商品），由 publish-dims.mjs 从
-- 数据面 warehouse 的 staging 维表裁剪发布（org 裁剪 + 列裁剪——stg_lemeng_item 有 190+ 列，
-- 发布契约只含消费方要的；列集的变更走本文件 + 发布脚本，走 PR）。
--
-- 消费纪律（ADR §5）：业务模块只许 **from/join 只读**（lint B1 白名单 `data.dim_` 只开读——
-- update/into 仍红：发布表只许 owner 写）。写入唯一入口 = publish-dims.mjs。
-- 版本语义：`snapshot`（业务日）随每次发布整批替换——消费方读到的永远是「某一版」，
-- 新鲜度由探活断言盯（staging 领先而 dim 停更 ⇒ 探活红）。
create table if not exists data.dim_branch (
  org          text not null,
  system_book  text not null,
  code         text not null,
  name         text not null,
  enable       boolean,
  address      text,
  phone        text,
  region_id    text,
  province     text,
  city         text,
  district     text,
  snapshot     date not null,
  primary key (org, system_book, code)
);

create table if not exists data.dim_item (
  org          text not null,
  system_book  text not null,
  item_code    text not null,
  bar_code     text,
  name         text not null,
  spec         text,
  unit_name    text,
  sale_cease   boolean,
  eliminate    boolean,
  snapshot     date not null,
  primary key (org, system_book, item_code)
);

-- 条码查商品（售后建单扫码选货的形状）：(org, bar_code) 点查
create index if not exists data_dim_item_bar_code_idx on data.dim_item (org, bar_code);
-- 名称搜索（售后 /products 的 q ilike）：org + name 前缀扫描有索引可走
create index if not exists data_dim_branch_name_idx on data.dim_branch (org, name);
create index if not exists data_dim_item_name_idx on data.dim_item (org, name);
