# 乐檬零售明细管线 foreach 原生扇出迁移（v2 实验记录）

> 任务：把 `lemeng.retail_order_line.day`（96 个静态页节点 / 106 节点）迁成
> **`code.sql` 页码清单 → `ctl.foreach` → 每页 `chunk=<page>.parquet`** 形态。
> 日期：2026-11-06（UTC）· 环境：山海数据机 `lemeng-console-3120` / `lemeng-console-64188`（duckle **0.7.4**）
> 性质：**draft 实验，未替换生产管线、未改调度**。v2 文件在
> `docs/superpowers/notes/2026-11-06-foreach-migration.{parent,child}.json`（不在 `deploy/duckle/console/pipelines/`，
> 避免被数据面同步投递、也不进排班期望集）。

## 0. 结论先行

| 判据 | 结果 | 证据 |
|---|---|---|
| **节点数 ≤10** | ✅ 父 **8** / 子 **7** | 父：`pl / fe / an / agg / viol / rep / repsink / die` |
| **行数 / 单数完全一致** | ✅ **同日新旧逐行一致**（0 差异）；⚠️ 与封板快照差 **1 单**，取证为源端迟到单 | §3.2 |
| **耗时 ≤ 现有形态** | ❌ **93.6~103.4s vs 60.7s**（c=2 两次测量）；c=3 反而 **118s** | §3.3 |
| **429 能降级而非整批归零** | ⚠️ **部分满足**：失败页之前的 chunk 保留（不再整天归零）；`continueOnFailure` 让**下游守卫照跑并点名缺页**，但失败页之后的页**当轮不跑**（不是逐项继续）；`retryAttempts>1` 整批重跑且本环境实测卡死 | §3.4 |

**裁决建议：本版 v2 不替换 `lemeng.retail_order_line.day`。** 等价性证明变换逻辑正确；
阻塞项是引擎侧的两条行为（无逐项失败隔离、foreach 子管线逐个起管线开销大）——
不是管线写法问题，改写法绕不过去。

## 1. 对象与基线

| 项 | 值 |
|---|---|
| 旧形态 | `deploy/duckle/console/pipelines/lemeng.retail_order_line.day.json`：96 个 `src.rest` 静态页节点 + `ctl.merge` + 尾页哨兵 + `flatten` + `qa.contract` + `snk.minio`（`all.parquet`）+ 收据/封版标记，共 **106 节点** |
| 父管线 | `lemeng.retail.windows.l1`（3 天 × foreach，concurrency=1）；生产 `fe` 实测 **199,042ms / 3 天 = 66.3s/天** |
| 同日旧形态基线 | 本次把 day 子管线复制一份、sink 改指 `_V2_BASELINE`、日标记改指 `_V2_BASELINE_DAILY`，用 `ctl.foreach c=1` 驱动（**96 请求**）：`fe` = **60,722ms** |
| 封板参考 | `staging.stg_lemeng_retail_order_line` 2026-10-20：**15,267 行 / 9,361 单**（3120 10,015/6,333；64188 5,252/3,028） |
| 源端 | `POST cloud.nhsoft.cn/agi/api/nhsoft.retail.ai.pos.posorder.find`，`page_size` 服务端上限 **200**，响应 `result` 是**纯数组、无 total** |

## 2. v2 设计

```
父（8 节点）                                    子（7 节点，每页一次）
pl  code.sql：页码清单 1..96（range(1,97)）      src      src.rest（page_number=${ITER_ITEM_PAGE_NO}）
     每行带：system_book / bizday / branch_nums     flatten  UNNEST pos_order_details + 定型（照抄旧 SQL）
     / bucket / region / sink_root / run_token      gate     qa.contract（照抄旧 rules）
     / batch_id / expected_pages / ref 区间          sink     snk.minio → .../chunk=<chunk_no>.parquet
     / item_key                                     an       ctl.anchor（落盘后再写收据）
fe  ctl.foreach(concurrency=2, ...)               rec      本页收据（rows / orders / status）
an  ctl.anchor                                    recsink  /workspace/logs/retail-v2-foreach/<run>-p<page>.csv
agg code.sql：读收据 glob，汇总页数/总单数/总明细/第 96 页单数
viol code.sql：pages_missing / pages_failed / batch_empty / capacity_truncated / orders_out_of_range
rep / repsink：**违规明细** CSV（成功时只有表头；批总量见 `agg` 节点）
die ctl.die(has-rows)：任一违规 → 判红
```

**硬约束落实**：

- **子管线零 `${ENV:...}`**（`grep -c 'ENV:'` = 0）：`branch_nums / system_book / bizday / bucket / region /
  sink_root / run_token / batch_id / expected_pages / page_no / chunk_no` 全部由父管线以 `ITER_ITEM_*` 列显式传入。
  凭据仍走 `connectionRef`（`lemeng` / `zos`）。
- **每页直接落湖**：`lemeng/retail_order_line/<sink_root>/system_book=<B>/bizday=<D>/chunk=<page>.parquet`
  （`sink_root` 是父管线常量，本次用 `_V2_FULL` 等测试前缀，**未写生产 `_DAY_DATA`**）。
- **零行守卫**：允许单页 0 行；整批要求
  ① 收据数 = `expected_pages`（缺页即红）
  ② 总单数 ∈ `[ref_min_orders, ref_max_orders]`（默认 `[1, 19200]` = 1..96×200）
  ③ 第 96 页单数 = 0（容量截断哨兵，等价旧形态的尾页 guard）
  ④ 无 `status<>'ok'` 的页。

## 3. 真机实测

### 3.1 子管线单跑（隔离验证）

把子管线里的 ITER 占位符换成字面量后**顶层单跑**（page 1 / 2026-10-20 / 3120）：

| 节点 | rows | duration |
|---|---|---|
| `src` | 200（订单） | 919ms |
| `flatten` | 235（明细行） | 135ms |
| `gate` | 235 | 325ms |
| `sink` | 235 | 184ms |
| `rec` | 1（收据：`detail_rows=235, orders=200`） | 165ms |
| 全 run | — | **2,430ms** |

⇒ 子管线本身正确；后续问题都在 **foreach 编排层**。

### 3.2 等价性（2026-10-20）

**A. 新旧同日逐行比对（强判据）**

同日（2026-11-06）分别跑 v2 与旧形态（sink 均改指测试前缀），3120：

| 版本 | 行数 | 单数 | `fe` 耗时 |
|---|---|---|---|
| v2（96 页 chunk） | **10,016** | **6,334** | 103,383ms |
| 旧形态（1 个 `all.parquet`） | **10,016** | **6,334** | 60,722ms |

逐行集合差（`order_no / order_detail_num / bizday / hour / sale_money / quantity / branch_num / item_num /
order_time / order_total_money` 十列）：

```
v_minus_b | 0
b_minus_v | 0
```

⇒ **新旧两版同日产出逐行完全一致**（10,016 行全等）。

**B. 与封板快照的差（1 单）**

v2 合计 **15,268 行 / 9,362 单**，封板参考 **15,267 / 9,361**，差恰好 1 单：

```
v2_only | 312026826293002003 | 1 | 2026-10-21 21:49:51
```

该单被 2026-10-20 的窗口返回（落在 `bizday=2026-10-20` 分区），但 `order_time` 是 **10-21 21:49:51**。
同一天用**旧形态重取**也包含它（上表新旧一致）⇒ 这是**源端迟到/补录单**，不是 v2 的缺陷。
64188 侧无漂移：v2 = **5,252 / 3,028**，与生产湖 `_DAY_DATA` 和 staging 逐数一致。

> 结论：**「封板日」并不等于源端冻结**。验收判据不能只写「与历史 staging 完全一致」；
> 必须写成「与**同日重取**的旧形态完全一致」，或先证明该日源端无迟到单。

### 3.3 耗时（判据未过）

| 形态 | 3120 单日 `fe` | 备注 |
|---|---|---|
| 旧形态（96 静态节点，一个管线） | **60.7s** | 96 请求共用一个 HTTP 客户端/连接池 |
| v2 foreach **c=2**（首次） | **103.4s** | 96 个子管线，每个 7 stage |
| v2 foreach **c=2**（最终版复跑 01:37 UTC） | **93.6s** | 96 页、96 收据、`viol`=0；同日同形态两次测量 93.6~103.4s |
| v2 foreach **c=3**（上限） | **118.1s** | 未更快；本次未命中 429，差异属编排/连接开销 |

**64188 最终版 c=2**：`fe` **90,057ms**（96 页；该账套订单数约为 3120 的一半，但页数上限同为 96）。

**原因（实测推断）**：每个 foreach item 都起一条完整子管线（7 个 stage + 独立的 DuckDB 视图/HTTP 客户端），
单页成本 ~1.95~2.15s；旧形态的 96 个 `src.rest` 在同一管线里共享连接，单页有效成本 ~0.63s。
**并发受网关上限（≤3）约束，补不回这部分开销。**

### 3.4 失败注入（判据未过）

**注入法（真网关确定性错误）**：页码清单里把某一页的 `page_number` 设为 **0**（`chunk_no` 仍是真实页号）：
网关稳定返回 `HTTP 500 {"code":50000,"msg":"Page index must not be less than zero"}`。

实验 A（3 项：page 1 / page 0 / page 96，**无** `continueOnFailure`、无重试）：

```
fe: status=error, duration_ms=6441
  ctl.foreach(...)[row 1]: query: page 0: query: REST HTTP 500 ...
```

- ✅ page 1 的 `chunk=1.parquet` 与收据**已落盘**（不再整天归零）。
- ❌ page 96 **没跑**（首个失败项即中止剩余项）。
- ❌ 下游 `agg / viol / die` **不执行**（硬失败终止管线），零行守卫拿不到机会。

实验 B（同 3 项，`continueOnFailure=true`、**无**重试、c=1）——**这条最容易被误读**：

```
fe: status=error（软失败）
agg rows=1 → viol rows=1（pages_missing）→ repsink rows=1 → die: error（1 条违规）
run: error, duration_ms=9176
```

- ✅ **下游守卫照跑**：`agg / viol / rep / die` 全部执行，`die` 明确报 **pages_missing**（实到 1 / 应到 3）。
- ✅ page 1 的 chunk 保留。
- ❌ **page 96 仍未跑**（子管线日志按本 run id 计数 = **0**）——`continueOnFailure` 只让 **foreach 这个 stage 软失败**，
  不让 foreach **继续处理剩余 item**。已有条目「其余 5 窗照常采集」的实测多半是「失败窗排在最后」，
  本次把失败放在**中间**才照出这一层。
- **c=2 复测同形**（2026-11-07 01:37 UTC，3 项 1/0/96、无重试）：`fe` 6,351ms 软失败，p96 仍 **0** 次，
  下游 `agg/viol/rep/die` 照跑，`die` 报 `pages_missing`。⇒ 该语义与并发数无关。

实验 C（同 3 项，`continueOnFailure=true` + `retryAttempts=4, retryBackoffMs=60000`）：

- 实测为 **stage 级整体重跑**：page 1 与 page 0 各被重跑 **3 次**（`run_started` ×3），page 96 仍未跑。
- 第 3 次失败后（16:12:10）**stage 卡死 >3 分钟无结束**（本环境一次观察），console 队列被堵，只能重启容器清场。

> **结论（订正）**：`continueOnFailure` **不是**「逐项失败继续」，而是「**foreach 软失败、下游继续**」。
> 因此「只丢该 chunk、其余照常落盘」在 0.7.4 **不成立**——失败项之后的页当轮不跑；
> 但降级形态比旧形态好：**失败页之前的 chunk 保留 + 尾部守卫点名缺页 + 补跑只补缺页**。
> 要真正逐页隔离，需要引擎提供逐项失败继续（或 `dispatch: queue` + worker 的可用形态，本次未验证）。

### 3.5 零行 / 缺页 / 容量守卫（逻辑本身通过）

用干净批次的 96 张收据单独跑守卫段（不重新取数）：

```
agg   rows=1
viol  rows=0
die   status=ok, rows=0
```

**最终版全量端到端（2026-11-07 01:37 UTC，`_V2_FINAL`）**：

```
pl    rows=96
fe    rows=96, duration_ms=93,648
agg   rows=1
viol  rows=0
rep   rows=0（无违规，CSV 只有表头）
die   status=ok, rows=0
```

回读 `_V2_FINAL`：**10,016 行 / 6,334 单**，与同日旧形态 `_V2_BASELINE` 一致（十列逐行 0 差异，双向 `EXCEPT` 均为 0）。

**64188 最终版全量端到端（2026-11-07 01:39 UTC）**：`fe` 90,057ms、`agg` 1 行、`viol` 0 行、`die` ok、96 张收据；
回读 `_V2_FINAL` **5,252 行 / 3,028 单**，与生产湖 `_DAY_DATA` / staging 逐数一致。

⇒ 判据 SQL 与 `ctl.die` 接线正确。注意 `die` 的 **main 边必须接 `viol`**（transform），
`repsink` 只能作 **trigger** 边——接成 main 会报 `Table with name repsink does not exist`（本次踩过）。

### 3.6 第三种 429（真网关，2026-11-06 复现）

4 个并发请求（同一 PAT，page 1，3 轮）：

```
round 1: 2× code=0 / 2× HTTP 429 {"code":429,"message":"PAT并发请求超限"}
round 2: 2× code=0 / 2× HTTP 429 {"code":429,"message":"PAT并发请求超限"}
round 3: 2× code=0 / 2× HTTP 429 {"code":429,"message":"PAT并发请求超限"}
```

⇒ 除正典已记的「频率超限」「额度不足」外，**第三种 429 = 并发闸**：并发 4 立即拒约一半；
本环境 **c=1/2/3 可用**，c=4 不可用。处置是**降并发**，不是加退避/重试。

## 4. 结论与建议

1. **不切换生产**。旧形态（96 静态节点 + 一个 `all.parquet`）在 0.7.4 上仍更快、失败语义更可控。
2. v2 的**变换逻辑已被逐行证明等价**（同日新旧 0 差异），可原样复用于未来引擎版本。
3. 若要继续推进 foreach 形态，先解决两个引擎侧前置条件：
   - **逐项失败继续**（或可用的 `dispatch: queue` + worker），让单页失败只丢该页；
   - **子管线开销**（共享 HTTP 客户端 / 减少每页 stage 数），否则 c≤3 下追不平旧形态。
4. **页数上限 96 是过度分配**：3120 实际只需 32 页（6,334 单 ÷ 200）、64188 16 页（3,028 ÷ 200）；若将来能先探明页数再生成清单，
   foreach 的请求量和耗时都会显著下降（本次未实现，属后续优化）。
5. **验收口径订正**：封板日仍可能收到源端迟到单；等价性应对比「同日重取的旧形态」，
   或先证明源端冻结。

## 5. 复现

- v2 文件：`docs/superpowers/notes/2026-11-06-foreach-migration.parent.json` / `.child.json`
  （复制到 console 的 `/workspace/pipelines/` 后 `duckle validate` 通过。本次实跑部署版本 sha256：
  parent `8354191f…`、child `07549dd2…`；仓内定稿（`_note` 订正后）parent `bdac716a…`、child `07549dd2…`
  —— 两者仅 `_note` 文案不同，逻辑一致）。
- 触发：`POST /api/run/async {"file":"pipelines/<parent>.json","params":{"BIZDAY":"2026-10-20","V2_SINK_ROOT":"_V2_FULL"}}`
- 回读：pg_duckdb `read_parquet('s3://<bucket>/lemeng/retail_order_line/_V2_FULL/system_book=<B>/bizday=2026-10-20/*.parquet')`
- 本次所有测试前缀：`_V2_LAB` / `_V2_LAB_NR` / `_V2_FULL` / `_V2_C3` / `_V2_BASELINE`（均未写生产 `_DAY_DATA`）。
