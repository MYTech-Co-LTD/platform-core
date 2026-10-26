-- 023_report_narratives.sql — 报表 AI 文本（`ai_text` 组件）的内容寻址缓存 + 审计表。
--
-- 纪律（与 001/022 同源，别按口味改）：
--   · 幂等：DDL 全 if not exists——部署脚本会每次全量重跑全部迁移（团队规则 db-migration §1）
--   · 隔离键一律 **org text not null**，唯一约束含 org（正典 docs/module-protocol.md「租户数据隔离」；
--     机器判据 scripts/check-tenant-isolation.mjs）
--   · 外部/用户输入字段一律 text（id / 报表 id / 正文 / 生成人），不用 varchar（团队规则 §2）
--
-- ── 这张表解决什么 ──────────────────────────────────────────────────────────
-- 同一 (org, 报表, spec 快照, 面板, focus, 期间, 门店, factsHash, 提示词版本, 模型)
-- 只生成一次：命中即不调模型（缓存）；每一行同时是「谁在什么事实包上生成了什么文本」的审计。
-- factsHash 进唯一键 ⇒ 数据一变（事实包内容变）就自然失效，不需要失效逻辑。
-- 唯一键也是并发下的去重闸：同一 key 并发生成必有一个撞唯一键，写侧 on conflict do nothing。
-- 表名/列名与 domain/report-narrative-store.ts 的读写语句一一对应，改任一侧都要同步另一侧。

create table if not exists data.report_narratives (
  id             text        not null primary key,
  org            text        not null,
  report_id      text        not null,
  spec_key       text        not null,
  panel_index    integer     not null,
  focus          text        not null,
  period_key     text        not null,
  branch_key     text        not null,
  facts_hash     text        not null,
  prompt_version text        not null,
  model          text        not null,
  text           text        not null,
  fallback       boolean     not null default false,
  created_at     timestamptz not null default now(),
  created_by     text        not null,
  unique (org, report_id, spec_key, panel_index, focus, period_key, branch_key, facts_hash, prompt_version, model)
);
create index if not exists report_narratives_org_report_idx
  on data.report_narratives(org, report_id, spec_key, created_at);
