# 封版 manifest 压实：明细读路径止血（设计稿 v2，待评审）

> **状态**：**设计稿 v2**（2026-11-10）。未写码、未改生产管线。
> **v2 依据用户裁决**：① builder 归属 duckle console；② 封版后**立即可见**；③ `_bootstrap` 哨兵纳入；
> ④ P1 明细 serving 层按**全历史**规划。
> **触发**：`query_detail` 实机探测 >120s；`_DAILY/*.parquet` 全量扫描把 pg_duckdb 后端打崩、
> postmaster 重置所有连接（issue #1872）。用户明确：**明细是核心分析路径，不能按当前调用量降级**。
> **判据来源**：2026-11-10 数据面实测（独立 DuckDB + pg_duckdb 对照）；正典
> `docs/data-platform-handbook.md` §1.1 / §1.1.1。

---

## 0. 一句话结论

问题不是 ZOS 吞吐，也不是 DuckDB 读 parquet 的能力，而是 **1,541 个一行小文件的逐文件元数据开销**
+ pg_duckdb 的多文件病理路径。

**v1 计划把 `_DAILY/*.parquet` 压成一份 `_SEALED/manifest.parquet`（3.7 KB）**，实测 pg_duckdb
hot-leg anti-join 从 **>110s + 崩库** 降到 **0.732s**，语义双向 `EXCEPT` 为 0。

**v2 因“封版后立即可见”改为：读侧 manifest 落 Postgres 表 `data.lemeng_daily_sealed`，封版 job 同步 upsert。**
S3 文件 manifest 作为可选只读导出，不参与查询路径。理由：

- 表写入与封版标记在同一 job 的提交顺序里，**提交即对读侧可见**（秒级，而不是 5 分钟重建）；
- 多账套/多日并发封版时，`INSERT ... ON CONFLICT DO NOTHING` 行级安全，**不会丢行**；
- 1,541 行的表 + `(system_book, bizday)` 索引，读侧比 3.7KB parquet 更稳定；
- 3.7KB 文件 manifest 的实测仍然保留，作为“把 1,541 个小文件压成 1 份元数据”的可行性证据。

---

## 1. 证据（2026-11-10，数据面）

| 操作 | 环境 | 结果 |
|---|---|---|
| `glob('.../_DAILY/*.parquet')`（只列 key） | 独立 DuckDB | **0.36s**，**1,541 个文件** |
| `read_parquet('.../_DAILY/*.parquet')` | 独立 DuckDB | **14.4s**（≈9ms/文件） |
| 直读单日单账套大文件 | 独立 DuckDB | **0.30s**（2 files，15,934 行） |
| hot leg + `_DAILY` anti-join | pg_duckdb | **>110s**，后端崩溃、连接全重置 |
| hot leg + **单份 manifest 文件** anti-join | pg_duckdb | **0.732s**（Execution 78.975ms；16 hot files / 5,439 行） |
| manifest 构建（`COPY ... FROM _DAILY/*`） | 独立 DuckDB | **16.37s**；**3,719 字节 / 1,541 行** |
| 语义一致 | 独立 DuckDB | markers EXCEPT manifest = **0**；manifest EXCEPT markers = **0** |

补充：pg_duckdb 服务实际参数含 `duckdb.threads=1`、`duckdb.memory_limit=1536MB`（drift 目标可见），
多文件扫描在单线程/小内存下被进一步放大；一份 manifest（文件或表）只有 1 个元数据对象，绕开这条路径。

---

## 2. 目标 / 非目标

### 目标（P0）

1. 查询路径不再读 `_DAILY/*.parquet`（N 个小文件）；
2. 封版后 **立即可见**：manifest 写入与封版标记同一 job，提交后读侧生效；
3. 并发封版不丢行；
4. 视图 hot leg 用 manifest 判重，语义与 `_DAILY` 逐行一致；
5. 单日 `query_detail` / 视图 count 降到秒级，且不再触发 pg_duckdb 后端重置；
6. manifest 的生成、更新、对账、回滚都有明确口径。

### 非目标

- 不解决 7/30/90 天范围明细的延迟（P1 明细 serving 层，按**全历史**规划）；
- 不改 pg_duckdb 的线程/内存/引擎选型（另一条线）；
- 不迁移 Iceberg/Delta；
- 不改变 `_DAY_DATA` / hot 目录的写入布局。

---

## 3. 方案对比（为什么 v2 用表，而不是文件）

| 方案 | 即时可见 | 并发安全 | 读侧成本 | 结论 |
|---|---|---|---|---|
| **Postgres 表 `data.lemeng_daily_sealed`** | **提交即见** | **行级 upsert** | 1,541 行 + 索引 | **采用（v2）** |
| S3 `manifest.parquet` + 定时重建 | 5 分钟滞后 | 单写者才安全 | 1 文件 / 3.7KB | 不满足“立即可见” |
| S3 `manifest.parquet` + 封版同步读改写 | 秒级 | 多写者会丢行 | 1 文件 | 需要单写者/队列，复杂度高 |
| `_DAILY` 改日期分区目录 | 依赖标记写入 | 取决于文件系统 | 相关子查询传播不确定 | 不单独做 |
| 明细 serving 层 | — | — | 范围查询友好 | P1，与 P0 互补 |

> S3 文件 manifest 仍保留为**可选只读导出**（审计/外部消费者），但**查询路径不使用**。

---

## 4. 设计

### 4.1 表结构（数据面 Postgres）

```sql
create table if not exists data.lemeng_daily_sealed (
  system_book varchar(64) not null,
  bizday      date        not null,
  sealed_at   timestamptz not null default now(),
  source      varchar(16) not null default 'seal',  -- seal | reconcile
  primary key (system_book, bizday)
);
create index if not exists lemeng_daily_sealed_bizday_idx
  on data.lemeng_daily_sealed (bizday);
```

- 表在**数据面 Postgres**（与 `vw_` 同库），不在应用库；
- 行数 = `_DAILY` 标记数（含 `_bootstrap` 哨兵，用户裁决 ③）；
- `source` 区分封版写入与对账补齐，审计可追。

### 4.2 写入与对账

**封版 job（立即写入）**：日管线在写 `_DAILY` 标记之后、删除 hot 之前，执行（连接方式见 §8 D2：优先管线内直接 PG；无 PG sink 时调用只做 upsert 的轻量 API，不绕 console DuckDB）：

```sql
insert into data.lemeng_daily_sealed(system_book, bizday, source)
values ($1, $2, 'seal')
on conflict (system_book, bizday) do nothing;
```

- 与标记同一 job；提交即对读侧可见；
- 并发封版由行级 upsert 保证安全；
- **写入失败 ⇒ 封版 job 失败，不删除 hot**（见 §4.3）。

**对账 job（duckle console 定时）**：

- 用独立 DuckDB 读 `_DAILY/*.parquet`（14.4s/次，批处理），与表做双向 diff；
- 缺失行 `insert ... on conflict do nothing`；多余行（标记不存在）按策略删除/告警（默认**只告警不删**，防误删）；
- 建议每 30 分钟或每小时一次；这是用户裁决 ① 的“duckle console 定时 job”落点。
- 对账不参与查询路径，不承担“立即可见”，只做自愈与审计。

**初次回填**：一次性从 `_DAILY` 读 1,541 行 upsert（同对账 job 逻辑），16s 级。

### 4.3 提交顺序与防双算（关键）

manifest 是 `_DAILY` 标记的**读侧镜像**，不是新的封版事实源。封版 job 的顺序必须是：

```
写 _DAY_DATA（冷数据）
  → 写 _DAILY 标记（封版事实源）
  → upsert data.lemeng_daily_sealed（manifest 镜像）
  → 删除 hot 文件
```

状态表（manifest 视角）：

| `_DAILY` 标记 | manifest 表 | hot 文件 | 视图结果 | 判定 |
|---|---|---|---|---|
| 有 | 有 | 有 | hot 排除 + 冷数据 | ✅ 正确 |
| 有 | **无** | 有 | hot 包含 + 冷数据 | ❌ **双算** |
| 有 | 无 | 无 | 冷数据 | ✅ 正确（慢一点，但不错） |
| 无 | — | 有 | hot + 冷数据（若冷数据已写） | ⚠️ 封版前既有窗口，非本次引入 |

**约束**：

1. manifest upsert 失败 ⇒ **封版 job 失败，且不删除 hot 文件**；
2. 双算窗口只允许存在于“标记已写、manifest 未写、hot 未删”的短窗口；由对账 + 审计 + 告警兜底；
3. 对账 job 在 30 分钟内自愈；
4. **不在本设计内解决**“冷数据已写但标记未写”的既有窗口（与 `_DAILY` 方案相同）；由现有对账/审计覆盖。

### 4.4 读侧改动

`vw_lemeng_retail_order_line`（以及 `stg_lemeng_retail_order_line`）hot leg：

```sql
-- before
not exists (
  select 1 from read_parquet('s3://<bucket>/.../_DAILY/*.parquet') m
  where cast(m['system_book'] as varchar) = cast(r['system_book'] as varchar)
    and cast(m['bizday'] as date) = cast(r['bizday'] as date)
)

-- after
not exists (
  select 1 from data.lemeng_daily_sealed m
  where m.system_book = cast(r['system_book'] as varchar)
    and m.bizday      = cast(r['bizday'] as date)
)
```

- 冷腿 `_DAY_DATA`、`_SCHEMA/v3.parquet` 封版断言不变；
- `_DAILY` 文件继续保留：表的事实源、回填、回滚都用它；
- 所有 audit 测试里的 `_DAILY/*.parquet` 同步改为表。

### 4.5 对账与审计（必须与读侧同 PR）

1. **清单一致性** `audit_lemeng__retail__sealed_manifest.sql`
   - `_DAILY` 标记数 vs 表行数；
   - 双向 `EXCEPT` = 0（表侧排除 `_bootstrap` 或单独说明）；
   - 失败即红，不允许“看起来差不多”。
2. **冷热双算** `audit_lemeng__retail__sealed_double_count.sql`
   - 抽样已封版日：`view 行数 = _DAY_DATA 行数`；
   - 若 view > 冷数据，说明 hot 被计入 → 双算。
3. **即时性**：封版 job 成功后，抽样该 `(book, day)` 在表中存在；从封版完成到可查的延迟目标 **≤ 5s**。
4. **对账新鲜度**：对账 job 的 last_run 不得落后超过 60 分钟（告警，不阻塞查询）。

### 4.6 上线与回滚

**上线**：

1. 建表 + 初次回填 + 3 条审计（**不改视图**）——验证表与 `_DAILY` 一致；
2. 封版 job 接入 upsert（先影子写，表不参与读）；验证即时性；
3. 在 dbt 分支改视图 + 更新 audit，跑 `dbt test` / 单日 count 对照；
4. 数据面更版；观察 pg_duckdb 是否还有 `database system was interrupted` / backend reset；
5. 维持 24h 观察，再清理旧路径。

**回滚**：

- 视图改回 `_DAILY/*.parquet`（一个 dbt 变更）；表保留无害；
- 不改 `_DAY_DATA` / `_DAILY` / hot 布局，回滚无数据迁移。

---

## 5. 验收判据

| 判据 | 目标 |
|---|---|
| 封版到可查延迟 | **≤ 5s**（表 upsert 提交即见） |
| 视图单日 count | **< 2s**（warm） |
| `query_detail` 单日 | **< 3s** p95 |
| hot-leg anti-join（pg_duckdb） | **< 1s** |
| pg_duckdb backend reset | **0 次**（观察窗口内） |
| 表 vs `_DAILY` | 双向 `EXCEPT` = 0 |
| 已封版日冷热双算 | = 0 |
| 回滚 | 视图回退一个提交，5 分钟内生效 |

---

## 6. 实施拆分（P0）

| 步骤 | 产物 | 依赖 |
|---|---|---|
| 1 | `data.lemeng_daily_sealed` 表 + 索引 + 初次回填 | 无 |
| 2 | 封版 job 接入 upsert（同时保留 `_DAILY` 标记） | 1 |
| 3 | duckle console 对账 job（读 `_DAILY`，upsert 缺失） | 1 |
| 4 | 3 条审计 SQL | 1、2 |
| 5 | 视图 + audit 切换到表 | 2、4 |
| 6 | 数据面更版 + 基准测试 + 24h 观察 | 5 |

---

## 7. 已定裁决 / 剩余实现细节

**用户已定**：

- ① builder 归属：duckle console（v2 中落为**对账 job**；封版 job 负责即时 upsert）；
- ② 封版后**立即可见**（v2 用表，提交即见）；
- ③ `_bootstrap` 哨兵纳入 manifest；
- ④ P1 明细 serving 层按**全历史**规划（P1 另立项，不在本设计内）。

**架构师裁决（§9 ADR 展开）**：

- **D2：封版 job 直接 upsert 表**（优先管线内 PG；无 PG sink 时用只做 upsert 的轻量 API）。
  **不把 console 放在封版关键路径上**；console 只做定时对账/自愈。
- **D3：P0 先于 P1**；P1 全历史明细 serving 是下一阶段，但 P0 是它可靠回填/审计的前提。

**剩余实现细节（不再作为架构选项）**：

1. 对账 job 的频率（建议 30–60 分钟）与“表多行”处理（默认只告警不删）。
2. 表所在 schema/库的权限与迁移方式（数据面 Postgres，非应用库）。
3. P1 全历史明细 serving 的首建分批策略（避免 pg_duckdb 大 CTAS 崩溃），另立设计。

---

## 8. 架构决策记录（ADR，2026-11-10）

### D1：读侧 manifest 用 Postgres 表，不用 S3 文件

- **决策**：`data.lemeng_daily_sealed` 表作为读侧 manifest；S3 文件 manifest 仅作可选导出。
- **理由**：
  1. **立即可见**是硬要求；只有事务提交能确定性满足。S3 文件 + 定时重建不满足；S3 文件 + 封版读改写需要单写者/队列。
  2. 多账套并发封版，表 `INSERT ... ON CONFLICT` 行级安全；文件方案会 last-writer-wins 丢行。
  3. 1,541 行 + 索引比 3.7KB parquet 更稳定；pg_duckdb 只做一次小表 anti-join。
- **代价**：引入第二事实源（镜像）。用 `_DAILY` 作为源、表作为派生索引，配合对账 + 3 条审计控制漂移。
- **拒绝**：S3 文件 + 5 分钟重建（不满足②）；S3 文件 + 同步读改写（并发丢行）；`_DAILY` 重分区（剪枝不确定，迁移面大）。

### D2：封版 job 直接写表，console 只做对账

- **决策**：封版 job 在写 `_DAILY` 标记后、删 hot 前，直接 upsert 表；console 定时 job 只做对账/回填。
- **理由**：
  1. 立即性要求写入与封版同一 job、同一提交顺序；
  2. **console 是批处理 DuckDB 服务，不应成为每次封版的关键路径依赖**：多一跳网络、多一个失败域；console 挂了会阻塞封版；
  3. 表写入是单条 `INSERT ... ON CONFLICT`，放封版 job 的成本最低；
  4. 若 duckle 管线没有 PG sink，则调用一个**只做 upsert 的轻量 API**（同 job 内同步），仍不绕 console。
- **代价**：封版 job 多一个 PG 依赖；写入失败即 job 失败、不删 hot（§4.3）。
- **拒绝**：console-only 写入（关键路径耦合批服务）；定时重建（不满足②）。

### D3：P0 先于 P1，P1 全历史 serving 是下一阶段

- **决策**：P0（manifest 表 + 视图切换 + 审计）先落地；P1 全历史明细 serving 另立设计。
- **理由**：
  1. P0 移除的是所有 lake 查询路径上的崩溃触发器，成本低、可回滚；
  2. P1 的全历史首建/回填需要读视图/湖，P0 让这条路径先变得安全；
  3. P1 是产品能力（范围/全历史明细），不应阻塞 P0 的止血。
- **P1 方向**：全历史明细 serving 表（订单行粒度），分批首建（避免 pg_duckdb 大 CTAS），增量维护；`query_detail` 全历史走 serving 层，湖视图保留给审计/回填。

---

## 9. 关联

- issue #1872（本设计的触发与验证记录）
- 视图：`dbt/models/lemeng/views/vw_lemeng_retail_order_line.sql`
- staging：`dbt/models/lemeng/staging/stg_lemeng_retail_order_line.sql`
- 标记写入：`scripts/lemeng/gen-retail-day-pipeline.mjs`
- 标记删除：`scripts/lemeng/delete-supplanted-hour-partitions.py`
- 正典：`docs/data-platform-handbook.md` §1.1 / §1.1.1

---

## 11. 验证补记：原生 `snk.postgres` upsert 已验（2026-11-10，实施前）

在数据面 `lemeng-console-3120` 用 duckle MCP 实查并跑通最小管线：

- `list_components(kind=sink)`：**81 个 sink**，含 **`snk.postgres` (available)**；
- `get_component_schema('snk.postgres')` 真实字段：`connectionRef` / `host` / `port` / `database` /
  `username` / `password`；目标 `schemaName` / `tableName` / **`mode`（overwrite|append|upsert|truncate）** /
  **`conflictColumns`** / `connectTimeout` 等；
- 最小管线：`src.inline`（1 行：3120 / 2026-11-08）→ `code.sql`（cast）→
  `snk.postgres`（`connectionRef: pgduck`, `schemaName: data`, `tableName: zz_manifest_test`,
  `mode: upsert`, `conflictColumns: [system_book, bizday]`）；
- **两次 run 均 `status: ok`**（首次 14.5s，第二次 0.8s）；表 `count(*) = 1`、`source = 'seal'`
  ⇒ **upsert 幂等已验证**；临时表已 drop。

⇒ **封版 job 不需要自定义 API**：在 `msrc` 后并联一个原生 `snk.postgres` 节点即可；
连接统一走 `connectionRef: pgduck`（workspace `connections/pgduck.json`，不内联密钥）。
注意：`snk.postgres` 的 **append/upsert 不建表**，`data.lemeng_daily_sealed` 必须由 DDL 预建。

### 审计修正（重要）

**清单一致性/对账不能在 pg_duckdb 里读 `_DAILY/*.parquet`**——那正是 >110s + 崩库的路径。
因此：

- **对账/清单一致性**由 **console 对账 job（独立 DuckDB）**执行（读 `_DAILY` 14s，与表双向 diff，
  补齐/告警）；它是批处理，不上查询路径；
- **pg_duckdb 侧审计**只做：表的新鲜度、已封版日冷热双算=0；不读 `_DAILY`。
