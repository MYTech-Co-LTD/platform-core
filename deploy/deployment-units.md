# 部署单元：现状、边界、以及平台缺的那块能力

> 2026-11-19 实测沉淀。**只写验证过的**；没验过的标「未验证」。
> 接入细节在 `openship-adopt.md`，迁移代价在 `server-migration-runbook.md`，本文只谈**单元怎么切**。

## 1. 现状（一台机 × 一个 openship project = 一个部署单元）

| 单元 | openship project | 主机 | 服务 | 谁触发部署 |
|---|---|---|---|---|
| 应用单元 | `platform-core-shanhai` | `f225d818` / 10.0.0.3 | postgres、server、notify-worker、openclaw（+sandbox-console） | **CI**（合 main） |
| 数据单元 | `platform-core-shanhai-data` | `8281d598` / 10.0.0.5 | pg_duckdb、scheduler、两个 lemeng console、artifacts | **CI**（数据面路径变更时） |
| case-engine | `case-engine-shanhai` | `f225d818` | mastra-app/worker/scheduler、redis、postgres | **CI**（case-engine 仓） |
| mytech | `platform-core` | `23a1091e` / 10.0.0.7 | postgres、server、notify-worker、sandbox-console | 手动 |

「单元」在本平台上有两个维度：**一份 compose 文件** + **一个 openship project**。这在单机上是够用的；
一旦想让**同一个 compose 里的某个服务**独立成为单元（独立构建、独立重启、独立回滚），就会撞墙。

## 2. 为什么 openclaw 拆不成独立单元（实测，别再试）

目标：让问数 bot（`openclaw`）独立部署，这样平台每次发版不会把它重建、企微长连接不被打断。

两条硬墙，都是平台能力边界，不是配置问题：

### 墙一：跨 project 复用网络 —— 被显式拒绝

```
POST/PATCH 服务行 advanced.networkMode
→ 400 VALIDATION_ERROR:
  network_mode: "openship-platform-core-shanhai" is not supported.
  Openship accepts "none", "service:<name>" (a service in this stack).
```

即：`networkMode` 只允许 `none` 或**本栈内**的服务。拆出去后 openclaw 解析不到 `server:13000`，
它的 `DATA_API_BASE` 就断了。

> 顺带一个降低风险的实测：bot 调平台用的是 `x-channel-key` + `x-wecom-userid`
> （`deploy/openclaw/data-query-plugin/lib.js`），**鉴权不依赖网络位置**。所以「换条路连过去」
> 在安全上可行——问题只是没有一条干净的路。

### 墙二：新 project 必须接管整份 compose —— 闸门挡住

新建 project 指向 `deploy/docker-compose.yml` 后，第一次部署被 compose 闸门拦下：

```
409 COMPOSE_REVIEW_REQUIRED
composeChanges.added = [postgres, server, notify-worker, mb-proxy, sandbox-console]
```

闸门按**整份文件**比对，它认为这些服务都是「新增」，接受就等于在**同一台机上再起一套平台**
（端口直接冲突）。平台没有「只同步某个服务」的视图。

### 结论

**在「不新增第三份 compose」（约束 B7）的前提下，openclaw 无法成为独立部署单元。**
物理拆分需要单独一份 compose（`deploy/bot-compose.yml`）+ 修订 B7 白名单 + 架构文档，
属于架构议题，**不是**改个配置能解决的。

## 3. 我们实际用的替代：定向部署

CI 部署应用单元时**现查服务清单**，默认只传除 openclaw 外的启用服务：

```bash
SERVICE_IDS=$(curl -sS -H "Authorization: Bearer $TOKEN" \
  "$OPENSHIP_URL/api/projects/$PROJECT_ID/services" \
  | jq -c '[.services[]? | select(.enabled != false) | select(.name != "openclaw") | .id]')
# POST /deployments { projectId, branch, commitSha, environment, serviceIds }
```

只有在变更触及下列路径时才带上 openclaw：
`deploy/openclaw/**`、`deploy/Dockerfile.openclaw`、`deploy/docker-compose.yml`。

**为什么 serviceIds 现查而不是写死**：服务行重建后 id 会变，写死等于埋定时炸弹。
查不到清单就**退回全量部署**——宁可多重启一次 bot，也不能因为查不到而不部署。

### 实测判据（唯一可信的那种）

看容器启动时刻，不看 CI 状态：

| 时间 | server | notify-worker | openclaw |
|---|---|---|---|
| 10:40 一次合并后 | 10:40:00 ✅重启 | 10:39:59 ✅重启 | **10:16:20 未动** ✅ |

### 边界（照实写，别当万能）

- **路径判定是猜**：只在上述三个路径变更时带 bot。如果将来 bot 依赖了仓内别处的共享代码
  （例如插件引用了 `packages/*`），判定就会漏 ⇒ bot 停在旧镜像。**目前不成立**（插件是自包含的）。
- **定向部署不减少构建**：被选中的服务仍会重建；它省的是「重启与切流」，不是构建时间。
- **共享一把部署锁**：bot 的部署与平台部署仍互斥（同 project），极端情况下会互相等待。
- **回滚粒度仍是 project 级**：没有「只回滚 bot」的一键操作。

## 4. 平台缺的三件事（上游需求）

按「有了它就能真拆」排：

1. **服务子集视图**：一个 project 能声明「我只管这份 compose 里的哪几个服务」，compose 闸门按子集比对。
   —— 这一条解决墙二，是硬前置。
2. **跨 project 网络接入**：`networkMode` 支持 `network:<name>` 或「外部网络」声明。
   —— 解决墙一；没有它，子集拆分后服务之间仍然连不通。
3. **compose 闸门的 dry-run 端点**：合并前就能问「这份 compose 会不会触发 409」。
   —— 今天只能在部署时发现，等于把一个可预检的问题放到发布路径上。

## 5. 生命周期分层与部署子集契约（2026-11-20，W4 后补）

### 5.1 事故证据（为什么需要这一层）

- **应用单元** 11-19 合了十几笔 PR，几乎每 15 分钟部署一次；每次部署都重建 `postgres`。
  数据单元的 scheduler 12 小时内记录 7 次 `pgPoolError: terminating connection due to
  administrator command`。后果不是「报错」而是**台账静默失真**：作业跑完了，但 `finishRun`
  写不进库 ⇒ 行卡在 `running` ⇒ 被 `reapStale` 收成 timeout（11-19 11:30 的 a2a、11:43 的
  publish_dims 就是这样变成假 timeout 的）。
- **数据单元** 只要 `dbt/` 有变更就整项目部署：实测 pg_duckdb / console 在 10:18 那次重启、
  scheduler 在 15:51 那次重启。正在跑的 hourly / audits（20–90 分钟）随执行器一起被杀。

⇒ 结论：部署的**爆炸半径**必须由「服务的生命周期类别」决定，而不是由「compose 文件多大」决定。

### 5.2 三类服务与重建规则

| 类别 | 应用单元 | 数据单元 | 何时重建 |
|---|---|---|---|
| 状态容器 | `postgres` | `pg_duckdb`、`lemeng-console-*` | 仅当自身镜像 / compose / 自身 env 变更 |
| 执行器 | `notify-worker` | `scheduler` | 仅当运行时代码（`apps/`、`scripts/`、`deploy/`）变更 |
| 交付面 | `server`、`openclaw` | `artifacts` | `server` 每次代码变更；`openclaw` 仅 bot 路径；`artifacts` 仅 `deploy/artifacts/` |

### 5.3 CI 派生规则（与本节同步维护）

- **应用单元**：默认 `serviceIds = 全部启用服务 − openclaw − postgres`；
  `deploy/openclaw/**`、`deploy/Dockerfile.openclaw` ⇒ 带上 openclaw；
  `deploy/docker-compose.yml` 变更 ⇒ 退回全量（含 postgres）。
- **数据单元**：默认 `serviceIds = [scheduler]`；`deploy/duckle/`、`duckle/`、`pipelines/`
  ⇒ 带上两个 console；`deploy/artifacts/` ⇒ 带上 artifacts；
  `deploy/data-compose.yml` 变更 ⇒ 退回全量（含 pg_duckdb）。
- **查不到服务清单 / 拿到空数组 ⇒ 退回全量并在日志里显式告警**（宁可多重启一次，不可漏部署）。

### 5.4 首批实测（2026-11-20，应用单元）

部署 `dep_z2g5kGqs4WEC3XH2`（commit `1875015b`，`targetServiceIds=[server, notify-worker]`）后，
容器启动时刻：

| 容器 | StartedAt | 结论 |
|---|---|---|
| `postgres` | `2026-11-19T16:13:59Z` | **未重启** ✅（状态容器） |
| `openclaw` | `2026-11-19T10:16:20Z` | **未重启** ✅（交付面，非 bot 路径） |
| `server` | `2026-11-19T16:56:15Z` | 重启 ✅ |
| `notify-worker` | `2026-11-19T16:56:15Z` | 重启 ✅ |

判据只看 `docker inspect .State.StartedAt`，不看 CI 绿灯、不看部署状态（两者都不证明「该重启的才重启」）。

### 5.5 边界（照实写）

- 服务行的 **env 变更不经部署生效**（走 openship 的 `apply-env`）；因此「排除 postgres」
  不影响 env 更新，但运维需知道改 env 后要单独 apply。
- **共享一把部署锁**、**回滚仍是 project 级**（见 §3 边界）。
- **运行中作业闸门已实现（2026-11-20，CI `deploy-data` 步骤内）**：触发部署前经 openship
  API 在 scheduler 容器里查 `platform.job_run` 的 `running` 行——有则每 60s 复查（上限 ~35 分钟），
  到点仍在跑 ⇒ **红掉部署**（fail-fast：杀掉 90 分钟审计比红一次部署贵；`gh run rerun` 即可重试）；
  闸门自身查不到状态（无 exec 权限 / API 故障）⇒ **响亮告警后放行**（闸门故障不能演变成
  「永远部不了署」）。应用单元不设闸门：其部署不再重启 postgres，platform 域作业都是秒级。
  **治本**仍是 dbt 挂载化（`dbt/` 变更不重启执行器），闸门只是过渡期止血。

### 5.7 派发 / 执行拆分（#2574 方案 A）

数据单元的调度拆成两个**角色**（同一镜像、不同入口）：

| 角色 | 服务 | 干什么 | 什么时候重建 |
|---|---|---|---|
| 派发器 | `scheduler` | claim、台账、心跳、健康、派发 | 任何调度器代码变更（**里面没有作业子进程，重建不影响在跑作业**） |
| 执行器 | `executor` | 收派发 → spawn → 写终态/重试/事件 | 执行时读的东西（`dbt/`、`scripts/`、镜像）变更；**重建前先排空** |

灰度开关：`scheduler` 的 `EXECUTOR_URL` 留空 = 本地执行（拆分前的行为）；置 `http://executor:13100`
= 派发模式。**这是回滚路径**，一个环境变量即可退回。

服务间令牌：两容器共享卷 `executor-auth` 里的文件（执行器首次启动自动生成 0600），
不需要人工写密钥。

**上线实录（2026-11-20，两个坑都已修，别再踩）**：

1. **新增服务必须与既有服务同批部署**：只给 `serviceIds=[scheduler]` 时，openship 仍会尝试拉起
   compose 里新出现的 `executor`，而它的镜像没被构建 ⇒ `Retained image ... is unavailable`（部署判失败）。
   现在 CI 的触发面与子集已按「执行器自己的代码」派生，正常不会再有这个错配。
2. **命名卷的属主只在「首次」从镜像继承**：镜像里预建 `/run/executor-auth`（属主 node）只对**新建卷**有效；
   卷已存在时不会重新继承 ⇒ `EACCES ... /run/executor-auth/token` 的重启循环。
   存量卷要一次性 `docker run --rm -u 0 --entrypoint sh -v <卷>:/v <镜像> -c 'chown -R 1000:1000 /v'`。
3. **HEALTHCHECK 端口**：镜像自带的探活打 `${PORT:-13000}`，执行器监听 13100 ⇒ compose 里
   `PORT` 与 `EXECUTOR_PORT` 必须**同时**给，否则容器 running 但恒 `unhealthy`。

**操作禁忌（2026-11-20 实测踩到）**：**部署窗口内不要手动重启调度器容器**。新容器启动会
无条件清掉 `drain` 信号（设计如此：能起来 = 部署已落地），而 CI 的部署还在构建 ⇒
信号被清 ⇒ 本该被挡住的作业被 claim ⇒ 构建完重建执行器时把它砍掉（当天 07:05 hourly 就是这么没的）。
要重启就先 `drain.sh wait` 等到空闲，或干脆等这次部署结束。

**已知边界（写在这里免得误解）**：拆分解决的是「派发器的 churn 不碰执行器」。
`dbt/`、`scripts/` 是执行时才读的代码 ⇒ 执行器要跑到新内容**仍需重建**，重建前后由 §5.6 的排空协议保护。

### 5.6 部署排空协议（手工部署也必须走，#2567/#2569）

闸门只保证「**触发那一刻**没有作业」，挡不住「构建那 5–10 分钟里新起的作业」——2026-11-20
一天内砍了三条 hourly（01:05 / 03:05 / 05:05，全是 `dur=0s` + 输出空的形态）。

容器侧「优雅停机」指望不上：`docker stop` 的宽限期由部署方决定，实测 openship 解析了
compose 的 `stop_grace_period` 却没传给 Docker（新容器 `HostConfig.StopTimeout=None`），
SIGTERM 后 **10 秒**就 SIGKILL。所以「别起新作业」必须发生在**部署之前**。

协议（CI 已内置；手工部署要自己做）：

| 步骤 | CI | 手工 |
|---|---|---|
| ① 等到 `running=0` | 闸门轮询 | `drain.sh wait 1800` |
| ② 落信号 `scheduler_control(key='drain')` | 闸门确认 0 后自动写 | `drain.sh set 45` |
| ③ 触发部署 | 自动 | 手动 |
| ④ 撤信号 | 新容器启动自动清（`schedulerDrainCleared`）；没触发则 CI `trap` 回滚 | `drain.sh clear`（部署没成时必须撤） |

手工部署的标准命令（在 scheduler 容器内，DB 凭据在那里）：

```sh
sh /app/scripts/ops/drain.sh set 45 && sh /app/scripts/ops/drain.sh wait 1800 && <触发部署>
```

实测（2026-11-20 13:28）：置信号后 2.7 分钟 `data.monitor_tick`（每分钟一次）**零条**，
心跳照写；删信号后 4 秒恢复 claim。**排空 ≠ 停摆**。

### 5.6.1 维护锁：闸门看不见「长 exec」（#2585）

闸门与排空信号都只看 `job_run`。而**历史回填、数据迁移**是直跑 exec（`sh scripts/lemeng/backfill-*.sh`），
**不写台账** ⇒ CI 会以为「没作业在跑」，照常部署，把跑了几小时的回填写到一半砍掉，且毫无征兆。

维护锁把「这段时间别部署」变成机器判据（同一个 `scheduler_control` 表，另一个 key）：

```sh
sh /app/scripts/ops/drain.sh lock 660 backfill-64188   # 落锁（分钟 + 原因，原因只允许 [A-Za-z0-9._-]）
sh /app/scripts/ops/drain.sh status                    # DRAIN / MAINTENANCE / RUNNING 三行
sh /app/scripts/ops/drain.sh unlock                    # 解除
```

- **CI**：`deploy-data` 在触发前查这一行，锁在 ⇒ **红掉不部署**（fail-fast，不白等 35 分钟）；
  窗口结束后 `gh run rerun` 即可。
- **长任务自己落锁**：`backfill-64188-history.sh` 开跑即 `lock 660`，`trap EXIT/INT/TERM` 收尾 `unlock`；
  锁不上不阻断回填，但日志里打 `MAINTENANCE_LOCK_FAILED`（此时必须人工盯部署）。
- 与排空信号的区别：**排空挡 claim，维护锁挡部署**。两者都带到期时间，忘了撤也不会永久生效。

## 6. 什么时候回来重读本文

- 想「把某个服务单独部署」时；
- 平台升级后（尤其 openship 1.x → 2.x），先**重试墙一**——它是最容易变的一条；
- 新增部署单元时：先在本表加行，再谈 CI 与监控（`docs/data-platform-handbook.md` §1.5.3 三层分工）。
