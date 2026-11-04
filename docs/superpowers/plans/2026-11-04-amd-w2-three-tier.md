# W2 三档闭环（私有测度 + profiler + 候选） Implementation Plan

> **本计划对应路线图 §3 的 W2**：`docs/superpowers/plans/2026-11-04-auto-metric-derivation-roadmap.md`
> 开工前先读该文件 §1/§3/§5，并**用命令核实代码现状**（不信任台账文本）。
>
> 用户已拍板（2026-11-04）：三档落地（L2 即时 / 私有测度即时 / L1 走 PR）；私有测度**租户共享 + 归属标记 +
> 30 天热度淘汰**；与 D6 的边界 = **新建即时可用（标 draft），修改走 D6**。

**Goal:** 让 agent 能基于源数据（L1 已用 marts 的实际列）生成**私有测度**（单列聚合）并即时可用，同时用 duckle
原生 profiler 产出候选、经候选池与热度淘汰收敛到 L1。

**Architecture:** 私有测度 = `data.metrics` 的 L2 行 + `basis='column_agg'`；**写入期编译成与 L1 同形的
`select <agg>(<col>) as value[, dims] from <relation>`**，运行期零新路径（authorize/掩码/行域原样复用）。
profiler 走 **duckle 管线**（`src.postgres` → `qa.profile` → `snk.postgres`），按 org 逐租户跑。

**Tech Stack:** PostgreSQL 迁移 / TypeScript 域层 / duckle 管线（console 三处登记面）/ vitest。

## Global Constraints

- **B11 口径单一定义**：私有测度只做**列级单聚合**（sum/count/avg/min/max，可选 distinct），不做复合表达式、不做 join；复合走 L2。
- **白名单 fail-closed**：relation ∈ L1 已用 marts；column ∈ 该 marts **实际列**（运行时 `information_schema.columns`），非契约列。
- **零新运行期路径**：私有测度必须在写入期编译成 L1 同形 `select_sql`，并过 `parseL1Select`。
- **私有测度不可被 L2 ref 引用**（`resolveL1Base` 只认 L1；加显式断言）。
- **掩码**：复用列引用定点替换；维度列不得含被掩码列。
- **D6 边界**：新建写生效列 + `certified='draft'` 即时可用；修改一律走 `draft_spec`→确认→通知。
- **duckle 原生优先**：profiler 必须先过 `duckle-native-first` 判停门（已验：`qa.profile` 存在）。
- **跨租户**：profiler 按 org 逐租户跑（`ASK_VERIFY_*` 同理，不跨租户聚合 profile）。
- 迁移幂等；提交 `feat(data): ...`；关联新 issue。

---

### Task 1: 迁移 034 + 存储层（basis / archived_at / 候选表）

**Files:**
- Create: `modules/data/migrations/034_private_measure_and_candidates.sql`
- Modify: `modules/data/domain/metric-store.ts`（`MetricRow.basis`、`ROW_COLUMNS`、`toMetricRow`、L1/L2 upsert）
- Create: `modules/data/domain/metric-candidates.ts`
- Test: `modules/data/domain/metric-store.test.ts`、`modules/data/domain/metric-candidates.test.ts`

**Interfaces:**
- `MetricRow.basis: 'l1_tree' | 'column_agg'`（恒有值，L1 行 = 'l1_tree'）
- `MetricRow.archivedAt: string | null`
- `Candidate { id, org, relation, expr, dims, evidence, rationale, confidence, origin, status, createdAt }`
- `upsertCandidate` / `listCandidates` / `setCandidateStatus`

**迁移（幂等）**：
```sql
alter table data.metrics
  add column if not exists basis       text not null default 'l1_tree',
  add column if not exists archived_at timestamptz;
alter table data.metrics drop constraint if exists metrics_basis_check;
alter table data.metrics add constraint metrics_basis_check check (basis in ('l1_tree','column_agg'));

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
create unique index if not exists metric_candidates_org_rel_expr_idx
  on data.metric_candidates (org, relation, md5(expr::text));
```
- 查询面默认过滤 `archived_at is null`（`loadOrgCatalog`/`loadPlatformCatalog`/`loadMergedCatalog`；L1 不受影响——sync 恒 null）。
- `module.test.ts` 表清单同步。

---

### Task 2: 私有测度编译与三闸

**Files:**
- Modify: `modules/data/domain/semantic-compiler.ts`（导出 `compileColumnAgg`）
- Create: `modules/data/domain/private-measure.ts`（白名单 + 编译 + 校验）
- Test: `modules/data/domain/private-measure.test.ts`

**Interfaces:**
- `compileColumnAgg({ agg, column, dims, relation }): { selectSql, groupBy, subjectColumn: 'org' }`
- `validatePrivateMeasure(deps, input): Promise<{ok:true} | {ok:false, code}>`
- 白名单：`relation ∈ L1 已用 marts`（由 `loadPlatformCatalog` 的 select_sql 反解）+ `column ∈ information_schema.columns`。

**编译形状**（必须过 `parseL1Select`）：
```
select sum(<column>) as value[, <dims...>] from <relation>
```
- agg ∈ `sum|count|avg|min|max`（+ `count_distinct` 映射为 `count(distinct col)`）；column 必须是数值列（count 除外）。
- dims：低基数、已声明、非掩码列。
- 三闸：白名单、不可被 L2 ref（编译 L2 时断言 base 行的 basis='l1_tree'）、维度非掩码列。

---

### Task 3: 写入面（私有测度创建/淘汰）

**Files:**
- Modify: `modules/data/domain/metric-write.ts`（`writePrivateMeasure`）
- Modify: `modules/data/routes/verified-questions.ts`? **否**——新建 `routes/private-measures.ts` + manifest
- Test: `modules/data/domain/metric-write.test.ts`、`modules/data/routes/private-measures.test.ts`

**Interfaces:**
- `writePrivateMeasure(deps, org, input): MetricWriteOutcome`
- 路由：`POST /metrics/private`（scope `data:query`，与 D6 草稿端点同档；真判据在 handler：`data:manage` ∪ creator）
- 新建写生效列 + `certified='draft'` + `basis='column_agg'` + `created_by`；审计 action='create'。

**生命周期（同任务）**：
- `archiveStalePrivateMeasures(days=30)`：基于 `query_audit.metric_id` 聚合，无使用者置 `archived_at`（不删）。
- CLI `scripts/archive-private-measures.mjs`（供 job 调用）。

---

### Task 4: duckle profiler 管线

**Files:**
- Create: `deploy/duckle/console/pipelines/lemeng.metric_profile.<账套>.json`（域前缀是排班门禁硬要求）
- Modify: `deploy/duckle/console/schedules/*.json`、`deploy/duckle/console/owners.*.json`（三处登记面）
- Test: 无单测（管线格式只有真引擎可验）——**验收 = `duckle validate` + 实跑一次 + 回读 profile 表**

**管线形态**：
```
src.postgres(customSql: select * from <mart> where org = '${ORG}' limit ...)
  → qa.profile(columns: [])
  → snk.postgres(table: data.metric_profiles)
```
- **判停门**：先 `list_components`/`get_component_schema` 复核 `qa.profile` 输出行形状；不符则改 `qa.describe` + 自算。
- 按 org 逐租户：管线参数 `ORG` 由排班/运行注入（每租户一次运行，不跨租户聚合）。
- 落表 `data.metric_profiles(org, relation, column, stats jsonb, profiled_at)`，**落在仓库库（pg_duckdb）**，
  不是平台库（2026-11-04 实测：console 到平台 pg 172.18.0.5:5432 超时；`data.load_log` 同址先例）。
  ⇒ 建表 DDL 是**数据面引导步骤**（`deploy/duckle/console/metric_profiles.ddl.sql` + 投递清单），不走 `modules/data/migrations/`；
  Task 5 必须经 `DATA_WAREHOUSE_URL` 读取。
- 关系清单当前为静态 21 条（L1 已用 marts），**须有漂移检测**：`scripts/check-profile-relations.mjs`
  对照 `l1_metrics.yml` 的 relation 集，差集即告警（是否接入 CI 待定）。
- ORG 当前硬编码单租户（调度 params 被静默丢弃，实测）；**多租户前必须解决**，登记为已知边界。
- 明文 `connections/pgduck.json` 由 `PGDUCK_PASSWORD` 生成，**不进仓**；位置/来源/重建与轮换写进台账。

---

### Task 5: 候选生成 + 路由

**Files:**
- Create: `modules/data/domain/candidate-generator.ts`
- Modify: `modules/data/routes/private-measures.ts`（`POST /metrics/candidates/generate`、`POST /metrics/candidates/:id/adopt`）
- Test: 单测（规则筛/上限/去重）

**规则**：排除全空/基数=1/非数值且不可枚举/已被 L1 覆盖的列×聚合；每关系 ≤20；LLM 只起 label 与 rationale。
**路由**：能被 L1 ref 树表达 → L2；单列聚合 → 私有测度；高频 → 候选标 `promoted`（W3 出 PR）。

---

### Task 6: 收口

- 真机：一个真实问题 → bot 创建私有测度 → 同租户另一用户可查 → 时钟注入 30 天后 archived
- 双臂对照（W2 挪入）：有/无私有测度档的首答即中率（沿用 askdata-tuning 判据）
- 台账 W2 → 进行中/已完成

---

## Self-Review

- Spec 覆盖：私有测度档 ✅ / duckle profiler ✅ / 候选池 ✅ / 三闸 ✅ / 生命周期 ✅ / D6 边界 ✅
- 未覆盖（有意）：console 候选池 UI（先用 API + 脚本，UI 待真实诉求）；L1 提案（W3）
- 无占位符：迁移与接口给定；管线 JSON 需按 `duckle validate` 真机生成（不能凭空写格式，属计划内验证步）
