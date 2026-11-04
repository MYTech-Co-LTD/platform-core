-- 034_private_measure_and_candidates.sql — W2 三档闭环的存储地基
-- 计划：docs/superpowers/plans/2026-11-04-amd-w2-three-tier.md Task 1
--
-- 三件事：
--   ① data.metrics.basis：测度口径基（l1_tree = 树形 L1/L2；column_agg = 私有测度=单列聚合）。
--      恒有值（not null default 'l1_tree'）——「没有这个字段」不是合法态，存量行按树形档。
--   ② data.metrics.archived_at：归档时刻（NULL = 在用）。归档是**隐藏**不是删除：
--      查询面默认滤掉，行与审计都留着（30 天热度淘汰，Task 3）。
--   ③ data.metric_candidates：候选池（profiler / 需求挖掘的产出 + 人工决策状态）。
--
-- 幂等：本目录的迁移由部署脚本**每次全量重跑**（runMigrations 记账 + 裸跑两遍都要过）。
-- 故一律 add column if not exists / create table if not exists / create index if not exists；
-- 约束先 drop if exists 再 add（PG 没有 add constraint if not exists）。
alter table data.metrics
  add column if not exists basis       text not null default 'l1_tree',
  add column if not exists archived_at timestamptz;

-- 取值域：写坏一个档名（如 'columnagg'）必须响亮失败，而不是落一个读侧看不懂的值
-- （读侧 toMetricRow 对坏值归一成 l1_tree，那是兜底不是正确性）。
alter table data.metrics drop constraint if exists metrics_basis_check;
alter table data.metrics add constraint metrics_basis_check check (basis in ('l1_tree','column_agg'));

-- 候选池。
--   expr      = 候选的测度表达式 {agg, column, dims}；**规范形**由 jsonb 保证（键序/空白归一），
--               幂等键对 expr::text 取 md5，故「同一候选换个键序」仍是同一行。
--   evidence  = profiler/挖掘的证据（非空率、基数等），形状由生成方定，库只保证是 jsonb。
--   origin    = 候选从哪来：profile（duckle profiler）/ demand（需求挖掘）。
--   status    = 人工/流程决策状态；rejected/promoted 是终态，重新 profiling 不得复活（写侧纪律）。
--   updated_at= 最近一次证据刷新；created_at 是候选首次出现的锚（upsert 不动它）。
create table if not exists data.metric_candidates (
  id          bigserial primary key,
  org         text not null,
  relation    text not null,
  expr        jsonb not null,            -- {agg, column, dims}
  evidence    jsonb not null default '{}'::jsonb,
  rationale   text not null default '',
  confidence  numeric not null default 0,
  origin      text not null,             -- profile | demand
  status      text not null default 'pending',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (origin in ('profile','demand')),
  check (status in ('pending','created','promoted','rejected','expired'))
);

-- 幂等键：同租户 + 同关系 + 同表达式（规范形）= 同一条候选。
-- 表达式索引用 md5(expr::text)：jsonb 的 text 形是规范的（键序固定），可直接做唯一键；
-- 不用 expr 列本身是因为 jsonb 的默认 btree opclass 也不支持任意形状比较（且这里只要等价判定）。
create unique index if not exists metric_candidates_org_rel_expr_idx
  on data.metric_candidates (org, relation, md5(expr::text));
