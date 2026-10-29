# 乐檬全量历史回填计划（2026-10-29）

> 状态：**待裁决**（范围/顺序/时长三项在 §8）。
> 证据口径：所有「上游最早」「跨度上限」都是 **2026-10-29 当场实测**（探针脚本跑在 console-3120 容器内，
> 用两本账套各自的 PAT）；所有「湖覆盖」「行/日」都是同日从 pg_duckdb 直读湖 parquet 统计。
> 未实测项一律标「待实测」，不编。

## 0. 一句话结论

- 上游**可回溯起点 = 2024-10-01**（除费用单据 `branch.expense` 可到 2022-08 / 2023-07）；
  低于此日期的请求被网关**显式拒绝**，不是"查不到数据"，是"不许查"。
- 湖里最早的分区是 **2026-09-20**，即当前只存在最近 5 周。**缺口 722–755 天**。
- 全量回填约 **28.2M 行 / 14 个数据集 / 2 个账套**。技术上可行；
  **长板是零售明细**（约 14.5 万次 API 调用），其余数据集加起来不到它的一半。

## 1. 在跑的管线与湖覆盖（实测 2026-10-29）

| 数据集 | 上游端点 | 湖内最早 → 最新（3120 / 64188） | 天数 | 行/日 3120 / 64188 |
|---|---|---|---|---|
| `retail_order_line` | `retail.ai.pos.posorder.find` | 09-23 → 10-28 / 09-24 → 10-28 | 36 / 35 | 12,062 / 6,441 |
| `inventory_snapshot` | `ama.ai.inventory.snapshot.find` | 10-11 → 10-27 / 10-24 → 10-27 | 17 / 4 | 4,208 / 11,779 |
| `branch_expense` | `ama.ai.branch.expense.find` | 09-20 → 10-28 / 10-26 → 10-28 | 38 / 3 | 177 / 21 |
| `client_expense` | `whs.ai.otherinout.find` | 10-12 → 10-28 / 未接 | 14 / — | 5 / — |
| `loss_adjustment` | `ama.ai.adjustment.order.find` | 10-01 → 10-28 / 10-26 → 10-28 | 28 / 3 | 202 / 92 |
| `request_order` | `ama.ai.request.order.find` | 10-12 → 10-28 / 10-26 → 10-28 | 17 / 3 | 416 / 113 |
| `item_purchase` | `report.ai.itempurchase.find` | 10-12 → 10-28 / 10-26 → 10-28 | 17 / 3 | 89 / 89 |
| `transfer_in` | `ama.ai.transfer.in.order.find` | 10-12 → 10-28 / 未接 | 17 / — | 840 / — |
| `transfer_out` | `ama.ai.transfer.out.order.find` | 10-07 → 10-28 / 未接 | 22 / — | 851 / — |
| `wholesale_out` | `whs.ai.wholesaleorder.find` | 10-07 → 10-28 / 明确不做 | 22 / — | 239 / — |
| `wholesale_return` | `whs.ai.wholesalereturn.find` | 恒空（源从不返回行） | — | 0 / — |
| `branch_indicator` | `report.ai.branchindicator.find`（MCP） | 10-01 → 10-28 / 10-26 → 10-28 | 28 / 3 | 166 / 80 |
| `member_summary` | `report.ai.customeranalysissummary.find` | 10-01 → 10-28 / 10-26 → 10-28 | 28 / 3 | 176 / 73 |
| `recon_source` | `report.ai.itemsales.find`（派生/审计） | 09-23 → 10-26 / 09-24 → 10-26 | 34 / 33 | 148 / 73 |
| `item_price` | `retail.ai.branchitem.realprice.find` | 10-08 → 10-29（事件行）| 19 / 22 | 248 / 621 |
| `dim_branch` / `dim_item` / `client` | 档案类 | `snapshot=` 分区，09-26 起 / client 10-09 起 | — | 快照 |

> 湖覆盖的 `_DAY_DATA`（封版天文件）与 `hour=`（热分区）都已核对，行数取天文件口径。

## 2. 上游最早可取到什么时候（2026-10-29 实测）

### 2.1 统一闸：**2024-10-01**

对每个端点分别打 2024-09-20 / 09-30 / 2024-10-01 / 11-01，两本账套结果一致：

| 端点 | 2024-09-30 及更早 | 2024-10-01 起 | 网关原文 |
|---|---|---|---|
| posorder（零售明细） | 拒绝 | 有数据 | `查询时间超出当前用户可查询范围，最早可查询时间:2024-10-01` |
| itemsales（对账报表） | 拒绝 | 有数据 | `错误码: 10002；查询开始日期不得早于2024-10-01` |
| inventory.snapshot | 拒绝 | 有数据 | `bizday 不能早于当前用户最早可查询日期 20241001` |
| adjustment / request / transfer.in / transfer.out / itempurchase / customeranalysissummary | 拒绝 | 有数据 | `start_date 不能早于当前用户最早可查询日期 20241001` |
| branchitem.realprice | 拒绝 | 有数据 | `最早可查询时间:2024-10-01T00:00` |
| **branch.expense** | **有数据** | 有数据 | 无此闸（见 2.2） |
| wholesalereturn | 拒绝（且窗口内有数据时也恒空） | — | 同上闸 |

> 这是**账号级权限闸**，不是数据缺失：同一端点 2024-10-01 当天就能返回 5 行。
> 若以后要更早（如 2023 年），必须找乐檬放开 `最早可查询日期`，我方无解。

### 2.2 唯一例外：`branch.expense`（费用单据）

- 3120：2022-07-01 空、2022-08-01 起有数据 ⇒ 实际最早 **2022-08**。
- 64188：2023-01-15 空、2023-07-15 起有数据 ⇒ 实际最早 **2023-07**。

### 2.3 单次请求的时间跨度上限（实测，决定分批粒度）

| 端点 | 上限 | 实测原文 |
|---|---|---|
| posorder | **无硬限**（365 天可） | 受分页与响应大小约束，按天/按窗拉 |
| adjustment.order | **3 个月** | `查询时间范围不能超过 3 个月` |
| request.order / transfer.in / transfer.out | ≥92 天可用（未见硬限） | — |
| itemsales | **31 天** | `bizday_start 到 bizday_end 的日期范围最多 31 天` |
| customeranalysissummary | **31 天** | 同上 |
| itempurchase | **31 天** | `…日期范围最多 31 天` |
| branch.expense | **31 天** | `审核时间范围最长为 31 天` |
| otherinout（客户费用） | **30 天** | `查询时间区间不允许超过30天` |
| wholesaleorder | **7 天** | `查询时间区间不允许超过7天` |
| inventory.snapshot | 只有 `bizday` 单日入参 | 无区间概念 |

### 2.4 拿不到历史的（只能从今天起积累）

`dim_branch` / `dim_item` / `client` 是**档案快照**，源只给"当前态"，没有历史版本接口 ⇒ 无法回填，
只能保证每天一拍。`item_price` 的 `last_edit_time` 也受 2024-10-01 闸约束，但"当前价"可以一次全量重拉（见 §5 W4）。

## 3. 缺口与量级（从 2024-10-01 起算到 2026-10-28）

| 数据集 | 缺口天数 3120 / 64188 | 预计新增行（双账套合计） |
|---|---|---|
| retail_order_line | 722 / 723 | **13.4M** |
| inventory_snapshot | 740 / 753 | **12.0M** |
| transfer_in | 741 / —（64188 不做） | 0.62M |
| transfer_out | 736 / —（64188 不做） | 0.63M |
| request_order | 741 / 755 | 0.39M |
| wholesale_out | 736 / —（64188 不做） | 0.18M |
| branch_expense | 719（可到 2022-08，另加 1,510 天）/ 755（可到 2023-07，另加 1,198 天） | 0.14M（+ 历史另计约 0.3M） |
| loss_adjustment | 730 / 755 | 0.22M |
| member_summary | 730 / 755 | 0.18M |
| branch_indicator | 730 / 755 | 0.18M |
| item_purchase | 741 / 755 | 0.13M |
| recon_source | 722 / 723 | 0.16M |
| client_expense | 741 / — | 0.004M |
| **合计** | | **≈ 28.2M 行**（parquet 约 3–5 GB） |

## 4. 回填机制现状（决定了 W0 要补什么）

**已有 `${BIZDAY}` 参数化变体（可直接跑）**：
`retail.day.backfill` / `retail.windows.backfill`、`inventory.snapshot.backfill.3120`、
`branch.expense.backfill.3120`、`member.summary.backfill.3120`、`branch_indicator.backfill.3120`、
`transfer.in.backfill.3120`、`wholesale.out.backfill.3120`、`recon.preagg.backfill`。

**缺变体（W0 必须造，否则跑不了）**：
`loss_adjustment`、`transfer_out`、`request_order`、`item_purchase`、`client_expense`，
以及**全部 64188 变体**（现有变体只有 `.3120` 一份）。

驱动方式不变：`POST /api/run/async`，`{"file":"pipelines/<id>.json","params":{"BIZDAY":"YYYY-MM-DD"}}`，
逐日一次；`retail` 走 `scripts/lemeng/backfill-daily-partitions.py`（宿主侧编排，含封版与删热分区）。

## 5. 分批计划（W0–W5）

### W0 前置（0.5–1 天，不开跑历史）

1. **造变体**：上表缺的 5 个数据集 × 2 账套，按同族范式（`${BIZDAY}` + 自证/哨兵页 + `qa.contract`）生成，
   进 `deploy/duckle/console/pipelines/`；同步 `check-console-schedules` 的 `EXEMPT_*` 登记与告警覆盖
   （新管线不登记会导致"代码在、线上不生效"的静默空转）。
2. **试点计时（必须做，测的是长板）**：两本账套各回填 **1 个历史日**（建议 2025-03-15），
   记录：单日 run 时长、API 调用数、行数、封版标记、对账差异。
   —— 这一天的数据就是本计划的"案例"，没有它不许估总时长（无案例不立标准）。
3. **限流基线**：记录 429 出现频率，定并发上限（当前 `ctl.foreach` 是 `concurrency: 1`）。

**判据**：试点日 `status:ok`、湖行数与源逐日对平、对账差 0（或源侧零单）、无 429。

### W1 核心：零售明细 + 库存快照（长板，优先级最高）

- 顺序：**从最近往过去**（2026-09-22 → 2024-10-01 倒序推进），每段与已覆盖分区首尾相接、不断档；
  逐日对账通过再推前一天（准确性优先，串行）。
- 零售：`backfill-daily-partitions.py --from … --to … --apply`，两本账套；每日每本 96 个子 run。
- 库存：`inventory.snapshot.backfill.*` 逐日，两本账套（64188 单日 11.8k 行、约 59 页）。
- 预计：零售约 14.5 万次调用 / 96–190 小时串行；按并发 4–8 压到 **1–2 天**（待 W0 实测校准）。
- 验收：每天与 `itemsales` 报表同问句对平；抽 3 天做独立通道逐行比对。

### W2 单据系（1 天）

`transfer_in` / `transfer_out` / `request_order` / `loss_adjustment` / `item_purchase` / `client_expense`
（3120 全量；64188 按既有裁决只做要货 / 报损 / 采购 / 客户费用，**配送与批发不做**）。
`wholesale_out` 按 2026-10-10 裁决随本批统一覆盖（3120，7 天/批）。

### W3 报表系（0.5 天）

`member_summary`（31 天/批）、`branch_indicator`（按月入参）、`branch_expense`（31 天/批，另含 2022-08 / 2023-07 起的更长历史）。
`recon_source` 只回填最近 90 天（它是审计派生资产，不是业务历史，757 天全跑性价比低）。

### W4 价格批（0.5 天，独立通道）

- 🔴 **先核一个已发现的疑点**：handbook 记着首载「64188 = 204,474 / 3120 = 734,682 行」，
  但今天湖里 `item_price` **只有 4,708 / 13,669 行**、最早事件 2026-10-08 ⇒ **首载批次不在当前前缀下**。
  要么它写在别处，要么已被某次清理带走。**在回填前必须先定性**：若确认丢失，下游"现价"对 10-08 后
  没改过价的商品是空的。
- 修复方式：用 `backfill-item-price-once.py` 做一次**全状态重拉**（`last_edit_time=2024-10-01`），
  单分支 1,099 行 / 1.7 MB ⇒ 受 12.3 MB 响应上限约束，约 **5 个分支/请求**，3120 需约 55 次调用、64188 约 26 次。

### W5 物化与验收（1 天）

全量回填完成后跑一次 dbt 全量物化（`--threads 1`，4g 内存，见 #1157），
再跑全部 `audit_lemeng__*` 对账；重点看 `retail` / `transfer` / `inventory` 三条主线的容差。

## 6. 验收标准（每批都要过，缺一层不算过）

1. **逐日对源**：零售 ↔ `itemsales` 同问句逐店日对平（现成 `recon.preagg` + dbt 判定）。
2. **行数 sanity**：回填日行数落在该数据集历史日均 ±50% 之外即报警（源侧确实可能为零单，需当日核）。
3. **物化全绿**：`PASS=…/ERROR=0` → `MATERIALIZE_OK`。
4. **抽样独立通道**：每 30 天抽 1 天，用报表接口独立复算金额，逐分比对。

## 7. 风险与红线

| 风险 | 说明 | 处置 |
|---|---|---|
| WINDOW_OPEN / checkpoint 冻结 | 回填只补"从没采过的窗"；回填 ≠ 修数 | 只用历史日；守卫在管线内，撞上即拒写 |
| 429 限流 | realprice 有前科（10-23 起） | 并发默认 1，按 W0 实测再抬 |
| 响应体上限 12.3 MB | src.rest 编译期限制、不可配 | 价格批与零售按分支分块 |
| 存储与物化时长 | +28M 行；物化已串行化 | 分批回填后一次性物化，盯 4g 内存与 postmaster 重启次数 |
| 源侧历史可变 | 报表类历史可能被补录/重算 | 回填当日对账，差异超容差记录并按 heal 闭环处理 |
| 费用单据早于统一闸 | 不能与其它集合同批 | 单独一批，先跑 3120 的 2022-08 起 |

## 8. 裁决（用户 2026-10-29）

1. **范围：全量**——14 个数据集全部回填，不做子集裁剪。
2. **顺序：从最近往过去**——先补齐 2026-09 之前、离今天最近的缺口，再逐段往前推，
   **各段首尾必须相接**（回填段与已有分区之间不留空日；每天回填完立刻核「前一天/后一天都有」）。
3. **准确性优先**——`ctl.foreach` 并发保持 1、逐日对账后再推进下一天；**时长可接受**（不赶工期）。
   ⇒ 计划总时长按串行口径估（约 4–8 天机器时间），不为了压缩时长抬并发。
