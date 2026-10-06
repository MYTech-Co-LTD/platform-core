# #452 实现：问数咽喉 ETag 重试恰一次 + 物化 job 错峰（A + E1）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 #452 定案（spec `docs/superpowers/specs/2026-10-06-today-read-race-semantics-design.md`，用户裁决 A + E1）：query-service 咽喉对湖 ETag 竞态退避重试**恰一次**并单独归因 `warehouse_transient`；物化 job cron 从 `20 3 * * *` 错峰到 `27 3 * * *`。

**Architecture:** 读侧唯一入口 `runQuery` 的执行 try/catch 处包一层「识别 ETag 形状 → 退避 1s → 重试恰一次」；重试成功照写审计（`reason='lake_race_retry'`，这是 spec §3.5 判「重试长期是否够用」的唯一数据源）；重试仍撞回 `reason='warehouse_transient'`（detail 保留 DuckDB 原文）。cron 侧仅经 openship MCP 改（唯一通道），仓内正典同步。

**Tech Stack:** TypeScript (Hono 模块 `modules/data`)、vitest（真库分组，`DATABASE_URL`）、openship MCP（job 管理）。

## Global Constraints

- 依据：spec §3（定案形态）逐条照办；issue **#452**。spec §4 非目标不改写侧、不碰 audit 模型、不实施退路 D。
- **窄匹配，宁漏判不误判**（spec §3.1）：判据只认 message 含 `ETag on reading file`（常量 `LAKE_RACE_RE = /ETag on reading file/`）。**不扩大**到一般 5xx/超时——那类由既有 statement_timeout / job retry 语义管。
- **重试恰一次**，退避缺省 `1_000ms`（常量 `LAKE_RACE_RETRY_DELAY_MS`）；`QueryDeps.raceRetryDelayMs?: number` 为测试缝（测试注 0）。本通路全为只读 SELECT ⇒ 幂等，全量适用。
- 重试仍撞 → `QueryError.reason` 新增分支 **`'warehouse_transient'`**，`detail` 保留原文（spec §3.2）。路由 502 映射不动（error 族整体仍 502）。
- 重试成功 → 审计 `verdict='ok', reason='lake_race_retry'`；未重试的 ok 照旧 `reason=null`。所有结局审计照写不变。
- cron：`20 3 * * *` → **`27 3 * * *`**（UTC；上海 11:27），**只经 openship MCP**；job 的 retry 2×/300s、timeoutMs、告警配置一律不动（spec §3.3）。上午有当天数据的语义不变。
- 提交：Conventional Commits。PR 与 commit 用 **`Refs #452`**，**不写 Closes**——#452 的销账条件是 Task 3 的连续 3 个自然日首跑无撞，观察完才人工关（spec §3.4）。
- 分支从 fetch 过的 `origin/main` 新建（本机多 worktree，别从本地 main 起）；合并只等 CI CLEAN（UNSTABLE 也不合）。
- 本地真库已验可用：`postgres://platform:platform@127.0.0.1:5432/platform`（2026-10-06 实连 OK，基线 7/7 绿）。单测命令模板：
  `DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform' pnpm --filter data exec vitest run domain/query-service.test.ts`
  （workspace 名是 `data`，vitest cwd = `modules/data`）。若 5432 起不来：`docker compose -f deploy/docker-compose.yml up -d postgres`。**不许把 skip 绿当绿**——`describePg` 分组无 `DATABASE_URL` 时静默跳过，那不是验证。

## File Structure

- `modules/data/domain/query-service.ts` — 唯一执行咽喉：加重试 + 归因 + 测试缝（本计划唯一的行为改动点）。
- `modules/data/domain/query-service.test.ts` — 加 3 条 race 测试（真库分组内，沿用既有夹具与审计断言形状）。
- `modules/data/routes/query.ts:2-3` — 只改头注两行（状态码映射的注释把 `warehouse_transient` 讲进去），不改逻辑。
- openship job `lemeng-dbt-materialize`（key 见 Task 2）— 控制面，无仓内文件。
- 正典同步：`docs/data-platform-handbook.md`（两处）、`deploy/data-plane-deploy-sop.md`（一处）、spec ③（三处现状/事实行加订正注）。
- Task 3 另有 spec ③ §7 依赖链一行 + issue #452 关闭，均 docs-only。

---

### Task 1: query-service 咽喉重试 + `warehouse_transient` 归因（TDD）

**Files:**
- Modify: `modules/data/domain/query-service.ts`（`QueryDeps` ~:14、`QueryError` ~:37、执行块 ~:93-107）
- Modify: `modules/data/domain/query-service.test.ts`（夹具区 + 在「error：仓库执行抛错」用例后插 3 条）
- Modify: `modules/data/routes/query.ts:2-3`（仅注释）

**Interfaces:**
- Consumes: 现有 `SqlExecutor`、`runWarehouseSql(warehousePool(), sql)`、`writeAudit(pool, {…})`（`reason: string | null` 自由形，`'lake_race_retry'` 直接收下）、`DATA_WAREHOUSE_UNCONFIGURED`。
- Produces: `QueryDeps.raceRetryDelayMs?: number`；`QueryError.reason` 联合类型扩为 `'warehouse_unconfigured' | 'warehouse_transient' | 'warehouse_error'`；模块级 `isLakeRaceError(err: unknown): boolean`。Task 3 无代码依赖；spec ③ 实现消费 `warehouse_transient` 语义。

- [ ] **Step 1: 建分支**（从 fetch 过的 origin/main）

```bash
git fetch origin main
git switch -c fix/452-lake-race-retry origin/main
```

- [ ] **Step 2: 写失败测试**（`modules/data/domain/query-service.test.ts`）

夹具区（`const ORG = 'org_a'` 之后）加：

```ts
/** #452 真机形态（2026-10-06 run jrun_dtyVWZnnFaQ_pCCN 实测原文的形状，值部分换短例）。
 *  判据窄匹配只认「ETag on reading file」——测试钉的是形状，不是整句。 */
const RACE_MSG =
  'HTTP Error: ETag on reading file "s3://shanhai-data/lemeng/retail_order_line/system_book=3120/bizday=2026-10-06/hour=10/all.parquet" was initially "a" and now it returned "b", this likely means the remote file has changed.'
```

在「error：仓库执行抛错 → status:error + 审计 verdict=error」用例（现 ：111-120）之后插入三条：

```ts
  it('race：ETag 竞态错 → 退避重试恰一次成功，审计 verdict=ok + reason=lake_race_retry', async () => {
    let calls = 0
    const flaky: QueryDeps = {
      pool, adoptedSources: new Set(),
      raceRetryDelayMs: 0,                                   // 测试缝：退避归零，免真等 1s
      execute: async () => {
        calls++
        if (calls === 1) throw new Error(RACE_MSG)
        return { columns: ['org', 'day'], rows: [['org_a', '2026-08-15']] }
      },
    }
    const out = await runQuery(flaky, ORG, req(), 'sales_daily', {})
    expect(out.status).toBe('ok')
    expect(calls).toBe(2)                                    // 恰一次：不是 0 次也不是 ≥3 次
    // 重试成功也留痕：reason=lake_race_retry 是 spec §3.5 判「重试长期是否够用」的数据源
    const a = await pool.query(
      `select verdict, reason, row_count from data.query_audit where org = $1 order by id desc limit 1`, [ORG])
    expect(a.rows[0]).toMatchObject({ verdict: 'ok', reason: 'lake_race_retry', row_count: 1 })
  })

  it('race：连撞两次 → status=error reason=warehouse_transient（detail 保留原文），审计照写', async () => {
    let calls = 0
    const alwaysRace: QueryDeps = {
      pool, adoptedSources: new Set(),
      raceRetryDelayMs: 0,
      execute: async () => { calls++; throw new Error(RACE_MSG) },
    }
    const out = await runQuery(alwaysRace, ORG, req(), 'sales_daily', {})
    expect(calls).toBe(2)
    expect(out.status).toBe('error')
    if (out.status !== 'error') return
    expect(out.reason).toBe('warehouse_transient')           // 不是裸 warehouse_error
    expect(out.detail).toBe(RACE_MSG)                        // 原文供排障
    const a = await pool.query(
      `select verdict, reason from data.query_audit where org = $1 order by id desc limit 1`, [ORG])
    expect(a.rows[0]).toMatchObject({ verdict: 'error', reason: 'warehouse_transient' })
  })

  it('race：非 ETag 错误不重试（calls=1）→ 原样 warehouse_error（窄匹配的回归护栏）', async () => {
    let calls = 0
    const bad: QueryDeps = {
      pool, adoptedSources: new Set(),
      raceRetryDelayMs: 0,
      execute: async () => { calls++; throw new Error('boom') },
    }
    const out = await runQuery(bad, ORG, req(), 'sales_daily', {})
    expect(calls).toBe(1)
    expect(out.status).toBe('error')
    if (out.status !== 'error') return
    expect(out.reason).toBe('warehouse_error')
  })
```

- [ ] **Step 3: 跑测试确认失败形状**

```bash
DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform' \
  pnpm --filter data exec vitest run domain/query-service.test.ts
```

预期：**前两条 FAIL**（第 1 条 status=error≠ok；第 2 条 reason=warehouse_error≠warehouse_transient）、**第 3 条 PASS**（它是不重试行为的护栏，本来就绿）、其余 7 条照旧绿。共 10 条、2 红。**TS 编译错也算数但要看清是哪类**：`raceRetryDelayMs` 未声明会在类型检查红——属预期失败形状（实现 Step 4 补上）；若 vitest 因类型直接拒跑，先看错误是否恰为「raceRetryDelayMs 不存在于 QueryDeps」。

- [ ] **Step 4: 最小实现**（`modules/data/domain/query-service.ts`）

4a. `QueryDeps`（现 ：14-27）内、`execute?: SqlExecutor` 之后加：

```ts
  /** 湖 ETag 竞态重试的退避毫秒数（缺省 1000）。测试注入 0 免等待。 */
  raceRetryDelayMs?: number
```

4b. `QueryError.reason`（现 :39）扩联合类型：

```ts
  // warehouse_transient（#452 定案 §3.2）：湖 ETag 竞态重试仍撞——「活跃写入窗内的暂时性
  // 读冲突，等几秒重试大概率成功」，不是仓库坏了；detail 保留 DuckDB 原文供排障。
  reason: 'warehouse_unconfigured' | 'warehouse_transient' | 'warehouse_error'; detail: string
```

4c. import 行之后（`MAX_QUERY_ROWS…` / `writeAudit` / `warehouse` 三行之下）加模块级判据与退避：

```ts
/** 湖 ETag 竞态的**窄匹配**（#452 定案 spec §3.1：宁可漏判也不误判——只认这一形状，
 *  不扩大到一般 5xx/超时；那类由 statement_timeout / job retry 语义管）。 */
const LAKE_RACE_RE = /ETag on reading file/
/** 退避：写入是原子 PUT，撞上时新文件多半已就绪，~1s 后重试恰一次足够（spec §3.1）。 */
const LAKE_RACE_RETRY_DELAY_MS = 1_000

function isLakeRaceError(err: unknown): boolean {
  return LAKE_RACE_RE.test(err instanceof Error ? err.message : String(err))
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
```

4d. 执行块（现 ：93-107）整块替换为：

```ts
  // 湖 ETag 竞态（#452 定案 A）：tick 在上海 08:00–24:00 每 5 分钟重写当天 cur/prev 两个分区，
  // 任意时刻的读可能撞上重写窗 ⇒ 咽喉处退避 ~1s 重试**恰一次**（本通路全为只读 SELECT，天然幂等）。
  // 重试成功也把 `lake_race_retry` 写进审计 reason——那是 spec §3.5「重试是否长期够用」的数据源。
  let result: { columns: string[]; rows: unknown[][] }
  let raceRetried = false
  try {
    const exec = () =>
      deps.execute
        ? deps.execute(authz.plan.sql)
        : runWarehouseSql(warehousePool(), authz.plan.sql)
    try {
      result = await exec()
    } catch (err) {
      if (!isLakeRaceError(err)) throw err
      raceRetried = true
      await sleep(deps.raceRetryDelayMs ?? LAKE_RACE_RETRY_DELAY_MS)
      result = await exec()
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    const reason =
      detail === DATA_WAREHOUSE_UNCONFIGURED ? 'warehouse_unconfigured'
      : isLakeRaceError(err) ? 'warehouse_transient'
      : 'warehouse_error'
    await audit('error', reason, null)
    return { status: 'error', metricId, reason, detail }
  }

  await audit('ok', raceRetried ? 'lake_race_retry' : null, result.rows.length)
```

（`warehouse_unconfigured` 的全等判定保持在三元链**第一位**——语义不变；它的 message 不含 ETag，与 transient 判据无交集。）

4e. `modules/data/routes/query.ts:2-3` 头注改为：

```ts
// 状态码映射（#30 订正）：ok → 200；denied → 403；error → **502**——
// warehouse_unconfigured / warehouse_transient / warehouse_error 都是上游数据仓库（或其活跃
// 写入窗）侧的问题，不是本服务的 bug ⇒ 不是 500（warehouse_transient = #452 的湖竞态重试仍撞）。
```

- [ ] **Step 5: 跑测试确认通过**

```bash
DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform' \
  pnpm --filter data exec vitest run domain/query-service.test.ts
pnpm typecheck
```

预期：10/10 绿；typecheck 全仓绿。再把 `data` 包全量跑一遍（别只跑单文件）：

```bash
DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform' pnpm --filter data test
```

- [ ] **Step 6: 提交**

```bash
git add modules/data/domain/query-service.ts modules/data/domain/query-service.test.ts modules/data/routes/query.ts
git commit -m "fix(data): 问数咽喉对湖 ETag 竞态退避重试恰一次 + warehouse_transient 归因（Refs #452）"
```

---

### Task 2: 物化 job 错峰（openship MCP，唯一通道）+ 正典同步

**Files:**
- 控制面：openship job `lemeng-dbt-materialize`（文档记 key `custom:yNWqnvY65iWz1unf`——**以 `get_jobs` 读到的为准，别手抄延长**）
- Modify: `docs/data-platform-handbook.md`（:29 订正注、:771 调度表行）
- Modify: `deploy/data-plane-deploy-sop.md`（:593 §F.6）
- Modify: `docs/superpowers/specs/2026-09-26-detail-read-view-design.md`（:43-44、:95、:100 三处现状/事实行加订正）

**Interfaces:**
- Consumes: Task 1 的分支（本任务提交落同一分支同一条 PR）。
- Produces: 控制面 cron `27 3 * * *`；仓内四处正典行与控制面一致。

- [ ] **Step 1: 读 job 现状**（openship MCP）

`get_jobs` → 找 label `lemeng-dbt-materialize`，记下**逐字的 key**、当前 cron（应 `20 3 * * *`）、retry（应 maxAttempts 2 / backoffSeconds 300）、enabled。对不上就停下来核实，别凭文档硬改。

- [ ] **Step 2: 改 cron**（只动 cronExpression 一个字段）

`patch_jobs_by_key`，`key` = Step 1 读到的逐字 key，body：

```json
{ "cronExpression": "27 3 * * *" }
```

- [ ] **Step 3: 回读验证**（部署后验的纪律：改了什么验什么）

`get_jobs_by_key`（同 key）确认：cronExpression = `27 3 * * *`、enabled 未变、retry 仍 maxAttempts 2 / backoffSeconds 300、label/timeoutMs/告警未变。截取回读 JSON 存进 PR 描述作证据。

- [ ] **Step 4: 正典同步**（四处，全部给出精确 old→new）

4a. `docs/data-platform-handbook.md:29`——订正注里补错峰事实。old：

```
> 物化 job `lemeng-dbt-materialize`（`custom:yNWqnvY65iWz1unf`，UTC `20 3 * * *`）已注册并逐日成功
```

new：

```
> 物化 job `lemeng-dbt-materialize`（`custom:yNWqnvY65iWz1unf`，UTC `20 3 * * *`【2026-10-06 起
> 错峰为 `27 3 * * *`，#452 E1】）已注册并逐日成功
```

4b. `docs/data-platform-handbook.md:771`——调度表行。old（行内片段）：

```
`lemeng-dbt-materialize`（`custom:yNWqnvY65iWz1unf`，UTC `20 3 * * *`，重试 2×/300s，仅 `failed` 告警）
```

new：

```
`lemeng-dbt-materialize`（`custom:yNWqnvY65iWz1unf`，UTC `27 3 * * *`（2026-10-06 由 `20 3` 错峰，#452 E1：避开 tick `*/5` 同分钟点火），重试 2×/300s，仅 `failed` 告警）
```

4c. `deploy/data-plane-deploy-sop.md:593`——§F.6。old：

```
**job**：`lemeng-dbt-materialize`（`custom:yNWqnvY65iWz1unf`），cron **`20 3 * * *` UTC**，
```

new：

```
**job**：`lemeng-dbt-materialize`（`custom:yNWqnvY65iWz1unf`），cron **`27 3 * * *` UTC**
（2026-10-06 由 `20 3` 错峰：与 tick `*/5` 同分钟点火天天撞 ETag，#452 E1 定案；retry 配置未变），
```

（原第二行 `retry 2×/300s`… 顺延，检查拼接后语句通顺。）

4d. spec ③ `docs/superpowers/specs/2026-09-26-detail-read-view-design.md` 三处：

- :43-44 事实行（「在跑」的证据）old：
  `物化 job 每天 03:20 UTC 首跑撞上 tick 正在重写\n  当天分区（issue #452 实测）`
  new：`物化 job（2026-10-06 前的 cron）每天 03:20 UTC 首跑撞上 tick 正在重写\n  当天分区（issue #452 实测；该撞面已由 #452 E1 错峰至 03:27 UTC 消解）`
- :95 现状行 old：`（\`lemeng-dbt-materialize\`，cron \`20 3 \* \* \*\`）：` new：`（\`lemeng-dbt-materialize\`，cron \`27 3 \* \* \*\`——2026-10-06 由 \`20 3\` 错峰，#452 E1）：`
- :100 old：`03:20 UTC 首跑读湖恰逢 tick 重写当天分区 ⇒ **天天撞 ETag 竞态**、靠重试兜住（attempt 2 才绿）。` new：`（2026-10-06 前的 cron 是 03:20 UTC）首跑读湖恰逢 tick 重写当天分区 ⇒ **天天撞 ETag 竞态**、靠重试兜住（attempt 2 才绿；已由 #452 E1 错峰终结）。`

- [ ] **Step 5: 提交**

```bash
git add docs/data-platform-handbook.md deploy/data-plane-deploy-sop.md docs/superpowers/specs/2026-09-26-detail-read-view-design.md
git commit -m "docs(data): 物化 job cron 错峰 20 3→27 3（#452 E1）+ 四处正典同步"
```

- [ ] **Step 6: 开 PR、等 CI CLEAN 后合并**

```bash
git push -u origin fix/452-lake-race-retry
gh pr create --base main --title "fix(data): #452 A+E1——问数咽喉 ETag 重试恰一次 + 物化 job 错峰" \
  --body "Refs #452（销账在 3 日观察后，见 plans/2026-10-06-lake-race-retry-and-cron-offset.md Task 3）。

- Task 1: query-service 咽喉重试（窄匹配 /ETag on reading file/，恰一次，退避 1s；测试缝 raceRetryDelayMs）+ warehouse_transient 归因 + 重试成功审计 lake_race_retry。
- Task 2: openship job lemeng-dbt-materialize cron 20 3 → 27 3（MCP 完成并回读验证，证据贴描述）+ 正典四处同步。
- 定案依据：docs/superpowers/specs/2026-10-06-today-read-race-semantics-design.md（PR #464）。"
```

合并只等全 job CLEAN（含 unit 挂 PG 的真库跑）。

---

### Task 3: 连续 3 个自然日观察 + 销账 #452（docs-only，无代码）

**Files:**
- 无仓内代码文件；产出 = issue #452 评论与关闭 + 一个小 docs PR（spec ③ §7 一行）。

**Interfaces:**
- Consumes: Task 2 已生效的 cron；openship MCP 的 job 运行历史。
- Produces: #452 关闭（或按 spec §3.5 升级为退路评估——见 Step 3）。

- [ ] **Step 1: 观察 3 个自然日**（从 cron 生效后的首个 03:27 UTC 算起）

每天 03:27 UTC 之后（上海 11:30 后即可）跑一次 `get_jobs_by_key_runs`（key 同 Task 2），看**最近一次**日跑：期望 `status=success` 且 **attempt 1 一次过**（无 retry）。三条记录（run id + 日期 + attempt 数）都留进 issue 评论。

- [ ] **Step 2: 判定**

- 三天全部 attempt 1 绿 → 进 Step 4。
- 任何一天出现 retry（attempt ≥2 才绿）或失败 → **不关 issue**；把现象记进 #452，回到 race spec §3.5 评估退路 D，等用户裁决。

- [ ] **Step 3（可选，仅当观察窗内任一真实 ETag 又出现时）:** 从 job 日志取该次 DuckDB 报错的**稳定 code/SQLSTATE**（若有），在 #452 评论里贴原文；若 code 稳定，后续小 PR 把 `isLakeRaceError` 优先按 code 匹配、文本兜底（spec §3.1 预留的收严口）。没有就不做，不预支。

- [ ] **Step 4: 销账**

```bash
gh issue comment 452 --body "已按定案落地并观察：
- 实现：PR #<impl编号>（A：咽喉重试恰一次 + warehouse_transient；E1：cron 20 3 → 27 3）
- 定案 spec：docs/superpowers/specs/2026-10-06-today-read-race-semantics-design.md
- E1 验收（spec §3.4）：连续 3 个自然日首跑 attempt 1 即绿——
  · <run_id_1> <日期>
  · <run_id_2> <日期>
  · <run_id_3> <日期>
- 真机（A）随 spec ③ gate 3 在视图实现后一并跑，不在本 issue 射程内。"
gh issue close 452
```

（`<run_id_N>` 与 `<impl编号>` 用前两步实取的值替换——从源头逐字取，不手补。）

- [ ] **Step 5: spec ③ §7 依赖链一行收口**（docs-only 小 PR）

`docs/superpowers/specs/2026-09-26-detail-read-view-design.md` §7 链中 `#452 定案 ✅（today-read-race-semantics spec，A+E1）` 一行改为 `#452 ✅（定案 #464 + 实现 <impl PR 号>，A+E1，销账 <关闭日期>）`。提交：

```bash
git switch -c docs/452-settle origin/main
git commit -am "docs(specs): #452 实现+销账回写依赖链"
git push -u origin docs/452-settle
gh pr create --base main --title "docs(specs): #452 实现销账回写 spec ③ 依赖链" --body "Refs #452"
```

CI CLEAN 后合并。到此 #452 全链路闭环；spec ③（视图实现）的硬前置正式解除。
