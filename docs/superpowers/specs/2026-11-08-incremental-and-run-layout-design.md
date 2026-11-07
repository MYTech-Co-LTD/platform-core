# 真增量 + 湖布局 run 目录（设计稿，待评审）

> **状态**：**设计稿**（2026-11-08）。未写码、未改任何生产管线。
> **触发**：排班小时化（#1624）后，19+16 条报表类 L0 每小时重采同一窗口；用户要求
> ① 真增量（没新数据就不采）② 湖布局加 run 目录（否则复刻 #1069 覆盖丢数据）。
> **判据来源**：`docs/data-platform-handbook.md` §1.1（三档）/ §1.1.1（E3 证成）/ §1.7（坑账）；
> 引擎事实全部来自 **2026-11-08 本环境 `list_components` / `get_component_schema` 实查**。

---

## 0. 一句话结论（先说，因为它决定了方案形状）

**引擎里没有「成功跳过」原语，而且管线内无法阻止 sink 执行**——
`ctl.switch` 把行路由到未连接的分支后，**sink 仍然会跑**（实测 `k` 节点 `rows=0 / status=ok`，
写了一个 0 行对象）。`ctl.die` 只会 `rc=1`（假红），`snk.minio` 只有 `overwrite` 一种写模式。

⇒ 「跳过 sink」做不到，但**「不采」做得到**：`ctl.foreach` 的迭代项来自上游行集，
**上游 0 行 ⇒ 0 个子管线运行**（2026-11-08 实测：父 run `ok`、子管线一个没跑）。
所以真增量 = **探针 + 数据驱动页列表 + foreach**，全部在 console 内，不搬调度。

这正是为什么两件事必须一起做：**run 目录让「多跑一轮空」变得无害**，真增量才敢上。

---

## 1. 引擎事实（本环境实查，2026-11-08）

| 组件 | 事实 | 证据 |
|---|---|---|
| `snk.minio` | `mode` 只有 `overwrite`（无 append / 无 skip-empty / 无 error-only） | `get_component_schema`：`options=[{label: Overwrite, value: overwrite}]` |
| `ctl.switch` | 按布尔表达式把行分到 `case_1..N` / `default`；**未连接的分支不会阻止下游节点执行** | 实测：`default` 悬空时，`sink` 仍执行（`rows=0`） |
| `ctl.die` | `condition: has-rows / no-rows`；触发即 **run 失败（rc=1）** | 2026-11-07 截断哨兵实测 |
| `ctl.checkpoint` | 行透传 + 同时写 parquet 快照；后续 run 可用 `src.parquet` 读回 | `get_component_schema` |
| `src.changed` | 轮询**远端对象元数据**（HEAD / sftp stat / s3 前缀），只吐「变了的」；无变化时报 `unchanged` | `get_component_schema`；**但它盯的是对象/文件，不是 REST 接口的「有没有新数据」** |
| 同管线并发 | console **拒绝同一管线并发**：「already running in this workspace…」 | 实测（连发两次 `run/async`） |
| 不同管线并发 | 允许；实测单账套同时段最多 3 条 run 区间重叠 | 近 24h run 记录区间分析 |
| `${datetime}` | 可作 per-run token，展开为 `YYYY-MM-DD_HHMMSS`（UTC） | 实测 sink key `.../run=${datetime}/all.parquet` → `run=2026-11-07_162128/all.parquet` |

**三档落位**：
- **②（有但未验）**：`ctl.checkpoint` + `src.parquet` 做**水位存储**——本环境尚未用于采集水位（只用于别的场景），需最小验证；
- **③（结构性没有）**：管线内「成功跳过 / 不写 sink」——结构性理由见 §0；
- **①（有且验过）**：`${datetime}` 作为 run 目录 token（本次实测）。

---

## 2. 设计：两层

### L2 存储层：sink 加 run 目录（先做，风险低、收益立现）

**改法**：增量类管线的 sink key 从

```
<prefix>/system_book=${ENV:SYSTEM_BOOK}/bizday=${date-1d}/all.parquet
```

改为

```
<prefix>/system_book=${ENV:SYSTEM_BOOK}/bizday=${date-1d}/run=${datetime}/all.parquet
```

**为什么必须先做**：固定窗口源每轮重采同一天，若仍写同一个 key，**后一轮覆盖前一轮**
（#1069 已实测丢数）。加 run 目录后，每轮写自己的目录，**覆盖写不再互相踩**。

**连带改动（必须同步，否则读不到/读重）**：
1. **读侧**：staging / dbt 视图的 `read_parquet` 从 `bizday=*/all.parquet` 改为
   `bizday=*/run=*/all.parquet`，并**去重**（按事件键，见各表契约的自然键）；
2. **保留策略**：run 目录会累积——每天 N 轮 × 42 条。必须定「保留最近 K 轮 / 每日压实成一份」；
   否则对象数爆炸（单表一天 15 个目录）。
3. **catalog / owners**：`owners.lemeng.json` 的 `match` 要跟着改成 `run=*`；
   否则新鲜度锚匹配不到（今天刚修过的同类问题）。
4. **契约 `layout`**：`contracts/` 里若有写死的路径形态，一并改。

**代价**：读侧多一层 glob + 去重；对象数 ×N。**收益**：重采不再丢数据，真增量才安全。

### L1 管线层：真增量（**不依赖 openship job**，2026-11-08 实测可行）

**关键实测**：`ctl.foreach` 的迭代项来自上游行集 —— **上游 0 行 ⇒ 0 个子管线运行**。
实测：空页列表的父管线 `status: ok`、`f` 节点 `rows=0`、子管线一个都没跑（无产物文件）。
⇒ **「没新数据就不采」可以在 console 内完成**，不需要把调度搬到 openship job。

**管线形态**：

```
probe(src.rest, page_size=1)        # 1 次请求，拿「最新一条」做指纹
  → fp(code.sql)                    # 指纹（如 max(order_operate_time) / max(order_no)）
  → cmp(code.sql)                   # 与上一轮水位比（src.parquet 读 ctl.checkpoint 落的文件）
  → pages(code.sql)                 # has_new ? 生成 1..N 页 : 生成 0 行
  → ctl.foreach(pages)              # 0 页 ⇒ 0 次子管线；N 页 ⇒ N 次
  → merge → transform → gate → sink(run=${datetime}/)
```

**代价对比**（以 20 页的源为例）：

| 场景 | 现在（每小时全采） | 改后 |
|---|---|---|
| 无新数据 | 20 次请求 + 1 次写 | **1 次请求** + 1 次空写（run 目录，无害） |
| 有新数据 | 20 次请求 | 1 + 20 次请求 |

**已知代价（来自 2026-11-06 foreach 实测）**：
- foreach 逐页起子管线比静态页慢（同日 3120：静态 60.7s vs foreach c=2 103.4s）——但**无新数据时是 0 页，反而更快**；
- 子管线**不展开 `${ENV:...}`** ⇒ 页参数只能走 `ITER_ITEM_*` 列 + `connectionRef`；
- `continueOnFailure` 不继续剩余项（单页失败会中断后续页）；
- `retryAttempts` 是 stage 级整体重跑。

**逐源前置**（A 段工作，未做）：每个源要能**便宜地回答「有没有新数据」**——
① 支持 `since`/`last_edit_time` 的直接查增量；
② 不支持的拉 page 1（page_size=1）比指纹；
③ 连 page 1 都拿不到稳定指纹的（全量快照类），**这类本来就没有「增量」概念**，应降频而不是硬做。

---

## 3. 迁移步骤（每步可回滚）

| # | 动作 | 判据 |
|---|---|---|
| 1 | 选 1 条低频源做 L2 试点（测试前缀） | 连跑 2 轮，两轮各自 `run=` 目录都在，读侧 union 后行数正确 |
| 2 | 试点源改读侧（staging 视图 union + 去重）+ owners match | 物化后行数与改前一致（逐日对账） |
| 3 | 批量改 42 条 sink key + 契约 + owners + 视图 | 每批跑一次物化 + 对账 |
| 4 | 定保留策略（压实时点、保留轮数） | 对象数稳定、读侧不变慢 |
| 5 | 选 1 个源改 L1 形态（探针 + 空页列表 + foreach） | 无新数据时子管线 0 次、run 成功；有新数据时页数与改前一致 |

> **逐条上生产的执行单**：`docs/superpowers/notes/2026-11-08-incremental-production-runbook.md`
> （含上生产前的阻断项：身份闸/截断哨兵未由生成器携带、契约 `layout.fileName` 与 page 文件不一致）。

---

## 4. 需要拍板的三件事

1. **逐源探针口径**：每个源「有没有新数据」怎么判（since / page1 指纹 / 无增量概念→降频）。
   这是 A 段工作，需逐源跑；建议先挑 2–3 个高频源做。
2. **保留策略**：run 目录保留几轮 / 何时压实（影响对象数与读性能）。
3. **去重口径**：读侧按什么键去重（各表契约的自然键不同，需逐表确认）。

---

## 5. 本次已验 / 未验

**已验**（本环境）：
- `${datetime}` run 目录可写；同管线并发被拒；`ctl.switch` 不能跳过 sink；`snk.minio` 只有 overwrite；
- **增量链路端到端跑通（2026-11-08，`request.order` 试点，测试前缀）**：
  - 水位为空 → `pages=10` → `foreach` 跑 10 个子管线（11.1s，10 个分页请求）；
  - 水位已是最新 → `pages=0` → **`foreach` 跑 0 个子管线**（3.6s，只有 1 次探针请求），run `ok` 不假红。
- **实现细节（踩到的坑）**：`ctl.checkpoint` 会在比较之前把水位文件覆盖成当前值 ⇒ 下一节点读到的
  「上一轮水位」已经是本轮 ⇒ 判定恒为「无新数据」。**正确做法**：水位用**旁路 sink** 写
  （`cmp → wmk(code.sql: SELECT fp) → snk.parquet`），依赖关系保证它在比较之后执行。
- **契约投影试点（2026-11-08，`pilot/` 前缀）**：用现役 `shape` 节点的契约投影做子管线 transform，
  跑 3 页 ⇒ run `ok`、湖里回读 **273 行 / 67 单号**、**24 列与契约同序**。
  父页列表已额外产出 `system_book` / `run`，子管线投影把 `${ENV:SYSTEM_BOOK}` / `${datetime}` /
  窗口 token 改写成 `ITER_ITEM_*`（否则 `batch_id` 拼不出来——2026-11-07 首次上生产即因此回滚）。

**未验**：
- `ctl.checkpoint` + `src.parquet` 作为**采集水位**的完整回路（缺文件、并发写、损坏时的行为）；
- 读侧 `run=*` union 去重后的**性能**（对象数 ×15 后物化耗时）；
- 保留策略的压实脚本（未写）。

---

## 6. 逐源探针结果（2026-11-08，3120 的 19 条小时档）

**判据**：① 有没有日期窗口；② page 1（page_size=1）能不能拿到稳定的单据号做指纹。

### A 类：可做增量（有窗口 + 有单据号）

| 管线 | 窗口参数 | 指纹候选 | 实测 |
|---|---|---|---|
| `request.order` | `date_start/date_end` + `date_type` | `request_order_fid` | ✅ 端到端跑通（10 页 → 空页 0 子管线） |
| `branch.expense` | `date_from/date_to`（datetime） | `bill_no` | ✅ page1 返回 `OP3120992611060001`（689ms） |
| `client.expense` | `date_start/date_end` + `date_type` | `other_inout_bill_no` | 同族，待逐条验 |
| `transfer.in/out`、`wholesale.out/return`、`loss.adjustment` | `date_start/date_end` + `date_type` | 各自单据号 | 同族，待逐条验 |
| `purchase.analysis` | `audit_date_start/end` | 单据号 | 待验 |

### B 类：没有「增量」概念（全量快照 / 报表 / 无窗口）

`dim.item`、`dim.branch`、`inventory.snapshot`（`bizday` T-2）、`member.summary`、
`business_collection`(+`_coupon`/`_receive`)、`customer_analysis`、`metric_profile`、`saler_commission`

**这类不该硬做增量**——每轮本来就是「全量重取」。正确处置是**按源端发布节奏降频**（例如每天 1–2 次），
而不是每小时跑一遍。`dim.item_price` 有 `last_edit_time`，可能属 A 类（按编辑时间增量），待验。

> 结论：**19 条里约 9 条能做真增量，约 10 条应降频。** 这个分类要先跟业务确认（降频会不会影响看数）。

