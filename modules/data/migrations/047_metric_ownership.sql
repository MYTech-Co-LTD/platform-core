-- 047_metric_ownership.sql —— 指标概念与部门归属（spec §5.1/§5.3，Wave 5 P1）。
-- 归属列 P1 落地、P2 执法（canViewMetric）；唯一索引 P1 即生效（写入侧拒收，见 metric-ownership.ts）。
alter table data.metrics
  add column if not exists owner_dept    text,
  add column if not exists visible_depts text[],
  add column if not exists variant_note  text,
  add column if not exists reveal        text;

alter table data.metrics drop constraint if exists metrics_reveal_check;
alter table data.metrics add constraint metrics_reveal_check
  check (reveal is null or reveal in ('panel','report'));

-- 部门内同名互斥（spec §5.1）。生产已取证零冲突，可直接建；
-- coalesce 把「平台通用」（owner_dept 为空）也纳入互斥（平台桶内同名同样拒绝）。
create unique index if not exists metrics_title_per_dept_uq
  on data.metrics (org, coalesce(owner_dept, ''), lower(title));

-- 回填（§5.4）：L2 的 entity 只在能解出基底时继承——不按 description 文本猜。
-- 现网唯一 L2（shanhaiyiguo-org）无 declaration.baseMetric 可解 ⇒ 留空，符合规则。

-- 租户概念表（spec §5.3）：L1 概念在 dbt/semantics/l1_metrics.yml 顶层 entities（031 物化），
-- 本表只放**租户新增**概念；平台概念只读（写侧校验见 metric-ownership.ts）。
create table if not exists data.metric_concept (
  org        text not null,
  name       text not null,
  label      text not null,
  synonyms   jsonb not null default '[]'::jsonb,
  owner_dept text,
  created_by text not null,
  created_at timestamptz not null default now(),
  primary key (org, name)
);

-- 试算快照历史（P1 Task 5，销缓办①）：applyPreview 重跑时把被顶掉的旧 preview unshift 进来
-- （最新在前），FIFO 封顶 5 条（表达式内 limit，见 metric-change-preview.ts）；读侧
-- （MetricChangeRow.previewHistory）把 null 归一为 []。列放 047 而非新迁移：047 尚未部署。
alter table data.metric_change
  add column if not exists preview_history jsonb;

-- 刻意**不建** metric_change (org, id) 索引：id 已是 pkey（唯一且自带索引），
-- org 前缀扫描由 046 的 metric_change_queue_idx (org, status, …) 承担——纯冗余，不落。
-- preview_history 同理不建索引：随行整读、从不按它过滤，jsonb 数组上建 GIN 纯属写放大。
