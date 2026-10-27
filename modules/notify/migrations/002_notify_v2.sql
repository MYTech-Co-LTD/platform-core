-- 002_notify_v2.sql — 通知基础设施 v2（expand 阶段：旧 rule/delivery 保留，新表用 _v2）
-- 正典：docs/superpowers/specs/2026-10-27-notification-infrastructure-design.md §4/§5/§7/§8
-- 幂等：create ... if not exists；重复执行不报错。
-- ⚠️ Task 15（contract）才 drop 旧表并 rename _v2；在那之前旧代码/旧测试保持可跑。
create schema if not exists notify;

-- ── 规则：五元组（事件 × 作用域 × 收件人 × 模板 × 通道）+ 可选节流 ──
-- 暂时 _v2：旧 notify.rule 仍被旧管道使用；Task 15 rename。
create table if not exists notify.rule_v2 (
  org                  text not null,
  id                   text not null,
  enabled              boolean not null default true,
  event_key            text not null,
  scope                text not null default '*',
  recipient_key        text not null,
  recipient_literal    text[],
  template_key         text not null,
  channels             text[] not null default '{}',
  cooldown_minutes     int,
  origin               text not null check (origin in ('derived','manual')),
  created_by           text not null,
  created_at           timestamptz not null default now(),
  primary key (org, id)
);
create index if not exists idx_notify_rule_v2_match
  on notify.rule_v2(org, event_key, scope) where enabled;

-- ── 模板：租户级 + 不可变 revision（发布指针指向 revision） ──
create table if not exists notify.template (
  org                 text not null,
  key                 text not null,
  name                text not null,
  event_key           text not null,
  status              text not null default 'draft' check (status in ('draft','published','archived')),
  origin              text not null check (origin in ('builtin','tenant')),
  published_revision  int,
  created_by          text not null,
  updated_at          timestamptz not null default now(),
  primary key (org, key)
);

create table if not exists notify.template_revision (
  org            text not null,
  key            text not null,
  revision       int not null,
  contents       jsonb not null,
  body_hash      text not null,
  review_status  text not null default 'draft' check (review_status in ('draft','approved','rejected')),
  created_by     text not null,
  created_at     timestamptz not null default now(),
  approved_by    text,
  approved_at    timestamptz,
  primary key (org, key, revision)
);
create unique index if not exists uq_notify_template_revision_hash
  on notify.template_revision(org, key, body_hash);

-- ── 通道实例：DB 只存非敏感 config + env 键名（secret_refs） ──
create table if not exists notify.channel (
  org          text not null,
  id           text not null,
  provider     text not null check (provider in ('wecom_chat','in_app','webhook')),
  enabled      boolean not null default true,
  config       jsonb not null default '{}'::jsonb,
  secret_refs  jsonb not null default '{}'::jsonb,
  health       text,
  health_at    timestamptz,
  created_by   text not null,
  updated_at   timestamptz not null default now(),
  primary key (org, id)
);

-- ── 入队（outbox 的第一段）：确定性 event_id 幂等 ──
create table if not exists notify.event (
  org          text not null,
  event_id     text not null,
  event_key    text not null,
  scope        text not null default '*',
  payload      jsonb not null,
  producer     text not null,
  status       text not null default 'new' check (status in ('new','matched','no_rules','invalid')),
  locked_until timestamptz,
  processed_at timestamptz,
  created_at   timestamptz not null default now(),
  primary key (org, event_id)
);
create index if not exists idx_notify_event_new
  on notify.event(org, created_at) where status = 'new';

-- ── 待发/已发：联合唯一含 recipient + channel（修复旧版多收件人被主键吞掉） ──
-- 暂时 _v2：旧 notify.delivery 仍被旧管道使用；Task 15 rename。
create table if not exists notify.delivery_v2 (
  org             text not null,
  event_id        text not null,
  rule_id         text not null,
  recipient       text not null,
  channel         text not null,
  address         text not null,
  template_key    text not null,
  revision        int not null,
  rendered        jsonb not null,
  status          text not null default 'pending'
                  check (status in ('pending','sent','failed','dead','suppressed')),
  attempts        int not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_until    timestamptz,
  last_error      text,
  is_test         boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (org, event_id, rule_id, recipient, channel)
);
create index if not exists idx_notify_delivery_v2_due
  on notify.delivery_v2(next_attempt_at) where status in ('pending','failed');

-- ── 每次尝试一行：审计/排障（不存渲染正文） ──
create table if not exists notify.delivery_attempt (
  id            bigserial primary key,
  org           text not null,
  -- delivery_key = '<event_id>|<rule_id>|<recipient>|<channel>'（与 delivery 联合主键同构）
  delivery_key  text not null,
  attempt_no    int not null,
  provider      text not null,
  status        text not null,
  http_status   int,
  error_code    text,
  error_summary text,
  duration_ms   int,
  created_at    timestamptz not null default now()
);
create index if not exists idx_notify_attempt_delivery
  on notify.delivery_attempt(org, delivery_key, attempt_no);

-- ── in-app 收件箱：待办权威源的副本；已读 ≠ 已办 ──
create table if not exists notify.inbox (
  org          text not null,
  id           text not null,
  recipient    text not null,
  event_id     text not null,
  event_key    text not null,
  template_key text not null,
  revision     int not null,
  title        text not null,
  body         text not null,
  link         text,
  read_at      timestamptz,
  created_at   timestamptz not null default now(),
  primary key (org, id),
  unique (org, event_id, recipient)
);

-- ── worker 心跳：健康 job 用它判断「worker 还在跑」 ──
create table if not exists notify.worker_heartbeat (
  id       text primary key,
  beat_at  timestamptz not null default now()
);
