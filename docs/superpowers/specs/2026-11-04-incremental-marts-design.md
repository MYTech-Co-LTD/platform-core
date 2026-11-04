# marts 物化改增量：lookback 窗口 + delete+insert（设计）

> **状态：待用户 review（2026-11-04 起草）。** 按架构先行，review 通过后先改
> `docs/architecture.md` §dbt 层的物化策略，再开 issue 分阶段实施。
> 触发：2026-11-03/04 两次主机冻结，内核证据指向物化与回填叠加打穿内存。

## 0. 一句话

把 22 张 `materialized='table'` 的 marts 从「每 2 小时全量重建」改成
**「只重算最近 N 天 + delete+insert」**，把每轮内存峰值从 2–3 GB 压到几百 MB。

## 1. 现状与证据

### 1.1 冻结证据（`journalctl -k -b -1`，2026-11-04 08:55 重启前）

```
Nov 03 00:18  Memory cgroup OOM: Killed process (postgres) anon-rss:2.99GB
Nov 03 12:09  Memory cgroup OOM: Killed process (postgres) anon-rss:2.43GB
Nov 03 19:59  Memory cgroup OOM: Killed process (postgres) anon-rss:2.38GB
Nov 03 22:10  Memory cgroup OOM: Killed process (postgres) anon-rss:2.18GB
Nov 04 08:10  Out of memory: Killed process (duckdb) anon-rss:5.14GB
```
随后日志持续 `Under memory pressure, flushing caches` 直到人工重启。

- 前 4 次被杀的是 **pg_duckdb 后端**（`lemeng-dbt-materialize` 的 `dbt build`）
- 最后 1 次是 **duckdb**（库存快照 400 页回填）

### 1.2 当前 marts 体量（2026-11-04 实测）

| 表 | 大小 |
|---|---|
| `fct_inventory_snapshot` | 937 MB |
| `fct_retail_quantity` | 670 MB |
| `fct_request_fulfillment` | 52 MB |
| `fct_purchase` | 37 MB |
| 其余 | 14–21 MB |

### 1.3 为什么「回填结束后会更糟」

marts 的输入是**全湖**。回填把湖从约 40 天扩到 730+ 天，且还有 4,600+ 次日排在补：

- `fct_inventory_snapshot` 将从约 660 万行涨到 **约 2,000 万行**
- 每 2 小时一次的 `dbt build` 会对**全部 22 张表**做全量重算，峰值内存随数据量线性增长

⇒ 不做改动，回填完成后**必然还会 OOM**。

### 1.4 机器边界

`cpuCores 4 / memoryMb 7685`、swap 2 GB；同机还跑着 platform-core 生产栈、
console×2、metabase、openclaw、vector。**不能靠加内存解决**（成本与交付形态都不允许）。

## 2. 方案

### 2.1 形态

```sql
{{ config(
    materialized='incremental',
    unique_key=<见 §3 表>,
    incremental_strategy='delete+insert',
    on_schema_change='sync_all_columns',
) }}
```

增量过滤器统一收在模型末尾（只对已有表生效）：

```sql
{% if is_incremental() %}
where bizday >= (select coalesce(max(bizday), date '1900-01-01') - interval '<LOOKBACK>' from {{ this }})
{% endif %}
```

### 2.2 为什么是 `delete+insert` 而不是 `merge`

- 这些表都是**按自然键整行重算**（聚合结果），没有「部分列更新」的语义
- `delete+insert` 在 pg_duckdb 上是稳的；`merge` 对 DuckDB 表的支持面更窄
- 幂等：同一 bizday 重跑 = 删了再插，结果一致

### 2.3 为什么用 lookback 而不用「大于 max(bizday)」

**关键**：回填历史日期时，`max(bizday)` 早已是今天，历史日的补采**永远进不了 mart**。
lookback 窗口把「最近 N 天」整体重算，同时天然覆盖：

- 源端晚到（库存快照 T+2 才发布）
- 上游订正（同一天重采覆盖写）
- 回填（只要补的是窗口内的天）

> ⚠️ **边界**：补 **N 天以前**的历史时，必须显式指定窗口（见 §5 的
> `--vars '{lookback_days: 800}'`），否则 mart 不会更新。这是本方案唯一的操作纪律。

## 3. 逐表清单

| 表 | 处置 | unique_key | lookback |
|---|---|---|---|
| `fct_retail_sale` | 增量 | `(system_book, bizday, branch_num, order_no)` ※以实际三键为准 | 7 天 |
| `fct_retail_quantity` | 增量 | `(system_book, bizday, branch_num, item_num)` | 7 天 |
| `fct_inventory_snapshot` | 增量 | `(system_book, bizday, branch_num, storehouse_num, item_num)` | **7 天**（最大收益表）|
| `fct_branch_expense` | 增量 | `(system_book, bizday, branch_num, expense_type)` | 7 天 |
| `fct_client_expense` | 增量 | 按模型注释的自然键 | 7 天 |
| `fct_branch_indicator` | 增量 | `(system_book, bizday, branch_num)` | 7 天 |
| `fct_member_summary` | 增量 | `(system_book, bizday, branch_num, order_sale_type_name)` | 7 天 |
| `fct_loss_adjustment` | 增量 | `(system_book, bizday, branch_num, cause, direction)` | 7 天 |
| `fct_purchase` | 增量 | `(system_book, bizday, supplier_num, item_num)` | 7 天 |
| `fct_request_fulfillment` | 增量 | `(system_book, bizday, branch_num, item_num)` | 7 天 |
| `fct_transfer_item` | 增量 | `(system_book, bizday, item_num)` | 7 天 |
| `fct_hq_outbound` | 增量 | `(system_book, bizday, domain, branch_num, region_id, client_fid)` | 7 天 |
| `fct_outbound_region` | 增量 | `(system_book, bizday, channel_type, region_l1_bucket)` | 7 天 |
| `fct_contribution` | 增量 | `(system_book, bizday, domain, branch_num, region_id)` | 7 天 |
| `fct_client_contribution` | 增量 | `(system_book, bizday, client_fid)` | 7 天 |
| `fct_branch_day_activity` | 增量 | 按模型注释 | 7 天 |
| `fct_transfer_line_quality` | 增量 | 按模型注释 | **30 天**（质量判据看趋势）|
| `fct_transfer_zero_cost_item` | 增量 | 按模型注释 | 30 天 |
| `fct_purchase_concentration` | 增量 | `(system_book, bizday, item_department)` | **60 天**（**月度**粒度，窗口须覆盖当月+上月）|
| `fct_retail_comparable_growth` | **保持全量** | — | 涉同期窗口（可比增长），全量重算才保证跨年可比 |
| `dim_lemeng_branch` / `dim_lemeng_client` | **保持全量** | — | 快照型维度，体量小（<50MB）|
| `recon_fact` / `recon_break` / `recon_run` | **保持全量**（首批不改）| — | 对账结论表，窗口语义单独议，不在本 spec 范围 |

> ※ 表格里「按模型注释」的键，实施时逐个从模型头注抄，**不在这里猜**——
> 抄错键的后果是 `delete+insert` 重复插入（见 §6 验收 ②）。

## 4. 首次切换（一次性）

1. **确认唯一键真的唯一**（切之前先跑一次 `group by <key> having count(*)>1`，必须 0 行）
2. `dbt build --full-refresh --select path:models/lemeng/marts` —— 把现有 table 转成增量表
3. 记录切换前后每张表的 `count(*)` 与 `sum(关键金额列)`，**必须逐表相等**

## 5. 日常与回填两种驱动

| 场景 | 命令 | 效果 |
|---|---|---|
| 每 2 小时日常 | `dbt build`（不变）| 只重算最近 7 天 |
| 补 N 天前历史 | `dbt build --vars '{lookback_days: 800}'` | 全量重算一次 |
| 口径改动 / schema 变更 | `dbt build --full-refresh` | 重建 |

**`materialize.sh` 需要同步改**：把 `lookback_days` 作为可选 var 透传，默认 7。

## 6. 验收

1. **行数对账**：切换前后每张表 `count(*)` 相等（±0）
2. **唯一键**：切换后 `group by <key> having count(*)>1` 必须 0 行（防 delete+insert 重复）
3. **金额对账**：`fct_retail_sale.sale_money`、`fct_inventory_snapshot.inventory_money` 等
   关键金额列合计与切换前**逐分相等**（容差 0；不符即回滚）
4. **内存**：跑一轮 `dbt build`，`pg_stat_activity` 峰值 RSS 应 < 1GB（当前 2–3GB）
5. **耗时**：单轮应 < 5 分钟（当前约 20 分钟）
6. **回填可回读**：挑一个 30 天前的历史日，用 `lookback_days=800` 跑一次，该日数据进表

## 7. 回滚

- 任一模型出问题 → 该模型单独改回 `materialized='table'`，`dbt build --select <model>`
- 全量回滚 → 所有 `materialized='incremental'` 改回 `table` + `--full-refresh`
- 数据本身不受影响（湖是事实源，mart 随时可重建）

## 8. 风险

| 风险 | 缓解 |
|---|---|
| lookback 太短 → 晚到数据漏进 mart | 默认 7 天；库存快照类（T+2 发布）已覆盖；质量类 30 天 |
| 补历史时忘了加 `lookback_days` → mart 静默不更新 | 在 `materialize.sh` 里打印当前 lookback；回填脚本显式传参 |
| 唯一键抄错 → delete+insert 重复 | 切换前先断言唯一（§6 ②），CI 加一条 singular test |
| 首次 `--full-refresh` 又是一次全量峰值 | 放在**没有回填在跑**的窗口执行；必要时逐表 `--select` 分批 |

## 9. 不做什么

- 不改口径（B11）：本 spec 只动物化策略，不碰任何 mart 的 SQL 语义
- 不改 staging（已是 view，直读湖）
- 不引入外部调度器：仍由 `materialize.sh` + openship job 驱动

## 10. 分期

| 期 | 内容 | 门槛 |
|---|---|---|
| P1 | 最大的三张：`fct_inventory_snapshot` / `fct_retail_quantity` / `fct_retail_sale` | 单表验收全过 |
| P2 | 其余日粒度 fct（约 13 张）| P1 稳定 3 天后 |
| P3 | 月度表 + 质量类（lookback 60/30）| P2 稳定后 |
| 不做 | `fct_retail_comparable_growth` / 维度 / 对账表 | — |
