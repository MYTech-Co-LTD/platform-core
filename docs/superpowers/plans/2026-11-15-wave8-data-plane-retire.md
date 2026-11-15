# Wave 8 · 数据面定时任务「消」Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 把 openship 上剩下的**数据面周期任务**清走：采集类归 duckle console 自己的排班，dbt/词表/维表/agent 类落**平台 scheduler**，`scorecard`/`verify-*` 变成**观测面判据**；openship 只留基建定时（host-metrics / OO 桥·看门狗 / integration-probe 心跳）。

**Architecture:** 不新建调度器。平台侧的活复用 Wave 6 的 `platform.scheduler`（registry key + tick + 心跳 + `jobs.job.*` 事件）；duckle 侧的活复用 console 已有 `/api/schedules`（每租户 console 自己驱动）。**同一个 job 任一时刻只有一个调度者**。

**Spec:** `docs/superpowers/specs/2026-11-14-business-scheduler-design.md` §15（Wave 8）；路线图 §4 Wave 8。**issue #2329**。

## 盘点结果（2026-11-15 实测）

- openship：163 个 job，其中周期 job ~70。
- duckle console：3120 35 条排班、64188 33 条（仅 `retail_order_line.daily_sealed.reconcile` 停用），已覆盖全部 L0 采集族与 `retail.tick/windows/close`。
- **关键缺口**：`dbt` 运行（hourly/tick/tables/audit-a1/a2a/a2b/month-compact/recon-restate/夜间回填）**没有 duckle 替代**——console 只调度 duckle 管线，不跑 dbt。

## 分档

| 档 | 代表 job | 落点 |
|---|---|---|
| ① 已有替代 | `lemeng-dbt-hourly`、`lemeng-dbt-tick` 驱动的采集对象 | **duckle console 排班**（不需新建） |
| ② 需建替代（dbt 类） | `lemeng-dbt-tables`、`audit-a1/a2a/a2b`、`month-compact`、`recon-restate`、`夜间回填窗口` | **平台 scheduler**：新增 `data.dbt_*` key，脚本沿用现有 `scripts/lemeng/materialize.sh` / dbt 入口，复用超时/重试/心跳/jobs 事件 |
| ③ 需建替代（平台/运维类） | `L1 词表物化`、`维表发布`、`askdata-loop-p1`、`demand-mining-shanhai`、`archive-private-measures-shanhai`、`lemeng-console-gc`、`gc-hot-hours`、`删已封版日子小时对象` | 平台 scheduler（`data.*` key）或 console 的 GC 通道；逐个定 |
| ④ 判据化 | `pipeline-scorecard-3120/64188`、`pipeline-monthly-review`、`verify-ingest-shanhai`、`verify-regression-shanhai`、`日更件零行巡检`、`叙事质量探针`、`平台↔仓库接线探活` | **观测面判据**（OO 规则 / `data.monitor` 判据），不再当 job 跑 |
| ⑤ 永久留守 | `host-metrics`、OO 桥/看门狗/机脚本/预警对账、`integration-probe 心跳`、`infra-health-check-to-openobserve`、openship 内置备份/GC/DNS/证书 | **openship 不动** |

## Global Constraints

- **切流铁律**（沿用 Wave 6）：一个 job 任一时刻只有一个调度者；先登记 → 手动跑一次比对 → 关 openship → 再开。
- **判据化不是删监控**：④ 的每一条必须先有 OO 规则或 `data.monitor` 判据接住，才能关 openship job。
- **dbt key 的 `expectedIntervalSecs` 取周期最大间隔**（周级 cron 写 604800，否则假红）。
- 脚本有 dry-run 默认值时，`JobDef.args` 必须显式给生效参数（`org.sync` 教训）。
- 生产排班变更前必须出计划评审；测试夹具 `w8-*`。

## 实施波次

### P1（dbt 落点，最高价值）
1. 在 registry 增 `data.dbt_tick` / `data.dbt_hourly` / `data.dbt_tables` / `data.dbt_audit_a1` / `data.dbt_audit_a2a` / `data.dbt_audit_a2b`，分别包现有脚本（参数与原 openship job 逐字一致，含 timeout/retry）。
2. 迁移 `month-compact`、`recon-restate`、`夜间回填窗口`（同一形态）。
3. 每条：seed 为 disabled → 手动 run 比对输出 → 关 openship → 开闸。

### P2（③ 平台/运维类）
逐条决定落点；`console-gc` / `gc-hot-hours` 若与 duckle 工作区相关，优先走 console 的 GC 通道而不是平台 scheduler。

### P3（④ 判据化）
1. 为 scorecard/verify/零行巡检定义判据（OO 规则或 `data.monitor`），**先接通告警出口**。
2. 判据生效并跑满一个周期后，再关 openship job。

### P4（收口）
- openship 剩余 job 只剩 ⑤；出「留守清单」并写进运维文档。
- 路线图 §7 入账。

## 验收

- 每档：openship 侧 job `enabled=false` 且不再产生新 run；替代面首跑输出与 openship 最近一次比对一致。
- ④：判据在真实故障/模拟故障下能报警（至少一次演练）。
- ⑤：仍在 openship 正常跑，且有「为什么留」的一句话说明。

## 风险

- dbt 落平台后与 duckle console 抢占同一湖/同一 staging：必须保持「一个 job 一个调度者」，且时间段不重叠（沿用现有 CST 窗口）。
- `dbt-materialize` 当前停用（OOM 遗留），迁移时不要顺手开；等存量重型 table 改增量后再定。

## 落点决定（2026-11-15，用户拍板）

dbt 类任务落**平台 scheduler + 镜像内 dbt 工具链**（选项 1）：
- `deploy/Dockerfile.server` 增 dbt（python venv / dbt-core + 所需 adapter），把现役 `/opt/lemeng-materialize.sh` 的逻辑收进仓内脚本（例如 `scripts/lemeng/materialize-job.mjs`，参数走 env），容器内以 `/app/dbt-target` 与 `DATA_WAREHOUSE_URL` 运行。
- registry 新增 `data.dbt_tick` 等 key，cron/timeout/retry 与 openship 现役逐字一致。
- 验证：同一 scope 在容器内手动跑一次，产物/输出与宿主 `/opt` 版本比对一致后，才进四步切流。
- 否决：宿主执行通道（扩大攻击面）、dbt 留守 openship（Wave 8 目标落空）。
