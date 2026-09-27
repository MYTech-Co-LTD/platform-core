# W2 调度/编排面切换实施计划（3120 零售切 console + HTTP API 编排 + job 退役）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 3120 零售采集的「何时跑」从 openship job 切到 duckle console 自带调度（对齐 64188 既有做法），编排面从「shell 起容器」改为「console HTTP API」，观察期后退役 job。

**Architecture:** 维护窗口内**顺序敏感**的单次切换（先禁 job → 后开 console 调度），次日四件套对账验收，≥3 个运行日观察期后退役。锁的源码结论决定了双跑防线是**顺序**而非引擎锁（跨 workspace 锁不互斥）。

**Tech Stack:** duckle 0.7.3 console（`/api/schedules`、`/api/run/async`）· openship MCP（jobs / 定向部署 / server exec）· `deploy/data-plane.lock` 投递

**上位依据:** `docs/superpowers/specs/2026-09-27-duckle-first-collection-flow-design.md` §6 W2 行（已用户拍板）· issue #221 的「另议」部分（零售不在 #221 首片内）· handbook:485 台账行（「尚未迁 console」）

## Global Constraints

- **唯一通道**：一切运维经 openship MCP；资源 id 从返回值**逐字抄回**，绝不手工补写截断标识符。
- **一个 pipeline 只在一侧跑**；**切换窗口顺序敏感：先禁 job、后开 console 调度**（跨 workspace 锁不互斥——源码级结论，见 Task 0）。
- **一次只动一个变量**：本计划**只切归口，不提频**——cron 保持 `30 2 * * *`（UTC，抄现行 job）；#260 的 5 分钟是独立后续。
- **凭据零明文**：env 键只写「在哪、怎么取」；比对用哈希（sha 前 8 位）不回显值。
- **改 `deploy/duckle/**` ⇒ 必须重跑** `pnpm exec tsx scripts/lemeng/data-plane-lock.mjs` **并一起提交**（漏则 gates 红）。
- **改调度定义两步都做**：seed 进 workspace 卷 + 定向重建 console（`serviceIds`，禁止全量部署）。
- **`/api/run` 系列失败也返回 HTTP 200** ⇒ 必须读 body 的 `status`；**`/api/run/status` 把排队中的 run 也报 `running` 且不带 `queue_ms`** ⇒ 判并发/排队读 receipt，别用 status。
- **不伪造产出**：验收不过就是不过，停下报告。
- **不许 push 违规提交**：Conventional Commits；`docs(plans+specs)` 这类含 `+` 的 scope 会被 CI discipline 打红（P1 实测）——scope 只用 `[a-z0-9-]`。
- feat/fix 必须先有 issue：本计划 **Task 0 先开 issue**，PR body `Closes #<N>`。

---

## 0 已收口的前置与关键事实（执行者必读）

1. **锁疑点：源码级收口（v0.7.3 实码，无需实测）**
   - `POST /api/run`（含 async 同 handler）**在返回 202 前** `claim_for_run`，冲突回 **409 Conflict**——`source-analysis/duckle/crates/duckle-runner/src/serve.rs:2668-2680`（注释逐字：*The same per-pipeline lock a scheduled run takes, claimed BEFORE the 202… A conflict is the honest answer.*）；CLI 裸跑同锁（`main.rs:515`、`main.rs:916`）。
   - **⇒ 锁的作用域 = 单个 workspace**。job 的 run 落 `platform-core-data_duckle-workspace` 卷，console 落 `openship-platform-core-shanhai-data-lemeng-console-3120-ws` 卷（Task 6 实测卷名）——**两套锁互不相干** ⇒ 切换窗口的双跑防线 = **Task 3 的顺序**，不是引擎锁。
   - 分析件 §2.9 第 4 条（「两路说法不一致」）就此销账：取锁派正确，但作用域限定同 workspace。
2. **对齐先例**：64188 的零售调度**已在 console 上跑**（`enabled:true`，`30 2 * * *`）——本计划是把 3120 对齐到它，不是发明新做法。
3. **console-3120 的 env**（`deploy/data-compose.yml:122-130`）：`SYSTEM_BOOK=3120`、`LEMENG_TOKEN`、`ZOS_ACCESS_KEY/SECRET_KEY/BUCKET/ENDPOINT/REGION`，另有机上已注入的 `WECOM_WEBHOOK_URL`、`OO_BASE/OO_ORG/OO_AUTH`、`DUCKLE_CONSOLE_TOKEN`（经 entrypoint 翻译——**别绕开**）。
4. **零售 wrapper 的 env 需求**（`scripts/lemeng/run-retail-day.sh` 同源）：`SYSTEM_BOOK`（缺省 3120 ✓）、`AGI_URL`（**未见缺省——Task 1 必核**）、`ZOS_*`、`LEMENG_NOTIFY`（薄管线会设）、`LEMENG_IN_CONTAINER=1`（薄管线会设）、其余窗口参数有缺省。
5. **回退语义**：退役前 job 保留（`enabled:false`）= 可回退；**删 job 前必须先 export 其完整配置存档**（job 命令只活在 openship 里）。

---

## 文件结构

| 文件 | 动作 | 负责 |
|---|---|---|
| `deploy/duckle/console/schedules/3120.json` | 修改 | `panel-lemeng.retail.windows.run` 的 `enabled:false→true`（cron 不变） |
| `deploy/data-plane.lock` | 生成物 | 随 3120.json 改动重跑 |
| `docs/data-platform-handbook.md` | 修改 | §1.1.6 ⑥ 手动触发口径（Task 5）；§2 台账 3120 行归口（Task 6） |
| 新 issue（GitHub） | 创建 | Task 0；PR `Closes #N` |

---

### Task 0: 立 issue + job 配置存档

**Files:**
- Create: GitHub issue（经 `gh issue create`）
- Create: `.superpowers/sdd/<本计划目录>/task-0-job-archive.json`（存档文件，git-ignored；同时把关键面贴进 issue）

**Interfaces:**
- Produces: issue 号（后续 PR `Closes` 用）；job 完整配置存档（Task 6 退役后回退的唯一依据）

- [ ] **Step 1: 开 issue**

标题：`feat(lemeng): 3120 零售调度切 duckle console（对齐 64188 先例）+ 观察期后退役 openship job`
Body 必含：上位依据（spec §6 W2、#221「另议」）、范围（只切归口不提频，#260 另案）、双跑防线是顺序的源码依据（§0.1）、验收（Task 4 四件套）、回退（Task 3 的回退节）。

- [ ] **Step 2: export 现行 job 完整配置**

经 MCP `get_jobs` 找到 name=`lemeng-retail-3120-runner` 的条目（**逐字抄 key**），`get_jobs_by_key` 取完整配置（command/env/secrets 键名/scheduleType/retry/timeout），存档到存档文件并在 issue 里贴**非密面**（command、cron、重试参数；secrets 只列键名）。

- [ ] **Step 3: 提交（若有仓内文件变动）与台账**

本任务通常零仓内变动（issue + 存档在 git-ignored 目录）。在计划文件勾选本任务并记录 issue 号。

---

### Task 1: console-3120 env 完备性核验与补齐

**Files:**
- 无仓内文件（openship project env 变更走 MCP）

**Interfaces:**
- Consumes: §0.4 的 wrapper env 需求清单
- Produces: 「console-3120 具备跑零售 wrapper 的全部 env」这个结论（Task 3 的前置）

- [ ] **Step 1: 机上取两侧键名清单（只列键名，不回显值）**

经 MCP `post_system_servers_by_id_exec`（serverId=数据面机 `8281d598-af73-4d0b-99dd-bc8681fcc8bb`）：

```sh
C=$(docker ps --format '{{.Names}}' | grep 3120 | grep -i console | head -1)
docker exec "$C" printenv | cut -d= -f1 | sort > /tmp/console-keys.txt
# wrapper 需求清单逐键核对：
for k in SYSTEM_BOOK LEMENG_TOKEN ZOS_ACCESS_KEY ZOS_SECRET_KEY ZOS_BUCKET ZOS_ENDPOINT ZOS_REGION AGI_URL WECOM_WEBHOOK_URL; do
  grep -qx "$k" /tmp/console-keys.txt && echo "$k OK" || echo "$k MISSING"
done
```

Expected: 全 OK。**`AGI_URL` MISSING ⇒ 进 Step 2**；全 OK ⇒ Step 3。

- [ ] **Step 2:（仅当有缺键）从 job 侧取值补进 console 的 env 来源**

job 的 env 在 openship job 配置里（Task 0 已存档）。**缺的键经 openship project env(isSecret) 写进数据面 project**，然后 `patch_projects_by_id_services_by_serviceId` 或定向 refresh 重建 console-3120 让 env 生效（openship env 是**创建容器时**注入）。
⚠️ 值的搬运：job 配置里密钥值**不可读出明文**（openship 打码）⇒ 若 job 侧值拿不到，**在 issue 里点名请人从密码库补**，不要猜。**能哈希比对的键**（如 `AGI_URL` 这类非密 URL）可在两侧分别取值算 sha 前 8 位比对。
Expected: 复跑 Step 1 全 OK。

- [ ] **Step 3: 干跑验证 wrapper 在 console 容器内可启动（不真采）**

```sh
docker exec "$C" sh -c 'LEMENG_IN_CONTAINER=1 SYSTEM_BOOK=3120 sh /opt/lemeng-run.sh 2>&1 | head -5'
```

Expected: 打出用法/模式提示（证明脚本与依赖在容器内可达）。**真跑 `windows` 模式留到 Task 3 的调度触发**——本步只验「起得来」。

---

### Task 2: W2① 手动触发口径实测并落正典（观察期等待期间做，与 Task 3 无依赖）

**Files:**
- Modify: `docs/data-platform-handbook.md`（§1.1.6 ⑥ 之后追加一小段）
- Modify: `deploy/data-plane.lock`（若 duckle/** 未动则 lock 不变，跑守卫确认即可）

**Interfaces:**
- Produces: 正典里的「console 手动触发 SOP」——Task 3 观察期与日后回填都用它

- [ ] **Step 1: 用维度管线做一次 HTTP 手动触发的真实验证**

⚠️ 选**维度管线**（不是零售——零售归 Task 3 的调度首跑；维度是幂等当日覆盖，风险低）。经 MCP exec 在 console 容器内：

```sh
C=$(docker ps --format '{{.Names}}' | grep 3120 | grep -i console | head -1)
TOKEN=$(docker exec "$C" printenv DUCKLE_CONSOLE_TOKEN)
# async 触发 dim.branch（请求体形状先经 duckle serve --help 或上游 docs/current/ci-and-orchestration.md 核对，不许凭记忆编）
docker exec "$C" sh -c "curl -s -X POST http://127.0.0.1:8080/api/run/async -H \"Authorization: Bearer $TOKEN\" -H 'Content-Type: application/json' -d '<按核对到的形状>'"
```

Expected: `202` + runId。**若同管线已有 run 在跑 ⇒ 409 Conflict**（Task 0 §0.1 的锁）——把两种都记下来（这本身就是锁结论的行为验证）。

- [ ] **Step 2: 轮询 status 至结束，读 receipt 取耗时**

`GET /api/run/status?runId=`（注意：排队中也会报 `running`）→ 结束后经 exec 读 `/workspace/runs/receipts/` 对应 receipt 的 `durationMs`。
Expected: dim.branch ~8 秒级完成、`status: ok`；湖里当日 `snapshot=` 分区被幂等覆盖。

- [ ] **Step 3: 正典落口径（§1.1.6 ⑥ 后追加）**

内容（要点 + 实测注）：手动跑用 `POST /api/run/async`（202+runId）；`/api/run/status` 轮询（**排队也报 running、无 queue_ms ⇒ 排队证据读 receipt**）；失败也 200 ⇒ **读 body status**；取消 `DELETE /api/run?runId=`；同管线冲突 **409**（调度/HTTP/CLI 三路同锁，同 workspace 内互斥）；**桌面手 Run 不在此锁内**（别在桌面触发生产管线）。每条注后标「（2026-09-27 实测）」或「（源码 serve.rs:2673）」。

- [ ] **Step 4: 门禁 + 提交**

```bash
pnpm exec tsx scripts/check-data-plane-lock.mjs; echo "lock=$?"   # 期望 0（duckle/** 若未动，lock 应无变化）
pnpm typecheck > /dev/null 2>&1; echo "typecheck=$?"
git add docs/data-platform-handbook.md
git commit -m "docs(handbook): console 手动触发口径入正典（async/status/cancel/409 锁语义，附实测注）"
```

---

### Task 3: 切换维护窗口（**顺序敏感，一气呵成**）

**Files:**
- Modify: `deploy/duckle/console/schedules/3120.json`（`panel-lemeng.retail.windows.run` 的 `"enabled": false` → `"enabled": true`；**cron 保持 `30 2 * * *` 不动**）
- Modify: `deploy/data-plane.lock`（重跑生成）

**Interfaces:**
- Consumes: Task 1 的 env 全 OK 结论
- Produces: 零售的「何时跑」归 console；job 处于 `enabled:false` 待观察

- [ ] **Step 1: 禁 job（**先于一切**）**

经 MCP `patch_jobs_by_key`（key=Task 0 存档里逐字抄的 job key）：`{"enabled": false}`。
Expected: 返回成功；`get_jobs_by_key` 复核 `enabled=false`。**此刻起 job 不再触发**——当晚起零售由 console 接棒。

- [ ] **Step 2: 改仓内 3120.json + 重跑 lock + 提交**

```bash
cd "$(git rev-parse --show-toplevel)"
# 编辑 deploy/duckle/console/schedules/3120.json：仅改 panel-lemeng.retail.windows.run 的 enabled
pnpm exec tsx scripts/lemeng/data-plane-lock.mjs
pnpm exec tsx scripts/check-data-plane-lock.mjs; echo "lock=$?"   # 期望 0
git add deploy/duckle/console/schedules/3120.json deploy/data-plane.lock
git commit -m "feat(duckle): 3120 零售调度切 console（enabled:true，cron 不变；job 侧已先禁）"
```

Expected: 只改一个布尔位；lock 里 3120.json 的 sha 随之更新。

- [ ] **Step 3: 投递 + seed + 定向重建（两步都做）**

① 投递轮：机器上 `sh /opt/lemeng-sync.sh <合并后的全SHA> --check` → 真 sync（**全 SHA 从合并提交逐字取**）；`SYNC_OK n/n` 才算过。
② seed：把机器上 `${REPO}/deploy/duckle/console/schedules/3120.json` 覆盖进卷（临时文件 + `mv -f` 原子替换）：

```sh
REPO=/opt/platform-core-data/platform-core
MOUNT=/var/lib/docker/volumes/openship-platform-core-shanhai-data-lemeng-console-3120-ws/_data
cp "$REPO/deploy/duckle/console/schedules/3120.json" "$MOUNT/.schedules.json.tmp" && mv -f "$MOUNT/.schedules.json.tmp" "$MOUNT/schedules.json"
```

⚠️ **schedules.json 是运行状态**（`last_run_*` 由 console 维护）——**直接整文件覆盖会把 console 的运行记账倒退回仓内版**（Task 4 实测教训）⇒ 正确做法：**经 console 自己的 API 改**：`GET /api/schedules` 取现值 → 只改 `panel-lemeng.retail.windows.run` 的 `enabled` → `POST /api/schedules` 写回；仓内文件是**定义的事实源**，卷内文件是**运行态**，两者字段面不同（仓内不含 `last_run_*`）。若 API 写回失败再退回「覆盖+重建」并接受记账重置（在报告里写明）。
③ 重建：经 MCP `post_projects_by_id_services_sync` + `serviceIds` 定向（只 console-3120；**禁止全量**）。
Expected: `GET /api/schedules` 里 `panel-lemeng.retail.windows.run` 的 `enabled=true`、cron `30 2 * * *`（✅ 2026-09-26 实测：GET 适合自证「定义加载了没」）。

- [ ] **Step 4: 窗口收尾自证**

```sh
# console 侧：调度条目 enabled=true 且 next 生效；job 侧：enabled=false
# 都留输出进报告
```

回退（本任务内任意步失败）：`patch_jobs_by_key {"enabled": true}` 恢复 job；卷内 schedules.json 把该条改回 `enabled:false`（经 API）+ 定向重建；仓内 revert 该提交。

---

### Task 4: 首跑验收（次日 UTC 02:30 窗口后）

**Files:**
- 无（纯验证；证据进 issue）

**Interfaces:**
- Consumes: Task 3 的切换完成
- Produces: 「console 首跑四件套全绿」→ 解锁观察期

- [ ] **Step 1: 调度入账自证**

`GET /api/schedules`（或读卷内 `schedules.json`）:`panel-lemeng.retail.windows.run` 的 `last_run_at`/`last_run_status` 应为今日 UTC 02:30 后、`ok`。⚠️ 用 API 的 GET 只能自证定义；运行状态读**卷内 schedules.json**（2026-09-26 实测：GET 不回 `last_run_*`）。

- [ ] **Step 2: 湖四件套**

经 pg_duckdb 独立回读（口径照 handbook §1.4 / 正典既定 SQL 形态；`duckdb.query($$…$$)` 包裹）：
① 当日 `system_book=3120` 的 `hour=` 分区齐全且行数与 `_ops`/job 时期基线同量级；② **`count(DISTINCT batch_id)` 按 hour = 1**（无双跑）；③ 独立通道：网关计数 vs 湖行数（**未归零 +1.15% 的既有欠账继续如实记**，不因切归口粉饰）；④ `data_alerts` 流当日无 `failure` 行（OO MCP SearchSQL）。
Expected: ①②④ 绿；③ 如实记录（既有偏差不扩大）。

- [ ] **Step 3: job 侧零活动自证**

openship `get_jobs_by_key_runs`：切换时刻后 **0 次新 run**。
Expected: 0。若 job 仍跑了 ⇒ **双跑事故**：立即 `enabled:false` 复核 + 湖上按 `batch_id` 区分两侧写入 + 停在 issue 里报告（这不该发生——Task 3 Step 1 已禁）。

- [ ] **Step 4: 结果写进 issue**（首跑绿/红 + 四件套证据）；红则回退并在 issue 记录。

---

### Task 5: 观察期（≥3 个运行日）与退役

**Files:**
- Modify: `docs/data-platform-handbook.md`（§2 台账 3120 行：归口 job→console）
- Modify: `deploy/data-plane.lock`（若 handbook 不在 manifest 则不变——**handbook 不在 manifest**，跑守卫确认即可）
- openship: 删除 job

**Interfaces:**
- Consumes: Task 4 首跑绿 + 连续 ≥3 个运行日对账绿
- Produces: job 退役；台账归口更新

- [ ] **Step 1: 每日复验（≥3 天，可由一次执行覆盖 T+1/T+2/T+3）**

每天 UTC 02:30 窗口后重复 Task 4 Step 1–2（可精简为：调度 ok + batch_id 唯一 + 无 failure 告警）。三天的证据链贴 issue。

- [ ] **Step 2: 退役 job**

经 MCP `delete_jobs_by_key`（key=Task 0 存档逐字）。**存档文件保留**（回退=按存档重建 job，issue 里有非密面）。

- [ ] **Step 3: 正典与台账收口**

`docs/data-platform-handbook.md` §2 台账 3120 行：调度归口列改 **console**（措辞对齐 64188 行），「尚未迁 console」删；§1.5 速查若有「job 没跑」相关条目按新现实核对。跑门禁（typecheck + 六守卫 + test:guard）→ 提交 → PR（body `Closes #<Task 0 的 issue>`，标题 `feat(lemeng): 3120 零售调度迁 duckle console 完成观察期并退役 job (#N)`）→ **CI CLEAN 才合**。

回退（观察期内任何一天红）：`patch_jobs_by_key {"enabled": true}`（job 还在）+ 经 API 把调度条目改回 `enabled:false` + 定向重建；当次红的证据与回退动作记 issue。

---

## Self-Review

- **Spec 覆盖**：spec §6 W2 行的四件事 → ①编排走 HTTP API = Task 2（实测+落正典）；②3120 切 console = Task 3；③观察期 = Task 4/5；④job 退役 = Task 5。硬前置（锁疑点）= §0.1 源码收口（升级为「已收口」，不再是要执行的事）。
- **占位符扫描**：无 TBD。`<按核对到的形状>`（Task 2 Step 1）是**有意的不预填**——请求体形状明令「先核对再写」，不是留白。
- **顺序一致性**：Task 3 Step 1（禁 job 先行）↔ Global Constraints 的顺序敏感约束；Task 0 的存档 ↔ Task 5 Step 2 的退役依赖。
- **P1 实测教训折叠**：两卷锁不互斥（§0.1）/ status 无 queue_ms（Task 2）/ schedules.json 运行状态（Task 3 Step 3）/ GET /api/schedules 只证定义（Task 4 Step 1）/ scope 含 `+` 会红（Global Constraints）。

## Execution Handoff

执行方式待用户选择（见主对话）。
