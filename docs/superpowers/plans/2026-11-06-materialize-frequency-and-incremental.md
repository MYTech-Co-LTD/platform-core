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
6. 首次 `--full-refresh --select fct_retail_sale`：见 §4 时点。

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
