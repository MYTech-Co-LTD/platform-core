# 乐檬采集中秋调度改造（改用 duckle 自带调度）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「何时跑」从 openship job 改由 **duckle 自带的调度器**（`duckle-runner serve` 的 tick 循环）承担；宿主是**数据面 compose 的常驻服务**，**按账套分 workspace**，端口**只绑回环**。

**Architecture:** 见 `openship-platform` 仓 `docs/adr/0014-business-scheduling-ownership.md`（本计划的**上位决策**，含实证与两条已完成的实施前验证）。一句话分工：**openship 管「变更通道 + 平台 job」，duckle 管「何时跑 + 跑什么 + 编排 + 状态」**。

**Tech Stack:** duckle 0.7.3（`duckle-runner serve` 自带 scheduler）/ Docker Compose（`deploy/data-compose.yml`）/ 天翼云 ZOS / pg_duckdb / openship MCP（唯一通道）/ duckle MCP（产管线）。

**第一片切法（重要）**：本计划**只接「维度面」（S2-a 的 dim）** —— 它**尚未注册任何 job**（原步 Step 2 因凭据阻塞未执行，且该载荷已作废）⇒ 这一片是**纯新增、零迁移**。**零售 job（`lemeng-retail-3120-runner`，正在跑且绿）不在本计划内**，待这一片观察期过后另议 —— 避免一次动两个。

## Global Constraints

- **一账套 = 一 workspace = 一份 `schedules.json` = 一套凭据**（ADR-0014；因 `LEMENG_TOKEN` 按账套绑定，且**调度条目带不了自己的 env** ⇒ 共用 console 必然有一个拿到错 token，**且会静默采错数据**）。
- **console 只绑 `127.0.0.1`**：调度靠进程内 tick 跑，**不需要对外开端口**。serve 的文档自陈：绑非回环且无凭据时**15 分钟内任何人可 claim 成管理员**（`deploy/duckle/entrypoint.sh` 已据此设了凭据闸）。
- **凭据不落盘**：值只在项目 env（openship 建容器时注入）。**禁止**在数据面写 `.env` —— 实测 `deploy/data-compose.yml` **没有 `env_file`**，写了也不会被读（假绿）。
- **密钥只写 `${ENV:...}`**，任何文件不落明文；输出不回显值。
- 时间一律 RFC3339 UTC；**duckle 的调度在业务机本地时区语义**下解释 —— 排班前**必须**确认容器 TZ（见 Task 2 核对点）。
- 运维一律走 **openship MCP**，不裸 SSH。
- 改 `deploy/data-plane-manifest.txt` 覆盖的任一文件后，**必须重跑** `pnpm exec tsx scripts/lemeng/data-plane-lock.mjs`，否则 `gates` 红。
- 提交纪律：本计划本身是 `docs`；其**实现**属 `feat` ⇒ **开工前先开 issue**，实现 PR 引用它。

## File Structure

| 文件 | 职责 | 变动 |
|---|---|---|
| `deploy/data-compose.yml` | 加两个常驻 console 服务（`lemeng-console-3120` / `lemeng-console-64188`），各带自己的 env 与 workspace 卷 | 改 |
| `deploy/duckle/schedules/3120.json` | **账套 3120 的调度定义**（人读的意图源，进仓） | 新增 |
| `deploy/duckle/schedules/64188.json` | 账套 64188 的调度定义 | 新增 |
| `deploy/duckle/seed-schedules.sh` | 把仓内定义 seed 进 workspace 卷（幂等；只比定义字段，忽略 `last_run_*`） | 新增 |
| `duckle/common/lemeng.notify.json` | **失败通知管线**（`snk.webhook` → 我们的推送通道） | 新增 |
| `deploy/data-plane-manifest.txt` | 把上面新增的仓内文件纳入投递清单 | 改 + 重跑 lock |
| `deploy/data-plane-deploy-sop.md` | 记「调度已改由 duckle 承担」与排障入口 | 改 |

## Task 0: 前置决策（**已决，不在本计划内重开**）

已由 ADR-0014 定案并经用户同意：常驻形态 = compose 常驻服务；端口 = 回环；账套隔离 = 一账套一 workspace；凭据 = 项目 env。

**本计划补充的一条**（ADR 里写「告警尚未接线」）：**告警在引擎内接完，不需要新机制** —— duckle 自带
`ctl.try`（下游任一阶段失败 → 侧路跑兜底管线）与 `snk.webhook`（HTTP POST，属性实测含 `url/method/headers/batchMode/bodyType/authType`）。
另可用 `ctl.runevents`（报告「运行活下来的失败」，需把阶段标为 Continue on failure）覆盖「部分失败但继续」的场景。

## Task 1: 凭据一致性硬校验（**先做，否则后面全是静默错**）

别名方案（`ZOS_*` = `LEMENG_ZOS_*`）已写入项目 env，但**两组值对 agent 都打码** ⇒ 必须机检。

- [ ] **Step 1: 在容器里按哈希比对两组值**

Run（openship MCP `post_system_servers_by_id_exec`，serverId = 数据面 `8281d598…`）：

```sh
# 只输出「一致/不一致」，不回显任何值
for c in $(docker ps --format '{{.Names}}' | grep platform-core-shanhai-data | head -1); do
  docker exec "$c" sh -c '
    same() { [ "$(printf %s "$1" | sha256sum | cut -c1-16)" = "$(printf %s "$2" | sha256sum | cut -c1-16)" ] && echo SAME || echo DIFF; }
    echo "ACCESS_KEY: $(same "$ZOS_ACCESS_KEY" "$LEMENG_ZOS_ACCESS_KEY")"
    echo "SECRET_KEY: $(same "$ZOS_SECRET_KEY" "$LEMENG_ZOS_SECRET")"
    echo "BUCKET    : $(same "$ZOS_BUCKET" "$LEMENG_ZOS_BUCKET")"
    echo "ENDPOINT  : $(same "$ZOS_ENDPOINT" "$LEMENG_ZOS_ENDPOINT")"
    echo "REGION    : $(same "$ZOS_REGION" "$LEMENG_ZOS_REGION")"
  '
done
```

Expected: 五行全 `SAME`。**任一行 `DIFF` ⇒ 停在这里**，先修项目 env 再往下（否则管线会读到另一套凭据，属静默错）。

> ⚠️ **核对点**：项目 env 是**创建容器时**注入的 ⇒ 若上面取到的容器是**在本次 env 写入之前**创建的，
> 它**根本还没有 `ZOS_*` 这几个键**（表现为空串 ⇒ 同样 `DIFF`）。先确认该容器创建时间晚于 env 写入，
> 否则本步的结论不成立。

## Task 2: 先把 wrapper 的 dim 守卫**搬进管线**，再写调度定义

> **为什么有这一步（2026-09-26 实测发现，用户裁决 A）**
> wrapper `/opt/lemeng-run.sh` 是**宿主级编排器**（13 处 `$COMPOSE run --rm … duckle`；
> 宿主上**没有** `duckle` 可执行文件，引擎只在镜像里；它还用 `docker exec` 回读）。
> 而 **duckle 的调度器只能触发「管线」，触发不了宿主脚本** ⇒ 二者接不上。
> 三个选项里选 **A：把那层守卫与记账搬进管线**（弃 B「容器内入口 + 壳管线」= 逻辑复制两份必然漂移；
> 弃 D「容器挂 docker socket」= 把宿主 root 交给该容器，是不能顺手做的安全决策）。
> **A 之所以可行**：wrapper 最重的那件事（起引擎 + 注入 env）在 console 世界里**已经不需要了**
> —— 引擎就在同进程、env 就在 console 进程里；剩下的只是守卫与记账，而它们**都有原生对应物**。

### 2.1 移植清单（逐条对应，**不许漏**）

| wrapper 的职责 | 管线里的形态 | 依据 |
|---|---|---|
| 7 个凭据 + `SYSTEM_BOOK` 注入 | **console 进程 env**（逐账套，见 Task 3） | ADR-0014 决策 |
| `SNAPSHOT` 推导（`TZ=Asia/Shanghai date +%F`） | **`ctl.setvar`**：`value` 是 **SQL 表达式**（实测其 schema 原文示例即 `current_date`）⇒ 用 `AT TIME ZONE 'Asia/Shanghai'` 保持同一语义 | 实测 `ctl.setvar` schema |
| `identity_assert`（#205）：变量缺失即判红 / 传输失败重试 3 次 / verdict 比对 | `src.rest`（whoami）→ **节点自带 Retry**（与「传输失败重试 3 次」同义；`retry` 组件自陈「per-stage retry 已在 Advanced」）→ 比对 → **`ctl.die`** 判红 | 已读 `identity_assert()` |
| 状态解析 + `_ops` 观测行 | console 的 **run 历史**（`last_run_status` 等）+ Task 5 的告警链路 | ADR-0014 / 本计划 Task 5 |
| `--log-dir` | console 自管 | 实测 |
| 失败判红（非零退出） | 管线 `ctl.die` + 引擎非零退出 | 引擎 EXIT CODES |

**纪律：只加节点，不改现有取数/写湖节点**（dim 管线是 S3-a 刚交付验证过的；守卫挂在写湖之前）。

> ⚠️ **核对点（移植前必须做的实测）**：`AT TIME ZONE 'Asia/Shanghai'` 在**管线上下文里**真的可用
> （`ctl.setvar` 的 SQL 由引擎求值 —— 与直接在 DuckDB 里跑是两件事，别按"显然可用"处理）。

### 2.2 写定义文件（移植完成后再做）

- [ ] **Step 1: 写定义**（`deploy/duckle/schedules/<账套>.json`）：只写定义字段，不写运行状态。

| 账套 | 管线（`id`） | 形态 | 排班（**UTC**，已实测容器 TZ=UTC） |
|---|---|---|---|
| 3120 | 门店维 / 商品维 | `cron` 或 `interval` | 照 S2-a 计划：北京 10:00 ⇒ `0 2 * * *`；19:00 ⇒ `0 11 * * *` |
| 64188 | 同上 | 同上 | 同上 |

**口径照抄（issue #17 已标注载荷作废、但口径仍有效）**：3120 的 `BRANCH_NUMS` = 269 家（照零售 job）；
64188 = `{1..128} ∪ {999}`（129 家，**含 99**）；**`SNAPSHOT` 不要传**（现在改由管线自己算，见 2.1）。

- [x] **Step 2: 排班时区核对** —— ✅ 已做（2026-09-26）：**容器 TZ = UTC**（`date`/`date -u` 一致、`TZ` 空、无 `/etc/timezone`）⇒ **排班一律按 UTC 写**。

## Task 3: compose 加两个常驻 console（**只绑回环、各自 env**）

- [ ] **Step 1: 加服务**（`deploy/data-compose.yml`）

两个服务（`lemeng-console-3120` / `lemeng-console-64188`），共同点：
`image: platform-core-duckle:local`、**不挂 `profiles:`**（= 常驻）、`restart: unless-stopped`、
各挂自己的 workspace 卷、**端口只绑回环**（`"127.0.0.1:<port>:<port>"`）、`command: serve --host 0.0.0.0 --port <port> --workspace /workspace`。

各自 env 的关键差异（**env 按容器注入 ⇒ 这正是账套隔离点**）：

| 服务 | `SYSTEM_BOOK` 语义 | 令牌 |
|---|---|---|
| `lemeng-console-3120` | 3120 | `LEMENG_TOKEN: ${LEMENG_TOKEN}` |
| `lemeng-console-64188` | 64188 | `LEMENG_TOKEN: ${LEMENG_TOKEN_64188}` |

同时把 `ZOS_*` 五键与 `POSTGRES_PASSWORD` 传进去（wrapper 读的是这些**不带前缀**的名字）。

- [ ] **Step 2: `--duckdb` 与凭据闸**已实测可用（ADR-0014 §验证一：`DuckDB /usr/local/bin/duckdb` / `sign-in required`）⇒ 本步不重复验证，但**首次部署后仍要回读日志确认这两行**。

> ✅ **本 Task 的前置已确认（2026-09-26），风险点与两条新发现如下。**
>
> **① 可用路径 = `serviceIds` 定向部署。** 本仓已有实测：`serviceIds` 定向部署时**其余容器 kept running**
> （`deploy/customer-onboarding.md` §6 纪律 2 与 §9 实测 **Test 4a**，证据 `dep_JtcT7EsUQOnL5_lo`）；
> 反面对照同处写明：**全量部署会重建该 project 全部容器（把客户 pg/Metabase 全重启）**。
> ⇒ 做法固定为：`post_projects_by_id_services_sync`（把 compose 服务集同步进项目）→ 再按 `serviceIds`
> **只部署新增的两个服务**。**禁止全量部署。**
>
> **② 传播面（新发现，必须处置）**：`deploy/data-compose.yml` 是**两个数据面项目共用**的
> （`platform-core-data`@`23a1091e` 与 `platform-core-shanhai-data`@`8281d598`）
> ⇒ 新服务会**自动出现在两个项目的下次部署**（同处实测 Test 3）。
> 而 `ZOS_*` 五个别名与 `LEMENG_TOKEN_64188` **只写在 shanhai 项目的 env 里**
> ⇒ 另一个项目起这两个服务会**被凭据闸拒跑**（`entrypoint.sh` 对空 token 默认拒），
> 叠加 `restart: unless-stopped` ⇒ **可能反复重启**。
> ⇒ 处置：部署后对**不需要该服务的项目**把这两个服务 patch `enabled: false`
> （同处实测 Test 2 的语义：**不部署 + 拆旧容器**）。
>
> **③ 不能靠「拆出一份单独 compose」规避**：本仓约束 **B7 = compose 全仓只两份**
> （白名单 `deploy/docker-compose.yml` + `deploy/data-compose.yml`，见 `AGENTS.md`）⇒ 第三份即违规。

## Task 4: 部署与冷启动自证

- [ ] **Step 1: 只部署新增服务**（scope 见 Task 3 Step 3 的前提）
- [ ] **Step 2: 冷启动自证**

Run（openship MCP exec）：`docker logs <新服务> 2>&1 | tail -6`

Expected 四行：`management console on http://0.0.0.0:<port>`（容器内绑 0.0.0.0、宿主只映射回环）、`workspace /workspace`、`DuckDB /usr/local/bin/duckdb`、`sign-in required`。

- [ ] **Step 3: 从宿主回环打它的调度 API**

Run: `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<port>/api/schedules`

Expected: `401`（有凭据闸）。**若返回 `200` 且不需要登录 ⇒ 立即停手**（凭据闸失效 = 15 分钟认领窗风险）。

## Task 5: 告警接线（**不做完不算接完调度**）

- [ ] **Step 1: 写通知管线** `duckle/common/lemeng.notify.json`：入参为失败信息行 → `snk.webhook`（POST 我们的推送通道，`batchMode: array`，`bodyType: json`）。**凭据用 `${ENV:...}`**，不落明文。
- [ ] **Step 2: 在两条维管线上挂 `ctl.try`**，兜底指向通知管线。
- [ ] **Step 3: 演练**（**必做，否则等于没接**）：人为制造一次失败（例如临时把某条管线的 `SYSTEM_BOOK` 指向不存在账套），确认**推送真的到达**；再把管线改回。
  > 判据：**收到推送**才算接完。`deploy-verify` 的规矩：失败必须被人看见，不能只在日志里。
- [ ] **Step 4: 残余说明**：调度器**本身**起不来（如磁盘满）不在这条链路上 ⇒ 记入 SOP 的排障入口（人工巡检点）。

## Task 6: 观察期与取证（**不跳过**）

- [ ] **Step 1: 至少覆盖一个完整排班周期**（3120/64188 各触达一次）。
- [ ] **Step 2: 取证**：`schedules.json` 的 `last_run_status` 全为成功；湖里出现对应 `snapshot=` 分区（回读用 wrapper 的 `rb` 模式或 pg_duckdb 直读）。
- [ ] **Step 3: 与既有基线的量级对比**（门店维 270 / 129；商品维 ≥17,132 / ≥24,736 且 < 29,800），**低于基线 = 拉漏，触到阈值 = 哨兵中止**，两者都不是成功。

## Task 7: 文档收尾

- [ ] **Step 1**: ADR-0014 状态由「待实施」改为「**已验证**」（附本计划的验收结果）。
- [ ] **Step 2**: `deploy/data-plane-deploy-sop.md` 增一节「调度归谁、排障入口、告警链路」，并说明**零售 job 尚未迁移**。
- [ ] **Step 3**: `deploy/duckle/README.md` 补 console 的运维要点（回环、凭据、seed 定义）。

## 回滚点（每步都能回）

| 步 | 回滚 |
|---|---|
| Task 1/2 | 无副作用（只读 / 只写仓） |
| Task 3 | 撤 compose 改动（未部署则无影响） |
| Task 4 | 停掉两个新服务（`docker compose stop <svc>`）——**旧 job 从没被建过，无需恢复** |
| Task 5 | 摘掉 `ctl.try`（管线回退到无通知版本） |
| Task 7 | 文档回改 |

## 计划外事实（执行者必读）

- **为什么这一片是纯新增**：维度面**从未注册过 openship job**（原 Step 2 被凭据阻塞、载荷已作废）⇒ 没有「迁移」，只有「新建」。
- **零售 job 不在本计划**：`lemeng-retail-3120-runner`（`30 2 * * *`）**正在跑且绿**。其迁移需单独决定与观察 —— 别顺手一起动。
- **凭据分布**：`ZOS_*` 别名 + `LEMENG_TOKEN_64188` 已于 2026-09-26 写入数据面项目 env（`LEMENG_ZOS_*` 与 3120 的 `LEMENG_TOKEN` 原本就在）。值对 agent 打码 ⇒ Task 1 的哈希比对是唯一的核对手段。
- **duckle 的调度只在 console 开着时跑** ⇒ 该服务必须常驻；这是对「拍板 #4 零常驻」的**局部有意偏离**（ADR-0014 已留档）。
- **`schedules.json` 定义与运行状态混存** ⇒ 仓里只放定义字段，运行字段由 console 维护；seed 时只比定义字段（`last_run_*` 的差异不算漂移）。
