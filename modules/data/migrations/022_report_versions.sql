-- 022_report_versions.sql — 报表**定义版本**不可变快照 + 当前发布指针（月报重做 Task 8）。
--
-- 纪律（与 002/004/005/007 同源，别按口味改）：
--   · 幂等：DDL 全 if not exists；回填 on conflict do nothing；指针回填只补 null
--     ——部署脚本会每次全量重跑全部迁移（团队规则 db-migration §1）
--   · 隔离键一律 **org text not null**，唯一约束含 org（正典 docs/module-protocol.md「租户数据隔离」；
--     机器判据 scripts/check-tenant-isolation.mjs）
--   · 外部/用户输入字段一律 text（标题、备注、发布人），不用 varchar（团队规则 §2）
--
-- ── 这张表解决什么（计划「版本 = 定义版本」）───────────────────────────────────
-- 发布/回滚/历史不能靠 data.reports.spec 单列：草稿一改，线上定义就被覆盖，回滚无从谈起。
-- 故每次发布往本表**追加**一行不可变快照（spec/title/页门）；
-- data.reports.published_version_id 只做「当前发布的是哪一行」的指针。
--   · `?v=N` 用旧**定义**查**当前**湖数据 —— 不是数据快照（计划 Global Constraints）。
--   · 下线 = 指针置 null；回滚 = 把旧行内容再发布成新版本（服务层行为，不在 DDL）。
--
-- ── 为什么主键是 id 而唯一键是 (org, report_id, version) ──────────────────────
-- id 由应用层生成（与 data.reports.id 同形态）；租户内「第几个版本」由唯一键钉死，
-- 并发发布两个 v2 必有一个撞唯一键 → 服务层以 CONFLICT/重试处理，不会静默出两个 v2。
--
-- ── 为什么 draft_version 也跟着快照 ──────────────────────────────────────────
-- 版本 5 发布的是「草稿第 7 次登记时的内容」；只存 spec 无法判断「草稿又改过没有」。
-- 存下发布时刻的 data.reports.version 才能做「无改动再发布 → unchanged」（Task 9）。

create table if not exists data.report_versions (
  id             text        not null primary key,
  org            text        not null,                  -- 租户隔离键，= identity.orgId
  report_id      text        not null,                  -- 指向 data.reports.id（租户内句柄）
  version        integer     not null,                  -- 租户内单调版本号，从 1 起
  title          text        not null,                  -- 发布时的标题快照（外部/用户输入 ⇒ text）
  spec           jsonb       not null,                  -- 发布时的声明式规格快照（parseReportSpec 的产物）
  required_scope text,                                  -- 发布时的页门快照；NULL = 拿到模块即可见
  draft_version  integer     not null,                  -- 发布时 data.reports.version 的值（判断草稿是否又改过）
  published_at   timestamptz not null default now(),
  published_by   text        not null,                  -- 发布人（用户 id；系统回填为 'migration'）
  note           text        not null default '',        -- 发布备注（用户输入 ⇒ text）
  unique (org, report_id, version),
  -- 租户内级联：报表删了，它的版本历史一并消失；跨租户不可能命中（org 两边都带）
  foreign key (org, report_id) references data.reports(org, id) on delete cascade
);

-- 历史列表 / 取某版本：走 (org, report_id, version) 唯一键即可；版本倒序列表走它前缀
create index if not exists data_report_versions_org_report_idx
  on data.report_versions(org, report_id, version desc);

-- 当前发布指针（NULL = 未发布 / 已下线）。
-- 不建 FK 到 report_versions(id)：指针与版本行同事务写入，FK 只增加「先删版本行必须清指针」
-- 的操作顺序负担；而「指向不存在的版本」由服务层读路径兜底为 404（跨租户同样 404）。
alter table data.reports add column if not exists published_version_id text;

-- ── 回填：存量「已发布」的平台自绘报表 → v1 ────────────────────────────────────
-- 「已发布」的存量口径（与旧管理面一致）：renderer='platform'、有 spec、页门 required_scope
-- 为 null。Metabase 报表与有页门的平台报表**不回填**——它们没有可声明的 spec 快照，
-- 硬造 v1 等于给未发布内容盖章（计划约束「能提不能发」）。
-- id 用 md5(org:report:1) 而非随机值：重跑得到同一 id ⇒ on conflict 稳定 no-op。
insert into data.report_versions
  (id, org, report_id, version, title, spec, required_scope, draft_version, published_at, published_by, note)
select
  md5(r.org || ':' || r.id || ':1'),
  r.org, r.id, 1, r.title, r.spec, r.required_scope, r.version, r.updated_at, 'migration', ''
from data.reports r
where r.renderer = 'platform' and r.spec is not null and r.required_scope is null
on conflict (org, report_id, version) do nothing;

-- 指针回填只补 null：已经发布过新版本的报表（指针非空）绝不回退到 v1。
update data.reports r
set published_version_id = v.id
from data.report_versions v
where v.org = r.org and v.report_id = r.id and v.version = 1
  and r.published_version_id is null
  and r.renderer = 'platform' and r.spec is not null and r.required_scope is null;
