# 物化改增量 + 采集/物化分档（实施计划）

> 状态：2026-11-06 用户拍板三条决策，P1 开工。
> 前置设计：`docs/superpowers/specs/2026-11-04-incremental-marts-design.md`（lookback + delete+insert，本计划是其落地拆分）。
> 阻塞项已清：pg_duckdb segfault 根因 #1515（threads=1）、崩溃预警 #1517（断言 ⑮ 已上线）。

## 0. 用户拍板（2026-11-06）

| 决策 | 结论 |
|---|---|
| 增量策略 | **delete+insert by bizday**（同日多次采集重写幂等；不用 append） |
| 10 分钟档范围 | **只 `fct_retail_sale`**（销售明细口径模型）；其余派生表留在小时/全量档 |
| 一次性全量物化时点 | 今晚 00:00 后（与夜间回填窗口协调，见 §4） |

## 1. 现状（2026-11-06 实测）

- 30 个 `materialized='table'` 全量重建 + 24 个 view，**零 `is_incremental`**。
- 物化 job：`27 3,7,9,11,13,15 * * *` UTC（CST 11:27/15:27/17:27/19:27/21:27/23:27），单轮 45–120 分钟（threads=1）。
- 采集：`retail.tick.l1` = `*/5 8-23`；其余报表类 = `14,16,18,20,22`（每 2h）。
- 夜间回填：`00:05–09:00`，队列 18 条真实任务（2026-11-06 首跑）。

## 2. 波次

### W1（今晚）：`fct_retail_sale` 增量 + tick 构建
1. `fct_retail_sale.sql` 改 `incremental` / `delete+insert` / `unique_key=[system_book,bizday,branch_num]`。
2. 末尾加 `is_incremental()` 过滤：`bizday >= (select max(bizday) - interval '7 days' from {{ this }})`。
3. `materialize.sh` 加 `MATERIALIZE_SCOPE=tick`：只跑 `dbt build --select fct_retail_sale`，落 `fct_retail_sale` 水位。
4. 采集排班：`retail.tick.l1` → `*/10 9-23`（两账套）。
5. 新增 openship job `lemeng-dbt-tick`：每 10 分钟（CST 9–23）跑 tick 构建，排在采集后 2 分钟。
6. 全量档 `--exclude fct_retail_sale`：tick 拥有该模型，两档并发写同一张表会冲突；全量档也不再给
   它写 `data.load_log` 水位（否则 `data_as_of` 假前进）。tick 档自己写。
7. 首次 `--full-refresh --select fct_retail_sale`：见 §4 时点。
8. **基面下推（#1524）**：`gen-fct-measures.mjs` 对 `incrementalLookback` 模型在 `base_sale` /
   `base_return` CTE 内加 7 天 lookback —— 只放最终 SELECT 会「先扫全史再过滤」，首轮 tick 实测
   5+ 分钟；下推后 read_parquet 走 bizday 分区裁剪，目标 <2 分钟。
   ⚠️ 下界必须用 `incremental_cutoff()` 渲染成**编译期日期字面量**（`select max(bizday)` 子查询
   计划期不是常量，DuckDB 仍不裁剪——2026-11-06 实测第二轮仍 5+ 分钟）。

### W2（W1 稳定后）：其余日粒度 fct 改增量
- 按 spec §3/§10：P2 的 13 张日粒度 fct；全量 build 目标 <5 分钟。
- 之后才把全量 job 从每 2h 提到**每小时**（用户要的“其他每小时”）。

### W3：采集排班小时化
- 报表类 L0 从 `14,16,18,20,22` 改 `0 9-23`（每小时），逐源核对 429/频率闸后再上。

### W4：验收
- 每个 fct 的 `data_as_of` 水位、行数与源端对账、pg_duckdb 内存峰值、连续两天无 `signal 11`。

## 3. 验收判据（W1）

1. 首次 full-refresh 前后 `fct_retail_sale` 的 `count(*)` 与 `sum(sale_amount)`/`sum(net_amount)` **逐分相等**。
2. 增量跑一轮后：`group by (system_book,bizday,branch_num) having count(*)>1` = 0 行。
3. tick 构建单轮 <2 分钟（目标；实测记录进本文件）。
4. tick 构建后 `data.load_log` 的 `relation='fct_retail_sale'` 水位前进。
5. 连续 2 天 10 分钟档无 `signal 11`、无重叠 dbt 容器。
6. 回滚：`fct_retail_sale` 改回 `materialized='table'` + `dbt build --select fct_retail_sale --full-refresh`。

## 4. 今晚全量刷新的窗口（待协调）

夜间回填 job 首跑 **00:05–09:00**（队列表 18 条真实任务），与“00:00 后”直接冲突。候选：

- **A（推荐）**：今晚 23:50 先跑 `fct_retail_sale` 的 full-refresh（单表，预计几分钟），00:05 回填照常；若 23:50 时 21:27 那轮物化仍未结束，则顺延。
- **B**：今晚停一次回填（`custom:CvexD6UoamwjqbjO` 临时禁用），00:00 跑 full-refresh，跑完再启用；代价是回填少一晚。
- **C**：full-refresh 放到回填结束后的 09:00 之后。

> 选定后把本条改为“已执行 <时间> / 结果”，并记录前后对账数字。

## 5. 小时窗口对账档（#1619，2026-11-07 落地）

**做了什么**：`dbt/macros/window_read_parquet.sql`（湖读取窗口/全史双模）+ 9 条核心
audit 打 `tag:audit_window` + `materialize.sh` 新增 `hourly` 档。

**关键约束（全部真机实证，改动前必看）**：

| 约束 | 为什么 | 违反的后果 |
|---|---|---|
| 宏只能输出**裸 `read_parquet(...)` 函数调用** | 本栈取列必须 `from read_parquet('…') r` + `r['列']`，别名挂函数上 | 包一层子查询 ⇒ `cannot subscript type record`，9 条全灭 |
| 宏体内**不能有 `if/endif` 控制流块** | dbt 1.9 解析器报「block definition inside control flow」 | 整棵树编译失败（开跑即挂） |
| 路径窗口用**单个**融合月段字符类 glob | 多 pattern union 与上一条冲突；按天 union 219s+ 比全史还慢 | 无可行解 |
| **窗口起点 = today−7**（增量 lookback），不是月初 | 增量 mart 只重建最近 7 天，更老分区是建表快照 | 源头重述后老分区必然假红（实测 transfer 2260 条全落在 10-01..10-27） |
| mart 侧也必须同窗（`window_start_date()`） | 否则 full join 出 13 万条「recheck NULL vs 物化有值」 | 假红 |
| dbt 选择器并集用**空格**，不是逗号 | dbt 1.9.1 把逗号当**一个字面 criterion** | select 报错 / exclude 静默 no-op |
| hourly 必须 `--exclude tag:audit` | eager 间选把 ref() 被选模型的 singular test 全拖进来 | 46 条全史对账混进小时档（实测 133 节点） |

**实测数字（2026-11-07）**：
- 单串字符类：day 腿 1.07s / hour 腿 5.66s（全史 206s）
- 9 条窗口 audit 耗时：branch_net 2.87s、loss 3.15s、purchase 3.43s、request 3.74s、
  member 4.28s、outbound 9.39s、inventory 9.98s、**retail net_quantity 62.40s**、
  transfer item_gross_margin_rate 1.21s（窗口收窄后）
- 整轮 hourly：15 个增量模型 + 93 个 data test，约 14 分钟（模型 ~9 分钟，重头是
  `fct_order_event` 170s / `fct_retail_item_sale` 285s / `fct_retail_quantity` ~100s）

**已知遗留**：`fct_retail_item_sale` 读零售热小时与 10 分钟采集构成 ETag 竞态
（今日三轮里两轮 285s ERROR、一轮通过）⇒ issue #1620（热腿只读已封版小时）。
