-- 001_notify.sql — 通知规则层（notify 模块，issue #889；正典 docs/architecture.md §2.6，ADR 0005 §18）。
-- 绑定层：`什么事件 × 通知谁 × 用哪个模板 × 什么通道`。投递/模板留 Novu、解析留 case-engine，本层只存绑定。
-- 纪律：幂等迁移（create ... if not exists / DML on conflict，重复执行不报错）。
-- 租户隔离：两表 org-scoped（org text not null 首列，主键/索引以 org 起头）——过
--   scripts/check-tenant-isolation.mjs 真库对账（表有 org 列 + NOT NULL 两条判据）。

create schema if not exists notify;

-- ── 1) rule 规则登记表：全声明式，规则行只引用 Novu workflow identifier（模板不进本层，§2.6 取舍③） ──
create table if not exists notify.rule (
  org              text        not null,
  id               text        not null,
  enabled          boolean     not null default true,
  event_type       text        not null,                    -- case.awaiting_approval / form.due_reminder / …
  mount            text        not null,                    -- case_type_id | form_def_id | '*'（全量兜底）
  template_id      text        not null,                    -- Novu workflow identifier（只引用不内嵌文案）
  recipient        text        not null check (recipient in ('assignee', 'submitter', 'user_list', 'field')),
  recipient_arg    text,                                    -- user_list / field 的参数
  channels         text[]      not null default '{wechat_work,in_app}',  -- v1 仅此两通道
  cooldown_minutes int,                                     -- 可选节流（防 SLA 类刷屏）
  origin           text        not null check (origin in ('derived', 'manual')),
  created_by       text        not null,
  created_at       timestamptz not null default now(),
  primary key (org, id)
);

-- 匹配热路径：按 (org, event_type, mount) 取 enabled 规则（manual > derived 在应用层排，见 domain/rules.ts）
create index if not exists idx_notify_rule_match
  on notify.rule (org, event_type, mount)
  where enabled;

-- ── 2) delivery 投递回执表：审计面 + 幂等去重（emit 带确定性 event_id，业务转移一次一枚） ──
create table if not exists notify.delivery (
  org        text        not null,
  rule_id    text        not null,
  event_id   text        not null,
  event_type text        not null,
  recipient  text        not null,
  template   text        not null,
  status     text        not null check (status in ('sent', 'failed')),
  error      text,                                          -- 失败摘要（fail-open：记此列不抛）
  created_at timestamptz not null default now(),
  -- 幂等去重：同 (org, event_id, rule_id) 重试/调度重叠天然去重，不双发（§2.6 取舍④配套）
  primary key (org, event_id, rule_id)
);

create index if not exists idx_notify_delivery_list
  on notify.delivery (org, created_at desc);
