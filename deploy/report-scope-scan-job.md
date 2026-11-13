# 报表受众漂移巡检 job（`report-scope-scan`）

> 代码：`scripts/report-scope-scan.mjs`（薄 CLI）+ `modules/data/domain/report-scope-gate.ts`
> （判据 `reportScopeViolations`，与发布门同一份实现）。
> 设计：`docs/superpowers/specs/2026-11-12-metric-semantic-governance-design.md` §9.1；计划
> `docs/superpowers/plans/2026-11-13-report-metric-gate-p5.md` Task 4；issue #2091。
> 范式与 `deploy/notify-jobs.md` 一致：**仓内脚本 + openship job**（零常驻），命令走
> `docker exec <server 容器> sh -lc '…'`——**不要**把定时副作用塞进 server 进程。

## 它补的是哪条断链

发布门只在**发布那一刻**判「报表受众 ⊆ 面板指标的可见范围」。发布之后，报表一行没动，
指标可以改归属（`owner_dept`）/ 改 `visible_depts` ⇒ 线上出现「能看到报表的人里，
有人打不开某个面板」。本 job 每天把**已发布**报表按同一判据重判一遍，**有受众漂移就 exit 1**。

**判红的两类结果**（P6 Task 1；门结果从字符串提示升级为带类别的 issue）：

- `violations`：受众确实比面板指标可见范围更宽（`REPORT_METRIC_SCOPE_MISMATCH` 同源判据）；
- `issues`：**判不了**——面板指标在词表里查不到（归档/删除/未同步），或 Metabase 无面板指标
  无法判定。判不了 ≠ 干净：巡检对它同样 **exit 1**，输出独立的 `⚠ [issue]` 段。

发布门的 issue **不参与 409 判定**（只有 `panels` 违规才 409）。`scopeIssues` 是**诊断字段**，
实际附在失败路径（400/409）回包上；`200` 路径只有在「门读完目录、`publishVersion` 复核前指标
恰好出现」（目录竞态）时才可能带它——**不要**把「发布 200 + scopeIssues」当验收面。巡检读的是
已发布快照，仍按同一份 `ReportScopeIssue[]` 判红。

## 命令

```sh
# mytech 实例（serverId 23a1091e-…）
docker exec openship-platform-core-server sh -lc 'pnpm exec tsx scripts/report-scope-scan.mjs'

# 山海实例（serverId 8281d598-…）
docker exec openship-platform-core-shanhai-server sh -lc 'pnpm exec tsx scripts/report-scope-scan.mjs'
```

- env：只需要 `DATABASE_URL`（平台库）。它已在 server 容器的项目 env 里；**job 不注入 secret**。
- 两实例各有自己的库 ⇒ **每实例一个 job**（mytech 的 job 看不到山海的报表，反之亦然）。
- 排障可加 `--org <casdoor org>` 只跑一个 org；缺省 = `platform.tenant` ∪ `data.reports` 里出现过的全部 org。
  ⚠️ `--org` 拼错（既无租户行、也无任何报表）⇒ **exit 1 `org_not_found`**，不会 exit 0 假绿。

### 前置条件（缺一不可）

| # | 条件 | 说明 |
|---|---|---|
| 1 | 目标实例的镜像里**已有** `scripts/report-scope-scan.mjs` | mytech 合并后自动部署；**山海是手动更版**（`deploy/delivery-private.md`）。未更版就建 job ⇒ 第 2 步手动跑会 `Cannot find module …/report-scope-scan.mjs` |
| 2 | 容器里有 `DATABASE_URL`（平台库） | 走 server 的项目 env，job 不另注入 |
| 3 | 该实例的报表库可读（迁移已跑：`data.reports` / `data.report_versions`） | 脚本只读，不写表 |

## 「已发布」的判据（与发布门同源，勿改单边）

| 渲染器 | 已发布 | 判什么 |
|---|---|---|
| `metabase` | `required_scope IS NULL` | 无面板可判（DB 跨列 check 钉死 `spec` 为 null；spec §9.2）⇒ 只计数 |
| `platform` | `published_version_id IS NOT NULL` | 取 `report_versions` **不可变快照**的 spec / 页门 / 部门门（行上是草稿/下次发布的门） |

- **平台行的草稿不在本巡检范围**：草稿允许未知指标等中间态，由发布门负责。
- 快照 spec 解析失败 / 指针悬空 ⇒ 线上发布链接本就是 404（`getPublishedSpec` 同口径）⇒ 记 **error** 报出来，不静默跳过。

## 判据（stdout + 退出码）

```
  ✗ [violation] [audience_unbounded] org=shanhaiyiguo-org report r-9「门店月报」 panel 2 metric=lemeng:net_sales
  ⚠ [issue] [metric_unknown] org=shanhaiyiguo-org report r-10「旧月报」 panel 1 metric=lemeng:legacy
report-scope-scan: org=shanhaiyiguo-org tenant=3 reports=12 published=9 metabase=2 violations=1 issues=1 errors=0
report-scope-scan: FAIL（orgs 1 / reports 12 / published 9 / metabase 2 / violations 1 / issues 1 / errors 0）
```

违规/issue 行的标题是**发布快照的标题**（观看者看到的那份），不是行上草稿标题。

| 退出码 | 含义 |
|---|---|
| 0 | 干净（没有任何 violation / issue / error） |
| 1 | **有受众漂移**（violations）**或**有判不了的项（`issues` + `errors`，含单 org 读取失败 `scan_failed`）——都要人看 |
| 2 | **环境/连接类**查不成账：缺 `DATABASE_URL`、连库失败、读全局租户或 org 清单失败。**单 org 的读取失败不是 2**（记 `scan_failed`、exit 1，其余 org 照扫）；用法错（`--org ''` / 纯空白）同样 exit 2，不扫任何 org |

两条违规 reason：

| reason | 含义 | 修法方向 |
|---|---|---|
| `audience_unbounded` | 受众**无法用部门集合界定**：`visibility='tenant'` 且无部门门（全租户），或 ACL 里有 `scope`/`user` viewer（拿到某码的所有人 / 具名个人）⇒ 对部门归属指标 fail-closed | 收窄成部门受众（报表部门门 / ACL `dept` 主体），或给指标加 `visible_depts` 显式共享 |
| `audience_dept_outside_metric_scope` | 行尾 `missingDepts=` 点名的部门不在指标链/`visible_depts` 里 | 收窄受众，或把差集部门加进指标 `visible_depts` |

> owner（ACL `owner` 主体）**不计入受众**：可以管理自己读不到数的报表，观看视图由渲染闸兜住。

issue 的 reason（**判不了，同样 exit 1**；与上面的 violation 分段输出）：

| reason | 含义 | 修法方向 |
|---|---|---|
| `metric_unknown` | 面板指标在词表里查不到（归档/删除/未同步）⇒ 可见范围无从判定 | 恢复/重建该指标，或把报表改成引用现存指标后重新发布；别指望「查不到 = 干净」 |
| `no_panel_metrics` | 渲染器没有面板指标可判（Metabase；spec §9.2 做不到面板级）⇒ 结构性无法判定 | 已知能力缺口：需要产品先声明 Metabase 的 `metricIds`。当前巡检不会把 Metabase 行送进判据（只计数），此 reason 主要出现在发布回包 `scopeIssues` |

errors 的 kind：`tenant_not_registered`（org 没登记进 `platform.tenant`，部门链无法解析）、
`org_not_found`（显式 `--org` 查无此 org）、`published_snapshot_missing` /
`published_spec_unparseable`（发布快照坏了）、`unknown_renderer`（库里出现第三种渲染器，
库/代码不同步）、`catalog_unavailable` / `acl_unavailable` / `gate_failed` / `scan_failed`（读失败或异常）。

## openship job（**尚未创建——建 job 是运维动作，须由人点名后执行**）

> 交付说明：本文件只给参数与命令，**不代建**。运维受令人按下面步骤在 openship MCP 执行。

### 参数

| 字段 | mytech | 山海 |
|---|---|---|
| label | `report-scope-scan（报表受众漂移巡检）` | `report-scope-scan（山海）` |
| serverId | `23a1091e-b29e-4716-96aa-786d3c90c0a5` | `8281d598-af73-4d0b-99dd-bc8681fcc8bb` |
| cron（UTC） | `37 1 * * *`（= 北京 09:37，每日） | `37 1 * * *` |
| timeoutMs | `300000`（只读；逐 org 一次词表加载） | 同左 |
| retry | `{ "maxAttempts": 2, "backoffSeconds": 60 }` | 同左 |
| notifyConfig | `{ "states": ["failed"], "channels": ["nch_XBUs425hd_KsA_lt"] }` | 同左 |

排班依据：与既有数据面 job 错开分钟（现有 `*/5`、`10 4`、`13 */6`、`23 3`、`40 6`、`43 3`），
放在北京上班前，违规当天就能处理。**cron 按 UTC 解释。**

### Step 1：建 job（openship MCP `post_jobs`）

mytech：

```json
{
  "label": "report-scope-scan（报表受众漂移巡检）",
  "command": "docker exec openship-platform-core-server sh -lc 'pnpm exec tsx scripts/report-scope-scan.mjs'",
  "cronExpression": "37 1 * * *",
  "scheduleType": "recurring",
  "serverId": "23a1091e-b29e-4716-96aa-786d3c90c0a5",
  "timeoutMs": 300000,
  "retry": { "maxAttempts": 2, "backoffSeconds": 60 },
  "notifyConfig": { "states": ["failed"], "channels": ["nch_XBUs425hd_KsA_lt"] }
}
```

山海（只改 label / command / serverId）：

```json
{
  "label": "report-scope-scan（山海）",
  "command": "docker exec openship-platform-core-shanhai-server sh -lc 'pnpm exec tsx scripts/report-scope-scan.mjs'",
  "cronExpression": "37 1 * * *",
  "scheduleType": "recurring",
  "serverId": "8281d598-af73-4d0b-99dd-bc8681fcc8bb",
  "timeoutMs": 300000,
  "retry": { "maxAttempts": 2, "backoffSeconds": 60 },
  "notifyConfig": { "states": ["failed"], "channels": ["nch_XBUs425hd_KsA_lt"] }
}
```

期望：返回 `key=custom:...`，`nextRunAt` 为下一个 `01:37Z`。

### Step 2：手动触发一次（判据是两处都对）

```
MCP post_jobs_by_key_run(key=<返回的 key>)
```

- `status=success`、`exitCode=0`，最后一行是 `report-scope-scan: OK（…）`；
- 每 org 一行的 `reports=` 与该实例实际登记数对得上（两实例都不是空库，`orgs=0` 要当异常看）。

**首跑若 exit 1，先把 violations 逐条处理完再启用排班**（见下节），不要带着红上线。

### Step 3：回读确认

```
MCP get_jobs_by_key(key=<key>) / get_jobs_by_key_runs(key=<key>)
```

确认 `enabled=true`、`cronExpression=37 1 * * *`、`notifyConfig.states=['failed']` 与预期一致。

## 违规了怎么办（处置 runbook）

1. **读行**：`org` / `report <id>「标题」` / `panel <下标>` / `metric=` / `reason`（+ `missingDepts`）。
2. **判定「谁是对的」**——两类修法，别直接改库：
   - **指标收紧是对的**（口径归某部门、报表受众放太宽）⇒ 收窄报表受众：改**草稿**的部门门 /
     dept ACL（`PUT /reports/:id/dept-gate`、`PUT /reports/:id/acl`），然后**重新发布**
     （`POST /reports/:id/publish`，产生新快照）或下线（`unpublish`）。
     ⚠️ **不能只改草稿**：线上门归快照，改行不影响已发布链接；**更不能 UPDATE 快照**（append-only，
     回滚 = 把旧快照再发布成新版本）。
   - **受众是对的**（这些部门本来就该看这个口径）⇒ 给指标加 `visible_depts`（口径治理写面），
     或复核 `owner_dept` 是否配错。
3. **复跑**：`MCP post_jobs_by_key_run` → exit 0。同一行反复红 ⇒ 按
   `docs/data-platform-handbook.md` §1.5.3 的监控职责分工升级，别在 job 里加白名单吞掉。
4. **errors 类**：
   - `tenant_not_registered` ⇒ 把该 org 登记进 `platform.tenant`（或修正 `data.reports.org` 的脏值）；
   - `org_not_found` ⇒ `--org` 拼写/环境错；改为缺省（全量）或核对 casdoor org 文本；
   - `published_snapshot_missing` / `published_spec_unparseable` ⇒ 线上发布链接已 404，查发布历史
     （`GET /reports/:id/versions`）后重新发布一个合法版本；
   - `*_unavailable` / `scan_failed` ⇒ 平台库读失败，按普通 DB 故障排（不要当违规处理）。

## 已知边界（诚实记录）

- 按 spec §9.4：巡检**只报不自动改报表**——漂移「入待办」的方式就是 job 判红 + 通知，
  修法由人按上节 runbook 执行（改草稿 → 重新发布）。
- **Metabase 报表**：无面板指标可判（spec §9.2 明确做不到面板级）⇒ 只计数，不判红。
- **归档/删除的指标**：目录里查不到 ⇒ `⚠ [issue] [metric_unknown]`，**exit 1**（P6 Task 1）。
  发布门对同一形态**不产生 409 判定**；`scopeIssues` 是失败路径（400/409）的诊断字段
  （200 仅目录竞态可能出现），巡检读已发布快照仍判红——两边共用同一份 `issues` 形状。
- **平台行草稿**：不在巡检范围（发布门负责，草稿允许中间态）。
- **未登记 org**：巡检面 = `platform.tenant` ∪ `data.reports` 的 org；未登记且有已发布平台报表 ⇒
  记 `tenant_not_registered` 报错（不静默漏判）。
- 巡检**只读**：不写表、不调用外部系统、不打印连接串。
