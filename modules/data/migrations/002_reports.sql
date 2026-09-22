-- 002_reports.sql — Metabase 报表登记（modules/data，T7）。
--
-- 纪律（与 001_init.sql 同源，别按口味改）：
--   · 幂等：全部 if not exists——部署脚本会每次全量重跑全部迁移（团队规则 db-migration §1）
--   · 外部系统来的字段（报表标题 = Metabase dashboard 的 name）一律 text，不用 varchar（§2）
--   · 隔离键一律 **org text not null**，值 = identity.orgId（= 本模块 DataTenant.casdoor_org），
--     读写一律 where org = $1——正典 docs/module-protocol.md「租户数据隔离」；
--     机器判据 scripts/check-tenant-isolation.mjs（ci.yml 的 gates job）
--   · 唯一约束含 org（正典三条纪律之二）：`(org, title)` 约束**必须**带 org，否则跨租户撞名
--
-- 本表为什么存在（spec §4 / §7）：报表本体在 Metabase、登记在平台 ⇒ 这是**双写面**的一侧。
-- Metabase 侧被手工删改时平台侧不知情 ⇒ 必须有对账（POST /reports/reconcile 双向差集）。

create schema if not exists data;

create table if not exists data.reports (
  org            text        not null,                  -- 租户隔离键，= identity.orgId
  id             text        not null,                  -- 平台侧稳定句柄（uuid；嵌入 URL 里用它，不用标题）
  title          text        not null,                  -- = Metabase dashboard 的 name（外部系统字段 ⇒ text）
  metabase_id    integer     not null,                  -- Metabase dashboard id（真机该列是 int4 序列）
  embed_params   jsonb       not null default '{}'::jsonb,
                                                        -- 本报表**除 tenant 外**要锁的参数 → 值。
                                                        -- ⚠️ 平台保留名 tenant 不在这里：它的值恒为调用者 org，
                                                        -- 只在嵌入 JWT 里现签（防跨租户，见 routes/reports.ts）
  required_scope text,                                  -- NULL = 所有拿到本模块的人可见（口径同 data.metrics）
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (org, id)
);

-- 幂等键 = (org, title)：POST /reports 同 title 重跑必须**不新增行**。
-- 做成唯一索引（而不是「先查后插」）是为了在**并发**下也成立——先查后插的窗口里两个请求
-- 会各插一行，症状是 console 出现两条同名报表、且其中一条永远对不到 dashboard。
create unique index if not exists data_reports_org_title_key
  on data.reports(org, title);

-- 对账时按 metabase_id 求差集（登记侧 ∩ 可嵌入集）
create index if not exists data_reports_org_metabase_idx
  on data.reports(org, metabase_id);

-- ── 为什么不给 id 写 default ────────────────────────────────────────────────────
-- id 由应用层 randomUUID() 生成，DDL 不引 gen_random_uuid()：后者在 PG<13 要 pgcrypto 扩展，
-- 而 CI 的 postgres 镜像版本不归本模块管——「迁移能不能在目标库跑起来」不该取决于扩展可用性。
-- 冲突时（同 org 同 title）`on conflict … do update` 不写 id 列 ⇒ 老 id 保留、登记行稳定。
