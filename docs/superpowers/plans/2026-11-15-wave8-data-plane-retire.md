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

### 运行时基镜像决定（2026-11-15，用户拍板方案 1）

`deploy/Dockerfile.server` 的 runtime 由 `node:22-alpine` 换 **`node:22-bookworm-slim`**（glibc），
在其中装 `dbt-core==1.9.1` + `dbt-postgres==1.9.1`（与 `deploy/dbt/Dockerfile` 同版本、同阿里云源）。
**验证门槛**：全仓测试 + 镜像体积对比 + 容器内 `dbt --version` + `data.dbt_tick` 手动跑与宿主 `/opt` 输出比对。
未过门槛不回退到 Alpine 多阶段，也不切流。

---

## 2026-11-20 重分档（W4 物理拆分后）

> **背景**：W4 把执行器拆成两个实例——`scheduler-platform`（应用单元 f225d818）与
> `scheduler-data`（数据单元 8281d598）。调度器**运行在容器里、没有 docker socket**。
> 因此原计划里「③ 平台/运维类全部进平台 scheduler」对其中一半不成立：它们是**宿主机脚本**
> （`sh /opt/…` + `docker exec <console>`），搬不进容器。
> 详见 `deploy/deployment-units.md` §5（生命周期分层）与 `deploy/external-contracts.md`。

### 已完成（截至 2026-11-20）

`data.dbt_tick/hourly/tables/audit_a1/a2a/a2b/audit_window`、`data.semantics_sync`、
`data.archive_private_measures`、`data.publish_dims`、`data.monitor_tick` 均已在平台调度器；
`month-compact` 归 duckle console 排班。

### 剩余项的新落点

| 原档 | 剩余 job | 新落点 | 理由 |
|---|---|---|---|
| P1 dbt | `lemeng-recon-restate` | **C：受阻**（checkpoint 旁路） | 其余依赖都可容器化（psql + console HTTP），但「清 console 引擎状态」那步只能 `docker exec`，见上文调查与三选一 |
| P1 dbt | `lemeng 夜间回填窗口` | **A：留守 openship** | 依赖宿主机 `/opt` 脚本与多容器编排；容器化收益低、风险高 |
| P2 平台/运维 | `lemeng-console-gc`、`lemeng-gc-hot-hours` | **A：留守 / 等 console 自己的 GC 通道** | 见下方「逐条实测判定」——两者都直接读写**宿主卷路径**，容器内看不见 |
| P2 平台/运维 | `删已封版日子小时对象` | **C：已迁**（`data.hour_partition_gc`，#2563） | 只需 ZOS 凭据 + HEAD；调度器容器两样都有，实测 dry-run 一致 |
| P2 平台/运维 | `askdata-loop-p1` | **A：留守** | 入口是宿主 `sh /var/lib/askdata/sync-and-run.sh`：读宿主卷路径 + `/etc/openobserve-ingest.env` + python3，容器内三样都没有 |
| P2 平台/运维 | `demand-mining-shanhai` | **C：受阻**（#2560） | 调度器容器**没有 OO 读凭据**（`OO_AUTH` 是摄取凭据，读端点 401）⇒ 三选一待拍板 |
| P3 判据化 | `pipeline-scorecard-3120/64188`、`pipeline-monthly-review`、`日更件零行巡检` | **④：转 OO 规则 / `data.monitor` 判据** | 先接通告警出口、跑满一个周期，再关 openship job |
| P3 判据化 | `verify-ingest-shanhai`、`verify-regression-shanhai`、`叙事质量探针` | **④：同上** | 判据化后保留手动触发入口作为排障 |
| P3 判据化 | `平台↔仓库接线探活（Gate-B / search_path）` | **④：已跨机改写并稳定绿**，作为首个判据化样本 | 2026-11-19 后改为跨机口径，不再依赖同机 docker 网络 |
| P4 收口 | 其余宿主机脚本（host-metrics / OO 桥·看门狗 / 机脚本投递 / 预警对账） | **A：留守清单** | W4 后仍必须留在 openship（跨机 exec 与 OO ingest） |

### 逐条实测判定（2026-11-20 晚，取代上表的「待评估」）

判据：**容器里有没有它要的那几样东西**（凭据 / 宿主卷 / python）。三样缺一就归 A，不硬迁。

| job | 它要什么 | 调度器容器有没有 | 判定 |
|---|---|---|---|
| `删已封版日子小时对象` | ZOS 五键 + python3 + HEAD | ✅ 五键在 env、python 3.11、脚本在镜像 `/app/scripts/lemeng/` | **C 已迁**（#2563）；容器内 dry-run 实测输出一致 |
| `demand-mining-shanhai` | `DATABASE_URL` + OO **读**凭据 | ⚠️ DB 有；**读凭据没有** | **C 受阻**（#2560） |
| `askdata-loop-p1` | 宿主卷 `…openclaw_state/_data` + `/etc/openobserve-ingest.env` + python3 | ❌ 三样都不可见 | **A 留守** |
| `lemeng-console-gc` | console 卷的**宿主路径** + `docker exec duckle cache clear` | ❌ 跨容器删卷 | **A 留守**（等 console 自己出 GC 端点） |
| `lemeng-gc-hot-hours` | `docker exec console printenv ZOS_*` + 遍历 console state | ❌ 同上 | **A 留守** |

> **凭据实测细节（#2560）**：数据单元 `OO_AUTH`（长 52）对 `/streams`、`/data_alerts`、`/organizations`
> 全 **401**；应用单元 `OO_READ_TOKEN`（长 88）同路径 **200**。⚠️ 但这**不是缺陷**——
> `alerts*.json` 里那条 `data_alerts/_json` 是 **OO 的 JSON 摄取端点**（写事件进流），
> `OO_AUTH` 就是**摄取凭据**，读端点 401 是正常表现。结论只是「调度器容器缺读凭据」。

### 部署面缺口：改 registry 不进调度器镜像（#2561）

调度器跑在**数据单元**，但 `deploy-data` 的触发面原先只看 compose/duckle/dbt/`scripts/lemeng/`——
**`apps/server/src/scheduler/` 与 `scripts/*.mjs` 都不在**。改 `JOB_REGISTRY` 或 job 脚本 ⇒
应用单元照常发版、**数据单元调度器仍是旧镜像**，且没有任何红灯。

已在 #2561 / PR #2562 修：触发面加 `^apps/server/src/scheduler/`，并把 registry 里 `script: '…'`
清单与本次改动文件求交集（逐个精确比对，不靠 `^scripts/` 前缀猜）；读不到 registry ⇒ 按命中处理。

### 一次性 job 清理（待办，不在本波实施）

大量 `custom:*` 一次性 job 仍 `enabled`（含 `sleep N` 定时探针、`数据面 sync <旧 sha>`、
npm/pnpm 实验）。**风险**：误触发旧 sync 会回滚数据面。建议单独做一次清理：
按 `scheduleType=manual` + 标签模式（`一次性`、`sync <sha>`、`实验`）批量 `enabled=false`，
保留冒烟类（platform-core / salary / 过款助手）与排障入口。

### 验收（本条重分档）

- 每迁一条：平台首跑输出与 openship 最近一次一致；openship 侧 `enabled=false` 且无新 run。
- ④ 每条：真实/模拟故障至少演练一次报警，再关 job。
- P4：出「留守清单」，每条一句话说明为什么留。

---

## 2026-11-20 下午追加：recon-restate 迁移调查 + 一次性 job 清理实况 + 留守清单

### recon-restate 迁移调查（C 类，非快活——先看这份再动手）

现役 `/opt/lemeng-recon-restate.sh`（128 行）+ `/opt/lemeng-recon-day-heal.sh` 的**全部宿主依赖**：

| 依赖 | 用在哪 | 容器内替代（候选） |
|---|---|---|
| `docker exec pg_duckdb psql` | 台账粗筛（staging.recon_run 候选日） | scheduler 容器直连 `DATA_WAREHOUSE_URL`（已验证 psql 在）——**零改造** |
| `docker inspect console` 取 env | 逐账套取 `LEMENG_TOKEN`/`ZOS_*`（不落 argv） | scheduler 自身 env **已有** `LEMENG_TOKEN` / `LEMENG_TOKEN_64188` / `ZOS_*`（数据项目 env 实测在位）——改名读取即可 |
| `docker exec console sh -c PRUNE_SNIPPET` | 旁路失效 checkpoint（state 目录剪枝） | **无直接替代**——state 是 console 容器内文件系统；console HTTP API 无此面 |
| `docker exec console python3` 读 run_results glob | 复验判据 | artifacts 服务已暴露 runs/ 只读（#2519）——**读侧可替代** |

⇒ 真正的堵点是 **checkpoint 旁路（写 console state）**。三选一，需人拍板：
1. 给 console 加一个受 token 保护的 state-prune HTTP 端点（改 duckle 侧，最优但动引擎面）；
2. 保留该步在 openship（recon-restate 拆两半：候选+复验进平台，prune 留宿主）；
3. 挂 console workspace 卷进 scheduler（只读不够，要写——跨容器写 state 风险高，不推荐）。

**在拍板前 recon-restate 留守 openship**，进下方清单。凭据问题的好消息：scheduler env 已有两账套 token，
迁移后「运行时现取」的语义可以保住（从自身 env 取，一样不落 argv/日志）。

### 一次性 job 清理（2026-11-20 已执行）

**已停用 42 个危险一次性 job**（`enabled=false`，可逆）：全部 `数据面 sync <旧sha>`（28）+
`mytech-data-plane-sync`×5 + `控制面数据面 sync` + `mytech-data-plane-prep` + `mytech dockerd 代理` +
item_price 定时探针×5（`sleep N; docker exec console …`）+ `数据面验证`×2。
动机：旧 sync 误触发 = **回滚数据面**；探针误触发 = 对 console 容器 exec。
**保留**：42 个无害一次性（取证/实验类，manual 触发无破坏面）+ 全部周期 job + 冒烟类
（platform-core / salary / 过款助手部署冒烟）。

### P4 留守清单（openship 上为什么还有这些 job）

| job | 为什么留 |
|---|---|
| `host-metrics` / `infra-health-check-to-openobserve` / OO 桥·看门狗·机脚本投递·预警对账 | ⑤ 类：跨机 exec + OO ingest，天然宿主面 |
| `lemeng 夜间回填窗口`（00:05） | 宿主机 /opt 脚本 + 多容器编排；容器化收益低风险高（A 类） |
| `lemeng-recon-restate`（23:25） | checkpoint 旁路无容器内替代，见上方调查；拍板后迁（C 类待议） |
| `lemeng-console-gc` / `lemeng-gc-hot-hours` / `删已封版日子小时对象` | 操作 console 容器卷/宿主文件；待 console GC 通道评估（C 类候选） |
| `askdata-loop-p1` / `demand-mining-shanhai` | 只依赖 HTTP/DB，**可迁**（C 类）——排在 restate 之后 |
| `platform-core / salary / 过款助手 部署冒烟` | 手动触发的验收入口，保留 |
| `pipeline-scorecard-*` / `monthly-review` / `verify-*` / `零行巡检` / `叙事质量探针` / Gate-B 探活 | ④ 判据化队列（转 OO/data.monitor 后才关）；Gate-B 已跨机绿，作首个样本 |
| openship 内置（备份/GC/DNS/证书/reconcile 等 ~25 个） | 平台自身职能，不属于 Wave 8 范围 |
