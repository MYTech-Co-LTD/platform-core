-- 001_kernel.sql — forms 受管数据集内核（issue #710，M1.2）。
-- 形状 = explore/poc/lifecycle-unified/lifecycle.sql（28/28 人审 PoC）的多租户工程化：
--   两处必改——资产/提交表全部带 org（租户隔离门禁 T1/T2）；submission 加 submitted_by（审计记人，L2 范式）。
-- 字典按正典「同名不同表」（architecture §2.4 拍板）独立建表：租户私有 dict_item + 平台全局 dict_global_item（P4 分档）。
-- 纪律：幂等迁移（drop ... if exists / create ... if not exists / DML on conflict，重复执行不报错）。
-- 关键设计：published 不可变由 DB 触发器强制（不是应用层自觉）——「AI 对 draft 有全权」意味着
-- 任何写入口都可能在 draft 上，唯一的门必须是存储层的（ADR-0005 §14.1）。

create schema if not exists forms;

-- ── 1) kind 策略注册表：治理差异收敛为策略行，不是 N 套实现（PoC 核心结论 #1） ──
-- global-table: 声明资产策略注册表——发布门禁策略是平台级配置，全租户共用，无租户归属（P4 分档配套，global-table 机制首个真实用例）
create table if not exists forms.kind (
  kind           text primary key,
  publish_policy text not null check (publish_policy in ('human_gate', 'auto')),
  note           text
);

insert into forms.kind (kind, publish_policy, note)
values ('form_def', 'human_gate', '表单定义：发布是人的唯一 gate（ADR-0005 §14.1；平台落地为 forms:publish scope 分离）')
on conflict (kind) do update set publish_policy = excluded.publish_policy, note = excluded.note;

-- ── 2) 资产版本行：一经 published，body/版本号/署名全部冻结 ──
create table if not exists forms.asset_version (
  org          text not null,
  kind         text not null references forms.kind(kind),
  asset_id     text not null,
  version      int  not null,
  body         jsonb not null,
  status       text not null check (status in ('draft', 'published', 'retired')),
  created_by   text not null,
  published_by text,
  created_at   timestamptz not null default now(),
  published_at timestamptz,
  retired_at   timestamptz,
  primary key (org, kind, asset_id, version)
);
-- 热路径索引以 org 为前缀列（租户数据三条纪律之三）
create index if not exists idx_forms_asset_version_list
  on forms.asset_version (org, kind, asset_id, version desc);

-- ── 3) 活跃指针：回滚 = 改这一行，不动任何版本数据 ──
create table if not exists forms.asset_head (
  org            text not null,
  kind           text not null,
  asset_id       text not null,
  active_version int  not null,
  primary key (org, kind, asset_id)
);

-- ── 4) 提交：钉死提交时的版本（历史按当时版本渲染与校验，§14.1）；审计记人 ──
create table if not exists forms.submission (
  id           bigserial primary key,
  org          text not null,
  kind         text not null,
  asset_id     text not null,
  version      int  not null,
  payload      jsonb not null,
  submitted_by text not null,
  submitted_at timestamptz not null default now()
);
create index if not exists idx_forms_submission_list
  on forms.submission (org, kind, asset_id, submitted_at desc);

-- ── 5) 不可变触发器：published 行只允许经内部通路（retire 函数）转 retired，
--       body/版本号/署名/时间戳任何改写一律拒绝（应用直改 SQL 也拦得住） ──
create or replace function forms.forbid_published_mutation() returns trigger as $$
begin
  if new.org is distinct from old.org or new.kind is distinct from old.kind
     or new.asset_id is distinct from old.asset_id then
    raise exception 'identity columns are immutable';
  end if;
  if old.status = 'published' then
    if coalesce(current_setting('lifecycle.internal', true), '') <> 'on' then
      raise exception 'published version v% of %/% is immutable (mutate via new draft)',
        old.version, old.kind, old.asset_id;
    end if;
    -- 内部通路也只许 published → retired 这一个转移，body 等仍然冻结
    if new.status <> 'retired'
       or new.body is distinct from old.body
       or new.version is distinct from old.version
       or new.created_by is distinct from old.created_by
       or new.published_by is distinct from old.published_by
       or new.published_at is distinct from old.published_at then
      raise exception 'internal transition allows only published->retired';
    end if;
  end if;
  return new;
end; $$ language plpgsql;

drop trigger if exists trg_forms_published_immutable on forms.asset_version;
create trigger trg_forms_published_immutable
  before update on forms.asset_version
  for each row execute function forms.forbid_published_mutation();

-- ── 6) 非法删除：draft 随便删（AI 全权）；published/retired 行不许物理删 ──
create or replace function forms.forbid_published_delete() returns trigger as $$
begin
  if old.status <> 'draft' then
    raise exception '% version v% of %/% is not deletable (soft-delete via retire)',
      old.status, old.version, old.kind, old.asset_id;
  end if;
  return old;
end; $$ language plpgsql;

drop trigger if exists trg_forms_no_hard_delete on forms.asset_version;
create trigger trg_forms_no_hard_delete
  before delete on forms.asset_version
  for each row execute function forms.forbid_published_delete();

-- ── 7) 提交只能钉 head 版本（新提交跟随活跃指针；显式钉非 head 一律拒绝） ──
create or replace function forms.submission_must_follow_head() returns trigger as $$
declare h int;
begin
  select active_version into h from forms.asset_head
    where org = new.org and kind = new.kind and asset_id = new.asset_id;
  if h is null then
    raise exception 'no published head for %/% — submit only after publish', new.kind, new.asset_id;
  end if;
  if new.version <> h then
    raise exception 'submission pinned to v% but head is v% — submissions follow head only', new.version, h;
  end if;
  return new;
end; $$ language plpgsql;

drop trigger if exists trg_forms_submission_follows_head on forms.submission;
create trigger trg_forms_submission_follows_head
  before insert on forms.submission
  for each row execute function forms.submission_must_follow_head();

-- ============ 生命周期操作（org 维度全部入参；差异只在 kind 行的策略） ============

-- 建 draft：版本号自动递增；同号 draft 已存在即报错（改用 update_draft，不静默覆盖）
create or replace function forms.new_draft(p_org text, p_kind text, p_asset text, p_body jsonb, p_actor text)
returns int as $$
declare v int; cur int;
begin
  select max(version) into cur from forms.asset_version
    where org = p_org and kind = p_kind and asset_id = p_asset;
  v := coalesce(cur, 0) + 1;
  insert into forms.asset_version (org, kind, asset_id, version, body, status, created_by)
    values (p_org, p_kind, p_asset, v, p_body, 'draft', p_actor);
  return v;
end; $$ language plpgsql;

-- 改 draft（仅 draft 可改；published/retired 由触发器拦）
create or replace function forms.update_draft(p_org text, p_kind text, p_asset text, p_version int, p_body jsonb)
returns void as $$
begin
  update forms.asset_version set body = p_body
    where org = p_org and kind = p_kind and asset_id = p_asset and version = p_version;
  if not found then raise exception 'draft v% of %/% not found', p_version, p_kind, p_asset; end if;
end; $$ language plpgsql;

-- 删 draft（仅 draft 可删；触发器拦其余）
create or replace function forms.drop_draft(p_org text, p_kind text, p_asset text, p_version int)
returns void as $$
begin
  delete from forms.asset_version
    where org = p_org and kind = p_kind and asset_id = p_asset and version = p_version;
  if not found then raise exception 'draft v% of %/% not found', p_version, p_kind, p_asset; end if;
end; $$ language plpgsql;

-- 发布：人门 kinds 要求 actor_role='human'（平台侧对应 forms:publish scope + 会话身份；
-- agent_role 语义留给 AI 工具面——届时持 manage 不持 publish，撞这条策略即拒）。
-- 发布即把 head 指到新版本（发布 = 上线；回退是显式 rollback，不是发布的一部分）。
create or replace function forms.publish(p_org text, p_kind text, p_asset text, p_version int, p_actor text, p_actor_role text)
returns void as $$
declare pol text; st text;
begin
  select publish_policy into pol from forms.kind where kind = p_kind;
  if pol is null then raise exception 'unknown kind %', p_kind; end if;
  if pol = 'human_gate' and p_actor_role <> 'human' then
    raise exception 'publish of %/% requires human gate (policy=human_gate), actor_role=%',
      p_kind, p_asset, p_actor_role;
  end if;
  select status into st from forms.asset_version
    where org = p_org and kind = p_kind and asset_id = p_asset and version = p_version;
  if st is null then raise exception 'version v% of %/% not found', p_version, p_kind, p_asset; end if;
  if st <> 'draft' then raise exception 'only draft can publish (v% is %)', p_version, st; end if;
  update forms.asset_version
    set status = 'published', published_by = p_actor, published_at = now()
    where org = p_org and kind = p_kind and asset_id = p_asset and version = p_version;
  insert into forms.asset_head (org, kind, asset_id, active_version)
    values (p_org, p_kind, p_asset, p_version)
    on conflict (org, kind, asset_id) do update set active_version = excluded.active_version;
end; $$ language plpgsql;

-- 回滚：只动 head 指针；目标必须是 published（retired/draft 不可回）
create or replace function forms.rollback_to(p_org text, p_kind text, p_asset text, p_version int)
returns void as $$
declare st text;
begin
  select status into st from forms.asset_version
    where org = p_org and kind = p_kind and asset_id = p_asset and version = p_version;
  if st is null then raise exception 'rollback target v% of %/% not found', p_version, p_kind, p_asset; end if;
  if st <> 'published' then
    raise exception 'rollback target v% is % (only published is rollback-able)', p_version, st;
  end if;
  update forms.asset_head set active_version = p_version
    where org = p_org and kind = p_kind and asset_id = p_asset;
  if not found then raise exception 'no head for %/%', p_kind, p_asset; end if;
end; $$ language plpgsql;

-- 退役：软删；head 版本不许退（先切走再退）。
-- set_config('lifecycle.internal') 会话旗标是唯一合法 published→retired 通路——
-- 它出现在业务代码里应视为告警（PoC RESULTS §5 排障口径）。
create or replace function forms.retire(p_org text, p_kind text, p_asset text, p_version int)
returns void as $$
declare st text; h int;
begin
  select active_version into h from forms.asset_head
    where org = p_org and kind = p_kind and asset_id = p_asset;
  if h = p_version then
    raise exception 'cannot retire head v% of %/% — switch head first', p_version, p_kind, p_asset;
  end if;
  select status into st from forms.asset_version
    where org = p_org and kind = p_kind and asset_id = p_asset and version = p_version;
  if st is null then raise exception 'version v% of %/% not found', p_version, p_kind, p_asset; end if;
  if st <> 'published' then raise exception 'only published can retire (v% is %)', p_version, st; end if;
  perform set_config('lifecycle.internal', 'on', true);
  update forms.asset_version set status = 'retired', retired_at = now()
    where org = p_org and kind = p_kind and asset_id = p_asset and version = p_version;
  perform set_config('lifecycle.internal', '', true);
end; $$ language plpgsql;

-- 提交：钉 head 当前版本（payload 契约校验在应用层 domain/contract.ts——按钉住版本取 body）
create or replace function forms.submit(p_org text, p_kind text, p_asset text, p_payload jsonb, p_submitted_by text)
returns bigint as $$
declare h int; sid bigint;
begin
  select active_version into h from forms.asset_head
    where org = p_org and kind = p_kind and asset_id = p_asset;
  insert into forms.submission (org, kind, asset_id, version, payload, submitted_by)
    values (p_org, p_kind, p_asset, h, p_payload, p_submitted_by)
    returning id into sid;
  return sid;
end; $$ language plpgsql;

-- 渲染/校验一律按「提交钉住的版本」取 body，与该版本当前状态无关（retired 仍可渲染历史）
create or replace function forms.body_at(p_org text, p_kind text, p_asset text, p_version int)
returns jsonb as $$
  select body from forms.asset_version
    where org = p_org and kind = p_kind and asset_id = p_asset and version = p_version;
$$ language sql;

-- ============ 字典形态（同名不同表：租户私有 dict_item / 平台全局 dict_global_item，P4 分档） ============
-- 纪律（architecture §2.4）：软删（enabled=false + retired_at）、key 不可变（只可软删 + 新增）。

-- key 不可变触发器（两表共用：改 key 会让历史提交指向不存在的 key ⇒ 渲染空白且不报错）
create or replace function forms.forbid_dict_key_change() returns trigger as $$
begin
  if new.key is distinct from old.key then
    raise exception 'dict key is immutable (soft-delete + add new instead): % -> %', old.key, new.key;
  end if;
  return new;
end; $$ language plpgsql;

create table if not exists forms.dict_item (
  org        text not null,
  dict_id    text not null,
  key        text not null,
  label      text not null,
  sort_no    int  not null default 0,
  enabled    boolean not null default true,
  retired_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org, dict_id, key)
);

-- global-table: 平台全局字典（P4 分档）：标准码类值集全租户共用，无租户归属；编辑权=forms:global-manage（平台超管）
create table if not exists forms.dict_global_item (
  dict_id    text not null,
  key        text not null,
  label      text not null,
  sort_no    int  not null default 0,
  enabled    boolean not null default true,
  retired_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (dict_id, key)
);

drop trigger if exists trg_forms_dict_key_immutable on forms.dict_item;
create trigger trg_forms_dict_key_immutable
  before update on forms.dict_item
  for each row execute function forms.forbid_dict_key_change();

drop trigger if exists trg_forms_dict_global_key_immutable on forms.dict_global_item;
create trigger trg_forms_dict_global_key_immutable
  before update on forms.dict_global_item
  for each row execute function forms.forbid_dict_key_change();
