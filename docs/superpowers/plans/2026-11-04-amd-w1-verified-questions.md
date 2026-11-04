# W1 可信度地基 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.
>
> **本计划对应路线图 §3 的 W1**：`docs/superpowers/plans/2026-11-04-auto-metric-derivation-roadmap.md`
> 开工前先读该文件 §1/§3/§5，并**用命令核实代码现状**（不信任台账文本）。

**Goal:** 建立「已验证问答」的采集、人工/自动双源判定、以及回归 job（结构 + 相对容差），让口径改动能被自动发现并报红。

**Architecture:** 平台侧新增 `data.verified_questions`（每租户一份）；回归核心 `summarize(QueryOk)` + `compare(baseline,current,tol)` 是**纯函数**，用 `runQuery` 重放；bot 侧 `verify.py` 复用轨迹归一化器识别强/弱/负信号，写 OO 流 `askdata_verified`，平台侧用**新增 OO 只读凭据**拉取落库。

**Tech Stack:** PostgreSQL 迁移 / TypeScript 域层 + Hono 路由 / vitest / Python3（读 openclaw sqlite）/ OpenObserve HTTP `_search`。

## Global Constraints

- **回归口径 = 结构 + 相对容差**（2026-11-04 裁决）：SQL 可执行、列集一致、行数一致、数值相对差 ≤ `tolerance`（默认 `0.001`）。**不做逐字 digest**（数据回填会假红）。
- **强信号自动生效；弱信号只进候选；负信号不入集**（2026-11-04 裁决）。
- **跨机链路 = OO 中转**（2026-11-04 裁决）：bot 侧只写（沿用现有 ingestion token）；平台侧新增**只读**凭据——**新增 secret 需用户在部署时点名确认**，本计划只写「在哪、怎么配」。
- **租户隔离**：`org` 为隔离键；bot 侧必须显式配置 `ASK_VERIFY_ORG`，缺失即 `exit 1`（fail-closed，不猜）。
- **B11**：不新增任何业务口径；回归只重放已声明指标。
- **不编数值**：强/弱信号的阈值（回合窗口、词表）是**初始值**，标注「待真实会话标定」。

---

### Task 1: 存储层（迁移 032 + 域模块）

**Files:**
- Create: `modules/data/migrations/032_verified_questions.sql`
- Create: `modules/data/domain/verified-questions.ts`
- Test: `modules/data/domain/verified-questions.test.ts`

**Interfaces:**
- Produces: `VerifiedQuestion` 类型；`upsertCandidate` / `listVerified` / `setStatus` / `recordCheck`。
- Produces: 表 `data.verified_questions`。

- [ ] **Step 1: 写失败测试**

```ts
it('候选 → 人工确认 → 可列出；自动强信号直接 verified', async () => {
  await upsertCandidate(pool, ORG, {
    question: '上个月净销售额', metricId: 'lemeng:retail:net_sales',
    params: {}, slicing: {}, baseline: { columns: ['value'], rowCount: 1, summary: { value: { sum: 100, min: 100, max: 100, nulls: 0 } } },
    source: 'auto', strength: 'strong', sessionId: 's1',
  })
  const verified = await listVerified(pool, ORG)
  expect(verified).toHaveLength(1)
  expect(verified[0]!.status).toBe('verified')

  await upsertCandidate(pool, ORG, {
    question: '上个月销售额', metricId: 'lemeng:retail:sales',
    params: {}, slicing: {}, baseline: { columns: ['value'], rowCount: 1, summary: {} },
    source: 'auto', strength: 'weak', sessionId: 's2',
  })
  expect((await listVerified(pool, ORG))).toHaveLength(1)
  const candidates = await listVerified(pool, ORG, { status: 'candidate' })
  expect(candidates).toHaveLength(1)
  await setStatus(pool, ORG, candidates[0]!.id, 'verified', 'u-admin')
  expect((await listVerified(pool, ORG))).toHaveLength(2)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run modules/data/domain/verified-questions.test.ts -t "候选"`
Expected: FAIL（表/模块不存在）

- [ ] **Step 3: 建迁移**

```sql
-- 032_verified_questions.sql — W1 可信度地基：已验证问答（回归集）
-- 幂等：create table if not exists / create index if not exists。
create table if not exists data.verified_questions (
  id            bigserial   primary key,
  org           text        not null,
  question      text        not null,
  metric_id     text        not null,
  params        jsonb       not null default '{}'::jsonb,
  slicing       jsonb       not null default '{}'::jsonb,
  baseline      jsonb       not null,
  tolerance     numeric     not null default 0.001,
  source        text        not null,                 -- human | auto
  strength      text        not null default 'human', -- human | strong | weak
  status        text        not null default 'candidate', -- candidate | verified | rejected | stale
  verified_by   text,
  verified_at   timestamptz,
  last_checked_at timestamptz,
  last_check_result text,                              -- pass | fail | error
  session_id    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (source in ('human','auto')),
  check (strength in ('human','strong','weak')),
  check (status in ('candidate','verified','rejected','stale'))
);
create unique index if not exists verified_questions_org_metric_q_idx
  on data.verified_questions (org, metric_id, md5(question), md5(params::text), md5(slicing::text));
create index if not exists verified_questions_org_status_idx
  on data.verified_questions (org, status);
```

- [ ] **Step 4: 实现域模块**

`verified-questions.ts`：类型 + 四个函数。

**冲突语义（2026-11-04 评审后定案，覆盖 brief 原 SQL）**：

| 场景 | 规则 |
|---|---|
| 唯一键 | `(org, metric_id, md5(question), md5(params::text), md5(slicing::text))` —— **slicing 必须进键**：同题同参不同切面 = 不同结果基线，不能合行 |
| 已 `verified` 行 | `status`/`verified_by`/`verified_at` **恒冻结**（任何人任何信号都不改——审计不能把人工确认人抹成 `auto:strong`）；`baseline`/`slicing`/`tolerance` 只有 `source='human'` 或 `strength='strong'` 可覆盖，覆盖时清空 `last_check_result` |
| 已 `rejected` 行 | **自动信号不得复活**（status 保持 rejected）；只有 `source='human'` 的 `setStatus` 能重开 |
| `source`/`strength` | 取「最强」：`human > strong > weak`；不得出现 status=verified 而 strength=weak 的行。**`setStatus(...,'verified', by)` 必须同时把 `source`/`strength` 升为 `human`**（Task 2 实现确认路径时落地） |
| `setStatus(...,'verified')` | `by` 为空 ⇒ 抛错（审计必须能回答「谁确认的」） |
| `tolerance` 默认值 | 只在表定义写一次；insert 不重复写默认 |

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run modules/data/domain/verified-questions.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add modules/data/migrations/032_verified_questions.sql modules/data/domain/verified-questions.ts modules/data/domain/verified-questions.test.ts
git commit -m "feat(data): verified_questions 存储层（迁移 032）"
```

---

### Task 2: 平台 API（列出 / 确认 / 拒绝）

**Files:**
- Create: `modules/data/routes/verified-questions.ts`
- Modify: `modules/data/manifest.yaml`（声明路由 + scope）
- Test: `modules/data/routes/verified-questions.test.ts`

**Interfaces:**
- Consumes: Task 1 的四个函数。
- Produces: `GET /metrics/verified`（读，`data:query`）、`POST /metrics/verified/:id/verify`、`POST /metrics/verified/:id/reject`（写，`data:manage`）。

**装配提示（照 `routes/metrics.ts` 既有形态，不要另造）**：
- `orgOf(c) = c.get('tenant').casdoor_org`；身份用该文件同款 `requesterOf(c)`。
- 写端点返回值走同文件的 `writeOutcome(c, outcome, 200)` 判别式封装（别自己拼状态码）。
- manifest 声明必须与路由集合**逐条一致**（装载期双向核对，漏声明 = 403）：

```yaml
    # ── 已验证问答（W1 可信度地基）──
    - { method: GET,  path: /metrics/verified,            scope: data:query }
    - { method: POST, path: /metrics/verified/:id/verify, scope: data:manage }
    - { method: POST, path: /metrics/verified/:id/reject, scope: data:manage }
```

- **确认/拒绝都必须记操作人**：新增迁移 `033_verified_question_decisions.sql` 加
  `decided_by text` / `decided_at timestamptz`（`add column if not exists`，不改已应用过的 032）；
  `setStatus` 的 verify 与 reject 两条分支都要写这两列。`verified_by`/`verified_at` 只表示「谁确认过」，
  不再兼任拒绝记录。
- **确认路径必须把 `source`/`strength` 升为 `human`**（Task 1 计划定案；否则出现「verified + weak」行）。在 `setStatus` 内实现，不要只在路由里做。
- `:id` 是 `bigserial` ⇒ 用该文件的 `parseIdParam` 解析（与指标 `text` id 的 `metricIdOf` **不同**，别混）。

- [ ] **Step 1: 写失败测试**（按 `routes/metrics.test.ts` 的既有装配方式）
- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现路由 + manifest 声明**（**漏声明 = 403，装载期双向核对**）
- [ ] **Step 4: 跑绿**：`npx vitest run modules/data/routes/verified-questions.test.ts`
- [ ] **Step 5: 提交**：`feat(data): 已验证问答 API（列/确认/拒绝）`

---

### Task 3: 回归核心（结构 + 容差）与 CLI

**Files:**
- Create: `modules/data/domain/verified-regression.ts`
- Create: `scripts/verify-regression.mjs`
- Test: `modules/data/domain/verified-regression.test.ts`

**Interfaces:**
- Consumes: `runQuery(deps, org, requester, metricId, args, slicing)` → `QueryOk{columns,rows}`。
- Produces: `summarize(ok: QueryOk): Baseline`、`compare(baseline, current, tolerance): {ok: boolean, diffs: string[]}`、`runRegression(pool, org, ids?)`。

**比较规则（逐条实现，不许放宽）**：
1. `columns` 集合与顺序不一致 ⇒ fail。
2. `rowCount` 不一致 ⇒ fail。
3. 每个数值列的 `sum/min/max`：`|cur - base| <= max(abs(base) * tol, 1e-9)`，否则 fail。
4. 非数值列只比 null 计数。
5. `QueryOk` 非 ok（denied/error）⇒ fail（reason 记入 diffs）。

- [ ] **Step 1: 写失败测试**

```ts
it('列集变化 / 行数变化 / 数值超出容差 ⇒ fail；容差内 ⇒ pass', () => {
  const base = { columns: ['value'], rowCount: 1, summary: { value: { sum: 1000, min: 1000, max: 1000, nulls: 0 } } }
  expect(compare(base, { columns: ['value'], rowCount: 1, summary: { value: { sum: 1000.5, min: 1000.5, max: 1000.5, nulls: 0 } } }, 0.001).ok).toBe(true)
  expect(compare(base, { columns: ['value'], rowCount: 1, summary: { value: { sum: 1002, min: 1002, max: 1002, nulls: 0 } } }, 0.001).ok).toBe(false)
  expect(compare(base, { columns: ['value','branch'], rowCount: 1, summary: { value: { sum: 1000, min: 1000, max: 1000, nulls: 0 } } }, 0.001).ok).toBe(false)
})
```

- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现纯函数 + `runRegression`**（重放用 `requester = { userId:'(regression)', orgId:org, channel:'pat', keyId:null, scopes:[], hasScope:()=>true }`；这是**平台回归特权**，在注释里写明理由）
- [ ] **Step 3b: `loadAdoptedSources(pool, org)` 落在 `scripts/tenant-sources.ts`（不是域模块）**：B1 架构门禁禁止 `modules/**` 引用 `platform.*`（`lint-architecture.mjs` 扫描 `modules/`），域模块内写 `platform.tenant` 会真红。按 `scripts/provision-tenant.mjs:18` 的先例，**从 `apps/server/src/tenant-source.ts` import** `SOURCES_ENABLED_SQL`/`listEnabledSources`，并复用/导出 `resolveTenantIdByOrg`——**不要复制 SQL**（该文件头注声明它是唯一事实源）。`scripts/verify-regression.mjs` 用它装配 `{ pool, adoptedSources }` 后调 `runRegression`。
- [ ] **Step 4: 跑绿**
- [ ] **Step 5: 提交**：`feat(data): 已验问答回归（结构 + 相对容差）`

---

### Task 4: bot 侧信号识别（verify.py）

**Files:**
- Create: `scripts/askdata/verify.py`
- Modify: `scripts/askdata/sync-and-run.sh`（多跑一步 + 水位）
- Test: `scripts/askdata/test_verify.py`（fixture 驱动，纯函数）

**信号规则（初始值，标注待标定）**：

| 档 | 判据 |
|---|---|
| **强** | bot 回答后 **≤2 个用户回合**内出现肯定词（`对/对了/没错/就是/准确/谢谢`）且**之后无**否定词 |
| **弱** | 无肯定词、无否定词，且会话结束或用户转向**不同**问题 |
| **负** | 出现否定词（`不对/不是/错了/再查/重新/算错`），或同一问题在会话内被以**不同参数**重问 |

- 从 toolResult 里提取 `metricId/params/slicing` 与结果，构造候选载荷。
- 必须显式读 `ASK_VERIFY_ORG`；缺失 `exit 1`。
- 写出：OO `askdata_verified`（沿用 `OO_BASE/OO_ORG/OO_AUTH`）。
- 水位：`ASK_VERIFY_WM` 每 agent 一份（同 #963）。

- [ ] **Step 1: 写失败测试**（三条 fixture：强/弱/负）——**纯 `unittest`，不引入 pytest**（本机无 pytest，且该目录约定零依赖）
- [ ] **Step 2: 跑红**：`python3 -m unittest scripts/askdata/test_verify.py -v`
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑绿**
- [ ] **Step 5: 提交**：`feat(askdata): 已验问答信号识别（强/弱/负）`

---

### Task 5: 平台侧摄入（OO 只读拉取）

**Files:**
- Create: `scripts/verify-ingest.mjs`
- Test: `scripts/verify-ingest.test.ts`（fetch 全注入）

**Interfaces:**
- Consumes: OO `_search`（`OO_READ_URL` / `OO_READ_ORG` / `OO_READ_TOKEN`）+ Task 1 `upsertCandidate` + Task 3 `summarize`/`runQuery`。
- Produces: 水位文件 `ASK_VERIFY_INGEST_WM`（按流一份）；幂等 upsert（唯一索引去重）。

**基线从哪来（关键）**：事件只带 `question / metricId / params / slicing`，**不带结果**（轨迹里的工具回包可能被截断/格式化，不可当基线）。摄入方在落库前**重放一次** `runQuery` 并用 `summarize(QueryOk)` 生成 baseline；重放失败则写 `status='candidate'` 且 `last_check_result='error'`，**不猜**。

**部署前置（需用户点名确认新增 secret）**：
- server 服务行新增 `OO_READ_URL` / `OO_READ_ORG` / `OO_READ_TOKEN`（**只读**）；取值位置：控制面 OO 凭据管理，**不写值**。

- [ ] **Step 1: 写失败测试**（fake fetch：强信号 → verified；弱信号 → candidate；重复投递幂等）
- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现**（`_search` 用 RFC3339 UTC 时间窗；按 `id > 水位` 前进，成功后写水位）
- [ ] **Step 4: 跑绿**：`npx vitest run scripts/verify-ingest.test.ts`
- [ ] **Step 5: 提交**：`feat(data): 已验问答摄入（OO 只读拉取 + 水位）`

---

### Task 6: 收口（真机验收 + 台账）

- [ ] **Step 1: 造 10 条已验问答**（人工 API 写入，覆盖：单指标、带维度、比率类）
- [ ] **Step 2: 改一条口径（测试环境）→ 跑回归 → 必须报红**

```bash
npx tsx scripts/verify-regression.mjs --org <org> --limit 10
```

- [ ] **Step 3: 跑全量**：`pnpm -r test && pnpm run test:guard`、`pnpm run typecheck`
- [ ] **Step 4: 更新路线图 §5 台账**（W1 →「进行中（实现完成，待 PR）」，证据写命令与输出摘要）
- [ ] **Step 5: 提交**：`docs(plans): W1 收口与台账`

---

## Self-Review

**1. Spec coverage**
- 人工/自动双源 → Task 2（人工）/ Task 4-5（自动）✅
- 强/弱/负分档 → Task 1（status 语义）+ Task 4（判据）✅
- 结构 + 容差回归 → Task 3 ✅
- OO 中转 → Task 4（写）+ Task 5（读）✅
- 双臂 eval → **不在本波**（路线图 §7 已记录挪到 W2）✅

**2. Placeholder scan**：无 TBD；阈值词表给了初始值并标注「待标定」；secret 只写位置不写值。

**3. Type consistency**：`Baseline = { columns: string[]; rowCount: number; summary: Record<string, {sum,min,max,nulls}> }` 在 Task 1/3 一致；`upsertCandidate` 的 `strength` 与表中 CHECK 一致。
