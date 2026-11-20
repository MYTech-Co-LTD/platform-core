# 部署安全化：让「代码变更」不再重启正在跑作业的执行器

> 状态：**提案，待拍板**（2026-11-20）。拍板后按 `docs/standards/dev-discipline.md` 走 issue → PR。
> 前置事实见 #2567 / #2569 / #2572（排空围栏已上线并实测）。

## 1. 问题（都是同一条链路）

| 证据 | 数值 |
|---|---|
| 2026-11-20 被部署砍掉的作业 | 3 条 `data.dbt_hourly`（01:05 / 03:05 / 05:05，全 `dur=0s`） |
| 单元拆分前 3 天 | 40 次部署 / 13 次 dbt 作业被收成 timeout |
| 单次 hourly 时长 | ~17 分钟；tables ~39 分钟；审计 40–90 分钟 |
| 容器被停时的宽限期 | **10 秒**（openship 未把 `stop_grace_period` 传给 Docker，`HostConfig.StopTimeout=None`） |

链路：**改 `dbt/` 或 `scripts/` → CI 触发数据单元部署 → scheduler 镜像重建 → 容器重建 → 在跑的子进程被 SIGKILL**。

今天已上的「排空围栏」（#2569）把这条链路的伤害面压到「部署窗口内不新起作业」，但**没有改变「容器必须重启」这件事**：
围栏只是让重启变得更安全，没有让重启变得不必要。

## 2. 目标 / 非目标

**目标**：让「改 dbt 模型 / 改脚本 / 改契约」这类**高频变更**不再需要重建并重启执行器容器。
**非目标**：不追求「零重启」——改调度器自身代码（`apps/server/src/scheduler/`）时重启是应该的。

## 3. 方案

### 方案 A（大）：派发 / 执行进程拆分

```
scheduler（派发器）  claim → 建台账 → 心跳 → 健康         ← 随时可重启，容器里没有作业
executor（执行器）   接活 → spawn 子进程 → finishRun       ← 只在「执行器运行时」变更时重建
```

- 交接可选：DB 队列（`job_run` 增加「已派发」态）或本地 HTTP。
- 收益：**任何**代码变更都不影响在跑作业；`dbt/`、`scripts/`、`registry` 全部免疫。
- 成本：迁移 + 新服务 + claim/finish 语义改造 + 故障模型（执行器重启 ⇒ 子进程随之消失，仍需 reap）。**约 2–3 天**，需要一份完整 spec。

### 方案 B（小）：代码挂载 + 部署子集 —— **推荐先做**

两个已具备的事实让这件事比看起来简单：

1. `dbt/`、`scripts/`、`contracts/` 都是**运行时读取**的（`pnpm exec tsx scripts/x.mjs`、`dbt build -s ...` 在 spawn 时才读文件），
   所以把它们从「镜像内容」改成「挂载内容」后，**文件更新即生效，不需要重启进程**。
2. openship 的数据项目在宿主上有固定 checkout（`/opt/platform-core-data/platform-core`），
   `data-compose.yml` 的 `dbt` 服务已经这么挂（`/opt/.../dbt:/usr/app:ro`）——**同一个模式，不是新机制**。

做法：

```yaml
# deploy/data-compose.yml · scheduler
volumes:
  - dbt-artifacts:/app/dbt-target
  - /opt/platform-core-data/platform-core/dbt:/app/dbt:ro
  - /opt/platform-core-data/platform-core/scripts:/app/scripts:ro
  - /opt/platform-core-data/platform-core/contracts:/app/contracts:ro
```

CI 侧：当本次变更**只**触及 `dbt/ | scripts/ | contracts/` 时，数据单元部署仍然跑
（要更新宿主 checkout），但 `serviceIds` **不含 scheduler**（例：只重建 `artifacts` 这种无状态服务）。

- 收益：改模型/脚本 → **执行器容器不动**、作业零影响；部署耗时也从「重建镜像 ~6–10 分钟」变成「同步代码 + 重建无状态服务」。
- 成本：约 **0.5–1 天**（compose + CI 判定 + 一次实测）。
- 风险与未验证点：
  - openship 是否允许「部署但不重建任何业务服务」——用重建 `artifacts` 绕开，无需它支持空集；
  - 宿主路径耦合（换机时必须同步改）；这正是 `dbt` 服务今天已经在承担的耦合，不是新增；
  - 镜像里仍保留副本（挂载只覆盖），所以挂载失效时会**静默回落到镜像旧代码** —— 必须加一条启动自检。
    **实现采用「设备号」判据**（比原提案的 `.deployed_sha` 比对更便宜也更硬）：bind mount 的
    `st_dev` 与容器 `/app` 必然不同；`scripts/ | dbt/ | contracts/` 任一与 `/app` 同 `st_dev`
    就说明没挂上，启动即打 `codeMountWarning`（点名目录 + 影响），不静默。

### 方案 C（现状）：只靠排空围栏

- 成本：已完成。
- 局限：部署仍会重建容器；围栏只保证「没有作业在跑时才重建」。

## 4. 对比

| | A 进程拆分 | **B 挂载 + 子集**（推荐先做） | C 仅围栏（现状） |
|---|---|---|---|
| 改 `dbt/`/`scripts/` 是否影响作业 | 不影响 | **不影响** | 不影响（但会短暂停机 + 依赖围栏） |
| 改 `registry` 是否影响作业 | 不影响 | 影响（需重启，量少） | 影响 |
| 部署耗时 | 不变 | **显著下降**（无镜像重建） | 不变 |
| 工作量 | 2–3 天 + spec | **0.5–1 天** | 0（已完成） |
| 新增故障面 | 交接语义、双进程健康 | 挂载路径、静默回落 | 无 |

## 5. 推荐路径

1. **先 B**：吃掉最高频的变更（dbt/scripts/contracts 占部署的绝大多数），并顺带把部署耗时降下来。
2. **观察 2 周**：统计「因 scheduler 自身代码变更而重启」的次数。若仍频繁（≥1 次/天），再做 A；
   否则 A 可以长期不做——**围栏 + B 已经覆盖现实风险**。
3. A 与 B 不冲突：A 落地后 B 仍然有价值（挂载让执行器镜像变更更少）。

## 6. 验收判据（B）

1. 只改 `dbt/models/...` 合入 main ⇒ `docker inspect` 的 scheduler `.State.StartedAt` **不变**；下一个 hourly 正常跑。
2. 只改 `scripts/lemeng/...` 合入 main ⇒ 同上，且新脚本在下一次 job 运行时生效（验证方式：让该 job 打印自身文件 mtime 或版本）。
3. 挂载失效演练：临时把宿主目录改名为空 ⇒ 启动自检**响亮告警**（不静默跑镜像旧代码）。

## 7. 未决问题（拍板时需要定）

- 宿主路径写死在 compose 里，换机时是否接受同步修改？（`dbt` 服务已在承担，默认接受）
- `contracts/` 挂载是否需要 `:ro`？（建议是，契约是只读资产）
- 是否需要「先 B 后 A」写成两个 issue，还是合成一条路线图？
