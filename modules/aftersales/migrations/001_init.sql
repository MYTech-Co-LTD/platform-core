-- 001_init.sql — 售后域 M2a 建表（modules/aftersales）。
--
-- 纪律（每条都有出处，别按口味改）：
--   · 全是【租户数据表】：带 org text not null，值 = identity.orgId，读写一律 where org = …（spec-1 §2）
--   · 唯一索引一律含 org；热路径索引以 org 为前缀列
--   · 金额一律【整数分】，列名 _minor 后缀，永不浮点（spec §2.1）
--   · 比例列 numeric(6,4)：源 after_sales_rule.refund_ratio 存的是【小数比例】不是百分数，
--     保存走 .toFixed(4)（spec §2.4 源码实证）——6 位精度 4 位小数，与源逐位对齐
--   · 外部系统来的字段（编码/编号/名称）一律 text，不用 varchar（团队规则 db-migration §2）
--   · 幂等：全部 if not exists——部署脚本会每次全量重跑全部迁移（团队规则 db-migration §1）
--   · 不建 archive_order / archive_order_item / department：都归 M2b（spec §2.1，无实测样本/无源表）
--
-- source_id 列的存在理由：M2b 要把 13.2 万行源数据搬进来，靠 (org, source_id) 才能做成幂等、
-- 可重跑；M2a 自己创建的行 source_id 为空串，用【部分唯一索引】避开空串互撞。

create schema if not exists aftersales;

-- ── 共用主数据（「可搬迁」纪律：通用资源名，不掺售后语义；接龙二期有第二消费者时再评估抽独立模块）──

create table if not exists aftersales.region (
  id         bigserial primary key,
  org        text not null,
  source_id  text not null default '',
  name       text not null default '',
  created_at timestamptz not null default now()
);
create unique index if not exists aftersales_region_org_source_idx
  on aftersales.region(org, source_id) where source_id <> '';
create index if not exists aftersales_region_org_idx on aftersales.region(org);

create table if not exists aftersales.store (
  id         bigserial primary key,
  org        text not null,
  source_id  text not null default '',
  name       text not null default '',
  region_id  bigint references aftersales.region(id),
  address    text not null default '',
  phone      text not null default '',
  created_at timestamptz not null default now()
);
create unique index if not exists aftersales_store_org_source_idx
  on aftersales.store(org, source_id) where source_id <> '';
create index if not exists aftersales_store_org_idx on aftersales.store(org);

create table if not exists aftersales.product (
  id                     bigserial primary key,
  org                    text not null,
  source_id              text not null default '',
  name                   text not null default '',
  spec                   text not null default '',
  -- 免赔门槛的两个输入（spec §2.4 金额公式的 basic_quantity / basic_unit_price）。单价是【整数分】。
  -- default 0 的语义是「未录」——M2a 不造假数据；M2b 按 product_archive 实测字段回填（spec §5 #7 的邻接项）。
  basic_quantity         integer not null default 0,
  basic_unit_price_minor bigint  not null default 0,
  created_at             timestamptz not null default now()
);
create unique index if not exists aftersales_product_org_source_idx
  on aftersales.product(org, source_id) where source_id <> '';
-- 商品搜索的热路径：where org = $1 and name ilike $2 —— org 前缀列
create index if not exists aftersales_product_org_name_idx on aftersales.product(org, name);

create table if not exists aftersales.employee (
  id             bigserial primary key,
  org            text not null,
  source_id      text not null default '',
  name           text not null default '',
  phone          text not null default '',
  store_id       bigint references aftersales.store(id),
  -- 移动端身份锚（spec §2.1）：源 employee_info.openId 全量带过来。
  -- 注意源侧同一概念两种拼写：employee_info.openId vs employee_info_approve.openid —— M2b join 前必须归一（spec §3.3）。
  open_id        text not null default '',
  -- 审批态：定死一套【英文】枚举（spec §5 #9）。源侧三套词表（pending|approved|rejected、
  -- 待审批|通过|驳回）在 M2b 归一到这里；中文只是展示层的事，不入库。
  approve_status text not null default 'pending'
                 check (approve_status in ('pending', 'approved', 'rejected')),
  created_at     timestamptz not null default now()
);
create unique index if not exists aftersales_employee_org_source_idx
  on aftersales.employee(org, source_id) where source_id <> '';
create index if not exists aftersales_employee_org_openid_idx on aftersales.employee(org, open_id);

create table if not exists aftersales.ticket_rule (
  id           bigserial primary key,
  org          text not null,
  source_id    text not null default '',
  name         text not null default '',
  -- 源 after_sales_rule.refund_ratio：类型注释谎称「比例(%)」，实存【小数】，
  -- 载入时 ×100、保存时 ÷100、保存走 .toFixed(4)（spec §2.4 源码实证）⇒ numeric(6,4)。
  -- 公式里它直接当乘数用：basic_quantity * refund_ratio。
  refund_ratio numeric(6,4) not null default 0,
  remark       text not null default '',
  created_at   timestamptz not null default now()
);
create unique index if not exists aftersales_ticket_rule_org_source_idx
  on aftersales.ticket_rule(org, source_id) where source_id <> '';
create index if not exists aftersales_ticket_rule_org_idx on aftersales.ticket_rule(org);

-- ── 工单（M2a 的核心表）──

create table if not exists aftersales.ticket (
  id                     bigserial primary key,
  org                    text not null,
  source_id              text not null default '',
  code                   text not null default '',
  -- 客户端幂等键（spec §2.2）：同 org 同键重复提交【返回既有工单】，不再靠前端 300ms 防抖扛并发。
  -- 它同时是附件 object key 里的 {ticket_ref} 段（spec §2.3）——因为附件必须先于工单落库上传。
  client_request_id      text not null default '',
  -- 提交者 = 访客 session 的 sub（openid，spec §1.3）。管理端代提交时留空串。
  submitter_openid       text not null default '',
  product_id             bigint references aftersales.product(id),
  -- 消歧（spec §3.3 实证表）：源 product_name 存 ID 或名称，目标拆成 id + 快照名两列，M2b 一次洗清。
  product_name           text not null default '',
  store_id               bigint references aftersales.store(id),
  store_name             text not null default '',
  damage_quantity        integer not null default 0,
  -- 提交时从 product 快照下来的三个公式输入（spec §2.4）：
  -- 快照而非 join 实时取——规则/商品改价不得改写历史工单的金额依据。
  basic_quantity         integer not null default 0,
  basic_unit_price_minor bigint  not null default 0,
  -- 三态状态机（spec §2.4）：pending → completed | cancelled。
  -- 源 types/afterSalesWorkOrder.ts 那个含 processing 的 4 态版本【全仓从未写入过】，是死声明，勿照搬。
  status                 text not null default 'pending'
                         check (status in ('pending', 'completed', 'cancelled')),
  -- 金额类型（源 after_sales_type）：【处理时】写入，pending 期间为 null。
  amount_type            text check (amount_type in ('ratio', 'fixed', 'reject')),
  amount_minor           bigint not null default 0,
  -- ratio 路落这里的比例（源 after_sales_rate）；fixed/reject 路为 null。
  refund_ratio           numeric(6,4),
  operator               text,
  remark                 text not null default '',
  -- 只读档案表引用（spec §2.1）：archive_order 本身归 M2b 建，M2a 只留这一列。
  related_order          text not null default '',
  created_at             timestamptz not null default now(),
  processed_at           timestamptz
);
create unique index if not exists aftersales_ticket_org_clientreq_idx
  on aftersales.ticket(org, client_request_id) where client_request_id <> '';
create unique index if not exists aftersales_ticket_org_source_idx
  on aftersales.ticket(org, source_id) where source_id <> '';
-- 热路径索引以 org 为前缀列。列表查询形状：
--   管理端 where org = $1 [and status = $2] order by id desc
--   访客端 where org = $1 and submitter_openid = $2 order by id desc
create index if not exists aftersales_ticket_org_id_idx on aftersales.ticket(org, id desc);
create index if not exists aftersales_ticket_org_status_id_idx on aftersales.ticket(org, status, id desc);
create index if not exists aftersales_ticket_org_submitter_id_idx
  on aftersales.ticket(org, submitter_openid, id desc);

create table if not exists aftersales.ticket_attachment (
  id                bigserial primary key,
  org               text not null,
  -- 预签名发生在工单落库【之前】（移动端先传图后提交）⇒ 此列为 null 表示「已上传、尚未被工单认领」。
  -- 提交工单时按 (org, client_request_id) 把这些行认领过去。
  ticket_id         bigint references aftersales.ticket(id),
  client_request_id text not null default '',
  object_key        text not null,
  content_type      text not null default '',
  size_bytes        bigint not null default 0,
  uploader_openid   text not null default '',
  created_at        timestamptz not null default now()
);
create unique index if not exists aftersales_ticket_attachment_org_key_idx
  on aftersales.ticket_attachment(org, object_key);
create index if not exists aftersales_ticket_attachment_org_ticket_idx
  on aftersales.ticket_attachment(org, ticket_id);
create index if not exists aftersales_ticket_attachment_org_clientreq_idx
  on aftersales.ticket_attachment(org, client_request_id);
