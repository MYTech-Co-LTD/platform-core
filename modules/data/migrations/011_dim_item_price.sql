-- 011_dim_item_price.sql — 门店商品应用价发布表（#481 价格批；ADR 形状②的第三张发布维表）。
--
-- 为什么独立成表（不进 dim_item）：粒度事实——乐檬零售价只存在于「门店 × 商品」粒度
-- （商品维无零售价列，#476 侦察已证；价格在乐檬体系挂价格批/门店设定价）。往 dim_item
-- （org+item_code 粒度）塞价格列必须挑一个「代表店」＝不诚实 ⇒ 走 issue #481 验收里
-- 「或工单侧有等价来源」：ticket 建单按 (store_code, item_code) 到本表取价。
--
-- 键 = (org, store_code, item_code, grade_item_num)：
--   · grade_item_num **not null default 0** —— 0 = 主商品价（源侧行 grade 为 null，发布侧
--     coalesce(…, 0)）；PG 主键列不许 NULL，且 0 哨兵让建单 join（grade is null 语义）写成
--     `grade_item_num = 0`。分级价行（grade > 0）并存，建单不查它们。
--   · 去重规则收在 publish-dims.mjs（同 009 口径①）：两账套交集门店取 system_book 字典序小者
--     （3120 优先，确定性），source_book 记录该行取自哪个账套。
--   · `regular_real_price` 为 0/空的行**不发**（源侧「未单独设置」，无诚实价可发；
--     64188 全量实测 2,192 行 = 1.07%）。
--
-- price_minor = round(regular_real_price * 100 / coalesce(nullif(spec_rate, 0), 1))：
--   单价挂在 spec_unit 上，spec_rate 是到基本单位的换算率（缺/0 视同 1 = 不换算）。
--   ⚠️ 该换算口径的真机验证是 #481 计划 Task 7 未验环节①——证伪则改 publish SQL 重发，
--   本迁移只存结果值（value 列，口径在 publish 侧单点）。
--
-- 形状变更走新迁移（同 009 注）；drop 重建此刻零成本（首建，无消费方）。
drop table if exists data.dim_item_price;

create table data.dim_item_price (
  org            text not null,
  store_code     text not null,
  item_code      text not null,
  grade_item_num bigint not null default 0,
  price_minor    bigint not null,
  price_raw      decimal(18,8),
  source_book    text not null,
  snapshot       date not null,
  primary key (org, store_code, item_code, grade_item_num)
);

create index if not exists data_dim_item_price_item_idx on data.dim_item_price (org, item_code);
