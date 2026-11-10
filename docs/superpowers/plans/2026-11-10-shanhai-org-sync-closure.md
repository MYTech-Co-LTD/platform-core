# 山海实例组织同步收口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把山海实例的企微组织同步收口——先 apply 一次对齐 org 表，再建 6h openship job，让 `org-sync-freshness` 从 STALE 转 OK；应用更版作为独立可选项，不在本计划内强推。

**Architecture:** 仓内脚本 `scripts/org-sync-all.mjs` 在 `openship-platform-core-shanhai-server` 容器里执行；每租户落 `platform.audit(action='admin.org-sync')`，`org-sync-freshness` 探针以成功 apply 的审计行为证据。定时由 openship job 调用，不进 server 进程。

**Tech Stack:** openship MCP / `docker exec` / `pnpm exec tsx` / PostgreSQL。

---

## 0. 当前事实（2026-11-10 03:40 UTC 核对）

| 项 | 值 |
|---|---|
| 山海 app 项目 | `proj_GLXUtN2bJ92DpPrS`，server `8281d598-af73-4d0b-99dd-bc8681fcc8bb` |
| 运行容器 | `openship-platform-core-shanhai-server`（healthy） |
| 容器内脚本 | `scripts/org-sync-all.mjs` **已存在**（运行版本 ≥ #1823） |
| 最近 ready 部署 | `dep_7hdXuVX9jmFALeFW`（commit `bedd1133`）；`dep_wZCiZ_pW5jI0ENgs`（`86240f39`）也 ready |
| 当前 org 表 | `org_node=272`、`org_membership=494`、最后同步 `2026-10-31T15:02:54Z` |
| 探针 | `org-sync-freshness` = **STALE**（`last_probe_at=2026-11-10T03:33:20Z`） |
| 容器 env | `INTEGRATION_PROBE_INTERVAL_MS=60000` 已生效 |
| 同步凭据 | 项目 env 有 `WECOM_SYNC_SECRET__SHANHAIYIGUO_ORG`（isSecret） |
| 只读 dry-run（已跑） | `depts=279 users=494 created=8 disabled=1 members+31 members-4 notInCasdoor=22` |
| 部署扰动 | 今天 03:04 / 03:21 / 03:39 有多次 manual 部署，部分被 supersede/cancel——执行前必须确认来源并冻结 |

> **结论**：本计划的主线是「org sync apply + job + 探针」；**不是**应用大版本升级。应用当前已在 `bedd1133`（包含 org sync 能力），最新 main 的 `6d64a74a`（探针 warn）等改动可在下一次受控更版时一并带上。

## 1. 文件结构

- 只读引用：`deploy/org-sync-job.md`（runbook）、`docs/superpowers/specs/2026-10-30-org-as-platform-primitive-design.md` §3.2.1
- 执行脚本：容器内 `/app/scripts/org-sync-all.mjs`（仓内 `scripts/org-sync-all.mjs`）
- 审计/证据：`platform.audit(action='admin.org-sync')`、`platform.integration(id='org-sync-freshness')`
- 不修改任何仓内代码；本计划只产生运维动作与记录

## 2. Phase 0：冻结与确认（不过不进 Phase 1）

### Task 1：确认部署扰动来源并冻结

- [ ] **Step 1：列出最近部署与触发者**

  MCP `get_projects_by_id_deployments`（projectId=`proj_GLXUtN2bJ92DpPrS`）：
  最近 8 条按 `createdAt` 倒序，记录 `id / status / commitSha / trigger / createdAt`。

  期望：确认最新 ready 是哪一条；如果仍有 `building`，等它结束或显式取消，**不要在构建中再叠一次**。

- [ ] **Step 2：确认 active deployment 与容器起点**

  MCP `get_projects_by_id`（同上）看 `activeDeploymentId`；`docker inspect` 看容器创建时间：
  ```sh
  docker inspect openship-platform-core-shanhai-server --format '{{.Created}} {{.State.StartedAt}}'
  ```
  期望：容器创建时间与某条 ready 部署的 `updatedAt` 对得上；记录二者。

- [ ] **Step 3：冻结手工更版**

  与触发者确认（今天的 manual 部署来源）；在窗口内**暂停**再打 webhook / `post_deployments`。
  本计划 Phase 1–3 不需要应用重启，冻结只为避免 org 表写入与部署/迁移交错。

**判停**：仍有 `building` 部署或来源不明 ⇒ 不进 Phase 1。

## 3. Phase 1：备份 + org sync apply

### Task 2：平台库备份（先备份再写）

- [ ] **Step 1：建备份目录并 dump**

  在 server `8281d598...` 上执行（宿主 shell）：
  ```sh
  mkdir -p /opt/platform-backup
  DUMP=/opt/platform-backup/platform-shanhai-$(date -u +%Y%m%dT%H%M%SZ).dump
  docker exec openship-platform-core-shanhai-postgres sh -lc \
    'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$DUMP"
  ls -lh "$DUMP"
  ```
  期望：exit 0；文件大小 > 0；把 `$DUMP` 的值记下来。

- [ ] **Step 2：验证 dump 可读**

  ```sh
  docker exec -i openship-platform-core-shanhai-postgres pg_restore -l < "$DUMP" | head
  ```
  期望：`pg_restore -l` 输出 TOC（非空、无 “input file appears to be a text format dump”）。

- [ ] **Step 3：记录备份路径**

  把 dump 文件名写进本计划的执行记录（issue 评论），不写任何密钥。

### Task 3：dry-run 复核 → apply

- [ ] **Step 1：再跑一次 dry-run（确认数字未漂移）**

  ```sh
  docker exec openship-platform-core-shanhai-server sh -lc \
    'pnpm exec tsx scripts/org-sync-all.mjs --org shanhaiyiguo-org'
  ```
  期望（2026-11-10 基线）：
  ```
  org-sync: org=shanhaiyiguo-org dryRun=true depts=279 users=494 \
  created=8 renamed=0 reparented=0 disabled=1 reactivated=0 members+31 members-4 notInCasdoor=22 usersCreated=0
  ```
  若 `depts/users` 大幅漂移或 fail-closed 门触发（`EMPTY_DEPARTMENTS` / `DEPT_COUNT_DROP`）⇒ **停**，先查
  `WECOM_SYNC_SECRET__SHANHAIYIGUO_ORG` 的可见范围与出口 IP。

- [ ] **Step 2（2026-11-10 变更）：`notInCasdoor` 自动建号**

  用户拍板（#1847）：企微有 / Casdoor 无 ⇒ **apply 时自动建号**（不再人工决定）。
  - `name=企微 userid`、`displayName=企微姓名`、`wecom=userid`、`registerSource=<org>/org-sync`；
  - 企微 `status≠1`（未激活/禁用/退出）⇒ 建号即 `isForbidden=true`；`status=1` ⇒ 正常；
  - 建号失败 ⇒ 整轮失败、不写 org 表；重跑幂等；
  - **Casdoor 有 / 企微无 ⇒ 不同步、不反写、不自动禁用/删除**（只读企微）。

- [ ] **Step 3：apply**

  ```sh
  docker exec openship-platform-core-shanhai-server sh -lc \
    'pnpm exec tsx scripts/org-sync-all.mjs --org shanhaiyiguo-org --apply'
  ```
  期望：`dryRun=false`，`created=8 disabled=1 members+31 members-4`，`usersCreated=22`（首次带自动建号的
  apply），exit 0。

- [ ] **Step 4：验证写入与审计**

  ```sh
  docker exec -i openship-platform-core-shanhai-server sh -c 'cat > /tmp/check-org.mjs' <<'EOF'
  import { createRequire } from "node:module"
  const { Pool } = createRequire("/app/apps/server/package.json")("pg")
  const p = new Pool({ connectionString: process.env.DATABASE_URL })
  const q = async (s) => (await p.query(s)).rows
  console.log(JSON.stringify({
    nodes: await q("select count(*)::int n, max(synced_at) m from platform.org_node"),
    members: await q("select count(*)::int n from platform.org_membership"),
    audit: await q("select at, detail->>'dryRun' dry, detail->'usersNotInCasdoor' not_in from platform.audit where action='admin.org-sync' order by at desc limit 1"),
  }))
  await p.end()
  EOF
  docker exec openship-platform-core-shanhai-server sh -lc \
    'pnpm exec tsx /tmp/check-org.mjs; rm -f /tmp/check-org.mjs'
  ```
  期望：`nodes.n` 增加 8、`members.n` 增加 27（+31/-4 的净差）；审计 `dry=false`；
  `not_in` 数组长度 22（可在审计里取名单）。

**判停**：apply 失败或审计无行 ⇒ 不建 job，先按 runbook §5 排障。

## 4. Phase 2：job + 探针转 OK

### Task 4：创建 org-sync job

- [ ] **Step 1：建 job（openship MCP `post_jobs`）**

  body：
  ```json
  {
    "label": "org-sync（企微组织同步·山海）",
    "command": "docker exec openship-platform-core-shanhai-server sh -lc 'pnpm exec tsx scripts/org-sync-all.mjs --org shanhaiyiguo-org --apply'",
    "cronExpression": "13 */6 * * *",
    "scheduleType": "recurring",
    "serverId": "8281d598-af73-4d0b-99dd-bc8681fcc8bb",
    "timeoutMs": 600000,
    "retry": { "maxAttempts": 2, "backoffSeconds": 60 },
    "notifyConfig": { "states": ["failed"], "channels": ["nch_XBUs425hd_KsA_lt"] }
  }
  ```
  期望：返回 `key=custom:...`、`nextRunAt` 为下一个 `:13`（UTC，6h 档）。

- [ ] **Step 2：手动触发一次，确认 job 形态可跑**

  ```text
  MCP post_jobs_by_key_run(key=<返回的 key>)
  ```
  期望：`status=success`、`exitCode=0`；输出 `dryRun=false`，数字与 Phase 1 一致或差异可解释。

- [ ] **Step 3：确认 job 已启用**

  MCP `get_jobs_by_key` / `get_jobs_by_key_runs`：`enabled=true`，`nextRunAt` 非空。

### Task 5：探针验证

- [ ] **Step 1：等探针下一跳（≤ 60s）**

  `platform.integration` 的 `org-sync-freshness` 应在下一轮探针后从 STALE 转 OK。

- [ ] **Step 2：查询证据**

  ```sh
  docker exec -i openship-platform-core-shanhai-server sh -c 'cat > /tmp/check-probe.mjs' <<'EOF'
  import { createRequire } from "node:module"
  const { Pool } = createRequire("/app/apps/server/package.json")("pg")
  const p = new Pool({ connectionString: process.env.DATABASE_URL })
  const r = await p.query("select id, enabled, last_verdict, last_probe_at from platform.integration where id='org-sync-freshness'")
  console.log(JSON.stringify(r.rows))
  await p.end()
  EOF
  docker exec openship-platform-core-shanhai-server sh -lc \
    'pnpm exec tsx /tmp/check-probe.mjs; rm -f /tmp/check-probe.mjs'
  ```
  期望：`last_verdict=OK`，`last_probe_at` 在最近 5 分钟内。

**判停**：仍 STALE ⇒ 查 `platform.audit` 是否有 `dryRun=false` 且无 `failed` 的行；查 job 最近一次 run。

## 5. Phase 3（可选）：应用更版到最新 main

> **默认不做**。当前 `bedd1133` 已含 org sync；最新 main 只多了探针 warn 与数据展示/口径改动。
> 只有明确需要这些改动时，才按本节单独开窗口。

### Task 6：受控更版（pinned SHA）

- [ ] **Step 1：确认目标 SHA 与变更面**

  ```sh
  git fetch origin main
  git rev-parse origin/main
  git diff --stat <当前部署 commit>..origin/main
  ```
  当前参照：`bedd1133` → `cf3f51b4`（写作时）。核对无新增 migration；若有，先评审。

- [ ] **Step 2：用 `post_deployments` 钉 SHA（不要用 webhook 的 latest）**

  MCP `post_deployments`，body 至少含：
  ```json
  { "projectId": "proj_GLXUtN2bJ92DpPrS", "commitSha": "<目标 SHA>", "environment": "production" }
  ```
  期望：返回新 deployment id；状态从 `building` → `ready`。

- [ ] **Step 3：验收**

  ```sh
  curl -fsS https://platform.shanhaiyiguo.com/healthz
  curl -fsS https://bot-admin.shanhaiyiguo.com/healthz
  docker exec openship-platform-core-shanhai-server printenv INTEGRATION_PROBE_INTERVAL_MS
  ```
  期望：两处 healthz 200；`60000`；控制台登录与四个服务模块无 403（浏览器手工走一遍）。

- [ ] **Step 4：回滚（如失败）**

  MCP `post_deployments_by_id_rollback` 回 `dep_7hdXuVX9jmFALeFW`（bedd1133）或当前 active 的上一 ready；
  DB 只有在出现 migration 错误时才用 Phase 1 的 dump 恢复。

## 6. Phase 4（条件）：数据面检查

- [ ] **Step 1：确认数据面检出与目标 commit**

  ```sh
  ssh-like via openship exec:
  git -C /opt/platform-core-data/platform-core rev-parse HEAD
  ```
  当前基线：`e93f7209`（2026-11-07）。若应用更版的目标 commit 含 `dbt/` 变更
  （本仓 diff 含 `dbt/models/lemeng/marts/fct_retail_item_profit.sql` 与 `deploy/data-plane.lock`），
  需单独评估是否 sync 数据面。

- [ ] **Step 2：如需要，跑数据面 sync + materialize**

  ```sh
  sh /opt/lemeng-sync.sh <目标 SHA> --prune
  sh /opt/lemeng-materialize.sh
  ```
  期望：`SYNC_OK` / `MATERIALIZE_OK`；否则按 `deploy/data-plane-deploy-sop.md` 处置。

> 数据面与应用是**两个部署单元**；本计划的主线（org sync）不依赖数据面变更。

## 7. 验收清单

- [ ] `org_node` / `org_membership` 数字与 dry-run 一致（+8 / 净 +27）
- [ ] `platform.audit` 有 `admin.org-sync` 成功行，`dryRun=false`，无 `failed`
- [ ] `org-sync-freshness` = OK，`last_probe_at` 新鲜
- [ ] job `enabled=true`，`nextRunAt` 非空；手动触发一次 exit 0
- [ ] 若执行 Phase 3：两个域名 healthz 200、登录/四模块无 403、openclaw 健康
- [ ] 若执行 Phase 4：数据面 `SYNC_OK` / `MATERIALIZE_OK`

## 8. 风险与回滚

| 风险 | 处置 |
|---|---|
| 部署扰动叠加 | Phase 0 冻结；不在 `building` 时写 org 表 |
| `notInCasdoor=22` 导致通知 unresolved | 记录并接受，或走管理操作建号；不自动建 |
| fail-closed 门（0 部门/断崖） | 停，查同步应用可见范围与出口 IP；不要绕过 |
| apply 后树形状不对 | 修源（企微/凭据）后重跑；org 表是 upsert/软删，不物理删 |
| 应用更版失败 | 回滚上一 ready 部署；DB 仅在 migration 错误时用 dump |
| 数据面未同步 | 单独 sync + materialize；不阻塞 org sync 主线 |
