# 零售明细「热层」设计 —— 把报表新鲜度从 1–2 小时压到 10 分钟

> 状态：**待评审**（PoC 已实测，见 §3；未写码）。决策人：@主人。
> 相关：#2713（懒扩容，采集侧已 10 分钟）、`dbt/macros/closed_before_predicate.sql`、`scripts/lemeng/materialize.sh`

## 1. 问题

采集每 10 分钟一次、加工每 10 分钟一次，但报表看到的数据**滞后 1–2 小时**。

原因不是频率，而是**加工不敢读正在被重写的文件**：

- 采集把「当前小时」写成 `hour=<H>/all.parquet`，每 10 分钟**覆盖写**一次（累积窗语义）
- 加工（`data.dbt_tick`，`:02`）用 `closed_before_predicate()` 排除 `bizday=今天 and hour >= 当前小时-1`
  —— 因为 DuckDB 读 parquet 会先取 ETag 再 GET，文件被替换即抛错，禁用校验又会读到前后不一致的行
- ⇒ 11 点的数据要等 13:02 那轮才进报表

**这是刻意的正确性取舍**（2026-11-08 P0），不是缺陷。要压滞后，就得给「当前小时」一条**读写不冲突**的通道。

## 2. 行业对照与选型

行业标准是 **Lambda 架构**：批层（历史权威）+ 速度层（分钟级），报表合并两层。

| 速度层实现 | 代表 | 本仓适配性 |
|---|---|---|
| 湖表格式（Iceberg/Delta/Hudi）提供快照隔离 | Databricks / Netflix / Airbnb | ❌ 需改湖布局；且读方 DuckDB 1.4.3 跨版本兼容有未验 gate（2026-10-20 决策绕开） |
| OLAP 引擎当速度层（ClickHouse/Doris） | 国内中小团队最常见 | ⚠️ 需引入新组件 |
| **用现有 pg_duckdb 做速度层** | — | ✅ **选它**：`snk.postgres` 组件现成、湖布局不动、事务天然解决并发 |

**选型：pg 热表 = 速度层，湖 = 批层。**

## 3. PoC 实测（2026-11-23，容器内，已清理）

| 项 | 结果 |
|---|---|
| 写热表：1,301 行 append | **130–161 ms**（采集 tick 现为 24–31s ⇒ 代价可忽略） |
| 报表主查询：取最新批次 | **5.3 ms** |
| 热表 + 湖 union 查一整天（14,361 行） | **3.0 s**（受湖读取支配，热表仅占 5ms） |
| 整条探针管线（读湖→过滤→写 pg） | 413–457 ms |

**两个实测约束（必须写进实现）**：
1. 热表（pg 原生类型）与湖（`read_parquet` 动态类型）做 UNION **必须显式 CAST**，否则
   `UNION types character varying and duckdb.unresolved_type cannot be matched`
2. pg_duckdb 里 `read_parquet(...)` 必须带别名 + `r['col']` 语法（既有约束，见 staging 模型头注）

## 4. 设计

### 4.1 热表（速度层）

```sql
create table if not exists staging.retail_hot (
  run_token  varchar(32) not null,   -- 采集批标识（${datetime}）
  system_book varchar(64) not null,
  bizday     date        not null,
  hour       integer     not null,
  ...（25 列与 flatten 输出完全一致）...
);
create index if not exists retail_hot_latest on staging.retail_hot (system_book, run_token);
```

- **append-only**：每轮采集追加一整批，带 `run_token`；**不做 delete/upsert**
  （订单减少/取消靠「读最新批次」自然反映——旧批次的残留行永远不会被读到）
- **读法**：`where run_token = (select max(run_token) from staging.retail_hot where system_book = …)`

**为什么不用 upsert**：upsert 按唯一键覆盖，只能处理「新增/修改」，**处理不了「源端撤单导致本批少了一行」**——那行会永远留在表里。快照式 append + 取最新才等价于「本批真实状态」。

### 4.2 采集侧（写两处）

`lemeng.retail_order_line.tick` 在现有 `sink`（minio）之后**再加一个 sink**：

```json
{"id":"hot","componentId":"snk.postgres",
 "properties":{"connectionRef":"pgduck","schemaName":"staging","tableName":"retail_hot","mode":"append"}}
```

- 排在 `sink` 之后、`summ`/`receipt` 之前（触发边）
- **失败不阻断写湖**（`continueOnFailure: true`）：热表是加速层，坏了最多回到 1–2 小时滞后，不能让采集红
- 代价：+150ms/窗口

### 4.3 加工侧（改两处，闭窗谓词下移）

现状：闭窗谓词在 **marts 层**（5 个模型：`fct_retail_sale` / `_quantity` / `_item_sale` / `fct_order_event` / `_comparable_growth`）。

改造：**把「谁读活数据谁闭窗」的责任下移到 stg**。

| 文件 | 改动 |
|---|---|
| `stg_lemeng_retail_order_line.sql` **热腿（湖）** | 加 `and {{ closed_before_predicate() }}`（湖永远只读闭窗小时） |
| 同上，**新增第三腿（热表）** | `select …, 'hot' as _source from staging.retail_hot where run_token = (select max(run_token) …)`，**不套**闭窗 |
| 5 个 marts | 删掉 `{% if MAT_CLOSED_BEFORE %} and {{ closed_before_predicate() }} {% endif %}`（来源已在 stg 保证） |

**生成器约束已核实，不构成障碍**（2026-11-23）：`gen-data-projection.mjs` 的形态契约是
「只重写 `SELECT … 顶层 FROM` 之间的列区，**`FROM` 及其之后逐字保留**」，且已支持一个模型内
多个 `SELECT…FROM` 位点（stg 现有冷/热两腿即两位点）。
⇒ **直接手改 `FROM` 段加第三腿**，列清单仍由生成器统一重写；不建独立模型、不扩生成器、
不加 `_source` 列（闭窗下移后由各腿自己负责）。

### 4.3.1 影响面（13 处引用，必须逐类确认）

`stg` 被 13 处引用（含 README/schema.yml 等非模型）。加腿后**所有引用者都会看到当前小时**：

| 引用者 | 变化 | 判断 |
|---|---|---|
| 5 个带闭窗谓词的 marts | 谓词删掉、改由 stg 各腿闭窗 ⇒ 行为不变 | ✅ |
| `vw_lemeng_retail_order_line` / `_month_history` | 报表视图开始返回当前小时 | ✅ 本设计目的 |
| `fct_branch_day_activity` | 当天聚合会含当前小时 | ⚠️ 验收时对比确认可接受 |
| `fct_retail_swap_offset`（全史对账构件） | 同上 | ⚠️ 当天数据不进对账窗口，但需无硬假设；验收时对比 |

### 4.4 GC

- 热表只对「当天」有意义。**每天封版任务（`lemeng.retail.close.l1` / `windows.l1`）成功后**，
  删除 `bizday < 今天` 且 `run_token` 已非最新的所有批次：
  `delete from staging.retail_hot where bizday < current_date - 1`
- 量级：144 批/天 × 1,300 行 ≈ 19 万行/天/账套 —— 单表可控，周清理足够
- 若清理失败：只增长不丢数，由 `data.scorecard` 的存储维度兜底

## 5. 验收判据

0. **双跑对比（一次性改的安全网，先于其它判据）**
   - **A. 热表为空**构建一遍 ⇒ `fct_retail_sale` 等 5 个 marts 结果与当前 main **逐行一致**
     （证明改动没破坏既有语义）
   - **B. 灌入热表**再构建 ⇒ 差异**只多出当前小时**的行，且无重复键
   - 同时对比 `fct_branch_day_activity` / `fct_retail_swap_offset` 两个无谓词的引用者
1. **新鲜度断言**（新增）：每小时查一次「当前小时-1 的第一单，是否已在 `fct_retail_sale` 里」，
   连续 3 天每天 ≥20 个采样点全部命中 ⇒ 通过
2. **不回归**：`fct_retail_sale` 与现有全史面逐日对账（`recon.preagg`）差为 0
3. **采集不变慢**：tick 时长增幅 ≤ 1s（PoC 实测 +0.15s）
4. **热表坏了不连坐**：手动置热表写失败，采集仍绿、报表回落到当前 1–2 小时滞后
5. **GC 生效**：连续 2 天，`select max(bizday) from staging.retail_hot` 不落后于今天

## 6. 风险与回退

| 风险 | 处置 |
|---|---|
| 热表与湖口径不一致（漏列/类型）| 25 列由 flatten 的 SELECT 列表机器生成，不手抄；上线前跑一次逐行 diff |
| `_source` 列污染下游 | 只在 stg 内部使用，不写进契约列集；marts 不 select 它 |
| 5 个 marts 同时改，面大 | 分两步：先只改 `fct_retail_sale`（tick 档唯一模型）验证 3 天，再推其余 4 个 |
| GC 误删当天 | 删除条件带 `bizday < current_date`，当天永不删 |

**回退**：删掉热表 sink + stg 第三腿 + 恢复 marts 闭窗谓词 ⇒ 立即回到现状，**无数据迁移**。

## 7. 已决议（2026-11-23 决策人拍板）

1. **落地形态**：直接改 stg 的 `FROM` 段加第三腿（§4.3），不建独立模型、不扩生成器
2. **一次性改 5 个 marts**（不分两步）；安全网 = §5 第 0 条「双跑对比」
3. **schema = `staging`**（零新建 schema；语义上它是 stg 的数据源而非投影）

## 8. 不在本 spec 范围

- 秒级/流式（乐檬无 CDC，只能拉）
- 湖改表格式（独立的架构决策，见 §2）
- 非零售域的热层（本次只做销售事实）
