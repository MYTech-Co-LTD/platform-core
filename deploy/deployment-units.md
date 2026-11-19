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

### 5.4 边界（照实写）

- 服务行的 **env 变更不经部署生效**（走 openship 的 `apply-env`）；因此「排除 postgres」
  不影响 env 更新，但运维需知道改 env 后要单独 apply。
- **共享一把部署锁**、**回滚仍是 project 级**（见 §3 边界）。
- **运行中作业闸门尚未实现**（W2）：目前仍可能出现「数据单元部署杀掉在跑的长任务」。
  在那之前，数据单元部署应避开 10:25–16:00 的 dbt 排班窗口，或人为确认无长任务。

## 6. 什么时候回来重读本文

- 想「把某个服务单独部署」时；
- 平台升级后（尤其 openship 1.x → 2.x），先**重试墙一**——它是最容易变的一条；
- 新增部署单元时：先在本表加行，再谈 CI 与监控（`docs/data-platform-handbook.md` §1.5.3 三层分工）。
