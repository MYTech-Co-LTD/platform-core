# 目标平台件 A/B/C 实施计划（表单字段级通路 / 收集轮次 / 目标第一刀）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec `docs/superpowers/specs/2026-11-23-goal-plan-vs-actual-platform-design.md` 的三块通用件与首个消费者：「月度 × 门店 × 销售/出库目标」的录入→语义→看板全链。

**Architecture:** 件① opt-in 表单字段契约 → 生成的 dbt 摊平模型（DuckDB 段只碰 parquet，取列 `r['列名']` 形态，join 一律拆到 PG 原生模型）；件③ 收集轮次（名单轮 + 值集轮）；目标件 = goals.yml 声明 + 两段生成关系（DuckDB 摊平 + PG 原生达成模型）+ L1 ratio/expression 指标，报表/告警/推送零新语义。

**Tech Stack:** platform-core（Hono/pg/dbt/pg_duckdb/duckle/Vite React）；目标场景落**山海数据面**（`platform-core-shanhai-data` @8281d598）。

## Repo / 波次

- 全部代码在 platform-core 单仓；执行按 Orca 波次：
  - **Wave G1（并行两 worker）**：A 期（Phase A 任务，`oa-g1-datapath`）+ B 期（Phase B 任务，`oa-g1-rounds`）
  - **Wave G2**：C 期（Phase C 任务，`oa-g2-goal`）——等 G1 全部合并后启动
  - Wave G0：已单独派发（OA 对账调度登记 `oa-sched-registry`，与本计划互不阻塞）
- 每个 Phase 一个 worker 串行完成其任务（同文件域），Phase 间可并行。

## Global Constraints

- Conventional Commits；feat/fix PR 必须 `Closes` **本计划 Task 0 建的子 issue**（epic 用 `Refs`，保持 open）。
- 迁移幂等：当前 forms 迁移止于 `003_external_approval.sql`，本计划用 `004_collection_rounds.sql`；server 迁移止于 `022_wecom_approval.sql`。
- 件① 是 **opt-in**：不声明 `dataPlane` 的表单行为逐字不变；`stg_forms_submission` 不动（varchar 决策保持）。
- DuckDB 段（含 read_parquet 的模型）**只碰 parquet**，取列 `r['列名']::type`；join PG 关系一律拆 PG 原生模型（探针已证，2026-11-23）。
- 生成物纪律：**生成物 == committed**（`--check` 门禁），手改会被静默回写——改列集只改契约/声明源。
- L1 指标名 `<源>:<域>:<指标>`；expression 单关系形态；新增指标进 `dbt/semantics/l1_metrics.yml` + `sync-data-semantics.mjs`。
- 摊平列名一律 `f_` 前缀 + snake_case（避开 batch_id/bizday/submission_id/form_def_id/submitted_at/org/payload 保留列）。
- 目标场景落山海数据面；合并后需手动触发 `platform-core-shanhai-data` 部署（autoDeploy=false）再验收。
- 敏感值不进仓库；测试用独立 DB（并行 worktree 共库会串味）。
- 北京时间汇报；企微 deep link 指向 `/m` 或 `/app`（移动业务面）。

---

## Task 0: issue + 子 issue（执行前一次性）

**Files:** 无代码。

- [ ] 在 platform-core 建 epic：`feat(oa): 目标平台件——表单字段级通路/收集轮次/计划vs实际`（body 引 spec 路径），记录编号 `#GOAL`。
- [ ] 建子 issue：`A 件① 表单字段级数据通路`、`B 件③ 收集轮次`、`C 目标第一刀`，各记编号（后续 PR 分别 `Closes` 子 issue + `Refs #GOAL`）。
- [ ] 每 worker 开工时先 `git fetch origin main` 再切分支。

---

# Phase A：件① 表单字段级数据通路

**文件结构（A 期全部产物）**

| 文件 | 职责 |
|---|---|
| `modules/forms/domain/contract.ts`（改） | compileGate 增 `dataPlane` 校验（opt-in 字段白名单/命名） |
| `modules/forms/storage.ts`（改） | `listDataPlaneForms(pool)`：published + dataPlane.enabled 的 form_def |
| `scripts/gen-forms-data-projection.mjs`（新） | 读库 → 生成 `contracts/forms/data-plane/*.json` + `dbt/models/forms/staging/stg_forms_submission__<slug>.sql`；`--check` 模式 |
| `contracts/forms/data-plane/`（生成） | 字段契约（field→column/type 映射） |
| `dbt/models/forms/staging/stg_forms_submission__<slug>.sql`（生成） | DuckDB 摊平模型（见 A2 模板） |
| `.github/workflows/ci.yml`（改） | gates 追加 `node scripts/gen-forms-data-projection.mjs --check` |
| `modules/forms/domain/contract.test.ts`（改） | dataPlane 校验测试 |

### Task A1: opt-in 声明与契约闸

**Files:**
- Modify: `modules/forms/domain/contract.ts`
- Modify: `modules/forms/domain/contract.test.ts`
- Modify: `modules/forms/storage.ts`

**Interfaces:**
- Consumes: 既有 `compileGate` 与 `schemaOf`。
- Produces: `compileGate` 对 `dataPlane.enabled=true` 的契约新增闸：字段名 `/^[a-z][a-z0-9_]{0,63}$/`（错误码 `DATA_PLANE_FIELD_NAME_INVALID`）、类型白名单 `{string, number, integer, boolean}` 或 `string + format:'date'`（错误码 `DATA_PLANE_TYPE_UNSUPPORTED`，附字段名）；`storage.listDataPlaneForms(pool)` → `Array<{org, assetId, version, slug, fields: Array<{field, column, kind}>}>`，slug = assetId 原样（已是 [a-z0-9-]）。

- [ ] **Step 1: 写失败测试**（contract.test.ts 追加）

```ts
it('dataPlane.enabled：字段名非法 ⇒ DATA_PLANE_FIELD_NAME_INVALID', () => {
  const r = compileGate({ schema: { type: 'object', properties: {
    'Goal Sale': { type: 'number' } } }, dataPlane: { enabled: true } } as never)
  expect(r.ok).toBe(false)
  expect(r).toMatchObject({ code: 'DATA_PLANE_FIELD_NAME_INVALID' })
})
it('dataPlane.enabled：嵌套对象字段 ⇒ DATA_PLANE_TYPE_UNSUPPORTED', () => {
  const r = compileGate({ schema: { type: 'object', properties: {
    items: { type: 'array', items: { type: 'string' } } } }, dataPlane: { enabled: true } } as never)
  expect(r).toMatchObject({ ok: false, code: 'DATA_PLANE_TYPE_UNSUPPORTED' })
})
it('未声明 dataPlane ⇒ 行为逐字不变（含嵌套字段放行）', () => {
  expect(compileGate({ schema: { type: 'object', properties: {
    items: { type: 'array', items: { type: 'string' } } } } as never).ok).toBe(true)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run modules/forms/domain/contract.test.ts`
Expected: FAIL（无 dataPlane 分支）。

- [ ] **Step 3: 实现 compileGate 分支**

contract.ts 的 compileGate 入口处：

```ts
const dp = (body as Record<string, unknown>)?.['dataPlane'] as { enabled?: boolean } | undefined
if (dp?.enabled) {
  const props = (schemaOf(body) as Record<string, unknown>)?.['properties'] as Record<string, unknown> ?? {}
  for (const [name, def] of Object.entries(props)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name))
      return fail('DATA_PLANE_FIELD_NAME_INVALID', `dataPlane 字段名须 ^[a-z][a-z0-9_]{0,63}$：${name}`)
    const d = (def ?? {}) as Record<string, unknown>
    const t = d.type as string
    const okType = ['string','number','integer','boolean'].includes(t)
      || (t === 'string' && d.format === 'date')
    const isEnum = Array.isArray(d.enum) && d.enum.every((v) => typeof v === 'string')
    if (!okType && !isEnum)
      return fail('DATA_PLANE_TYPE_UNSUPPORTED', `dataPlane 字段类型不支持：${name}（v1 白名单 string/number/integer/boolean/date/enum）`)
    if (d.properties || d.items)
      return fail('DATA_PLANE_TYPE_UNSUPPORTED', `dataPlane 字段不支持嵌套/数组：${name}`)
  }
}
```

`storage.ts` 追加：

```ts
export interface DataPlaneForm {
  org: string; assetId: string; version: number; slug: string
  fields: Array<{ field: string; column: string; kind: 'string'|'number'|'integer'|'boolean'|'date'|'enum' }>
}
const DATA_PLANE_KINDS: Record<string, DataPlaneForm['fields'][number]['kind']> = {
  string: 'string', number: 'number', integer: 'integer', boolean: 'boolean',
}
export async function listDataPlaneForms(pool: Pool): Promise<DataPlaneForm[]> {
  const { rows } = await pool.query(
    `select v.org, v.asset_id, v.version, v.body
       from forms.asset_version v
       join forms.asset_head h on h.org=v.org and h.kind=v.kind
        and h.asset_id=v.asset_id and h.active_version=v.version
      where v.kind='form_def' and v.status='published'
        and v.body->'dataPlane'->>'enabled' = 'true'`)
  return rows.flatMap((r) => {
    const props = ((r.body as any)?.schema?.properties ?? {}) as Record<string, any>
    const fields = Object.entries(props).flatMap(([field, def]) => {
      const t = def?.type as string
      const kind = t === 'string' && def?.format === 'date' ? 'date'
        : Array.isArray(def?.enum) ? 'enum' : DATA_PLANE_KINDS[t as string]
      return kind ? [{ field, column: `f_${field}`, kind }] : []
    })
    return fields.length > 0
      ? [{ org: r.org, assetId: r.asset_id, version: r.version, slug: r.asset_id, fields }]
      : []
  })
}
```

- [ ] **Step 4: 跑测试**

Run: `pnpm vitest run modules/forms/domain/contract.test.ts modules/forms/kernel.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add modules/forms/domain/contract.ts modules/forms/domain/contract.test.ts modules/forms/storage.ts
git commit -m "feat(forms): 表单 dataPlane opt-in 契约闸与清单（#GOAL）"
```

### Task A2: 契约生成器 + `--check` 门禁 + CI 接线

**Files:**
- Create: `scripts/gen-forms-data-projection.mjs`
- Create: `contracts/forms/data-plane/.gitkeep`（目录占位）
- Modify: `.github/workflows/ci.yml`（gates 追加一行）
- Test: `scripts/gen-forms-data-projection.test.mjs`

**Interfaces:**
- Consumes: `storage.listDataPlaneForms`（A1）。
- Produces: `node scripts/gen-forms-data-projection.mjs [--check]`；产物 = `contracts/forms/data-plane/<slug>.json` + `dbt/models/forms/staging/stg_forms_submission__<slug>.sql`（逐 slug 一模型）。

- [ ] **Step 1: 写失败测试**（fake pg 行注入，断言生成物内容与 --check 行为）

```js
import { describe, it, expect } from 'vitest'
import { buildContract, buildModelSql } from './gen-forms-data-projection.mjs'

const form = { org: 'acme', assetId: 'goal-monthly-store', version: 1, slug: 'goal-monthly-store',
  fields: [
    { field: 'branch_num', column: 'f_branch_num', kind: 'string' },
    { field: 'period', column: 'f_period', kind: 'string' },
    { field: 'target_sale', column: 'f_target_sale', kind: 'number' },
    { field: 'target_outbound', column: 'f_target_outbound', kind: 'number' },
  ] }

it('buildContract：字段→列/类型映射', () => {
  expect(buildContract(form)).toEqual({
    form_def_id: 'goal-monthly-store', org: 'acme', version: 1,
    columns: [
      { field: 'branch_num', column: 'f_branch_num', kind: 'string', sql_type: 'varchar' },
      { field: 'period', column: 'f_period', kind: 'string', sql_type: 'varchar' },
      { field: 'target_sale', column: 'f_target_sale', kind: 'number', sql_type: 'decimal(18,4)' },
      { field: 'target_outbound', column: 'f_target_outbound', kind: 'number', sql_type: 'decimal(18,4)' },
    ],
  })
})
it('buildModelSql：read_parquet + form_def_id 过滤 + json_extract_string + r[列] 形态', () => {
  const sql = buildModelSql(form)
  expect(sql).toContain("r['form_def_id'] = 'goal-monthly-store'")
  expect(sql).toContain("json_extract_string(r['payload'], '$.branch_num')")
  expect(sql).toContain('cast(json_extract_string(r[\'payload\'], \'$.target_sale\') as decimal(18,4)) as f_target_sale')
  expect(sql).toContain("from read_parquet(")
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run scripts/gen-forms-data-projection.test.mjs`
Expected: FAIL。

- [ ] **Step 3: 实现**

生成器骨架（照 `scripts/gen-data-projection.mjs` 的「生成物==committed；--check 比对」骨架）：

```js
// 类型映射（单一事实源，与 A1 的 kind 一致）
const SQL_TYPE = { string: 'varchar', enum: 'varchar', date: 'date',
  number: 'decimal(18,4)', integer: 'bigint', boolean: 'boolean' }
const EXTRACT = {
  string:  (c, p) => `json_extract_string(r['payload'], '$.${p}') as ${c}`,
  enum:    (c, p) => `json_extract_string(r['payload'], '$.${p}') as ${c}`,
  date:    (c, p) => `cast(json_extract_string(r['payload'], '$.${p}') as date) as ${c}`,
  number:  (c, p) => `cast(json_extract_string(r['payload'], '$.${p}') as decimal(18,4)) as ${c}`,
  integer: (c, p) => `cast(json_extract_string(r['payload'], '$.${p}') as bigint) as ${c}`,
  boolean: (c, p) => `(json_extract_string(r['payload'], '$.${p}') in ('true','1')) as ${c}`,
}
```

模型模板（生成的 SQL，注意：**DuckDB 段只碰 parquet，无任何 join**）：

```sql
-- 生成物：scripts/gen-forms-data-projection.mjs — 手改会被 --check 回写
-- 契约：contracts/forms/data-plane/<slug>.json
select
  r['batch_id']::varchar as batch_id,
  {{ subject_org() }} as org,
  r['bizday']::date as bizday,
  r['submission_id']::bigint as submission_id,
  r['form_def_id']::varchar as form_def_id,
  r['submitted_at']::timestamptz as submitted_at,
  <逐字段 EXTRACT 行>
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("forms_submission_prefix") }}/bizday=*/batch_id=*/all.parquet'
) r
where r['form_def_id'] = '<asset_id>'
```

`--check`：重新生成全部产物并与 committed 逐字节比对，不一致 → 打印 diff 文件名并 `process.exitCode = 1`。

- [ ] **Step 4: DB 读取**

照 `notify-reconcile.mjs` 的 DB 依赖姿势（延迟 import `pg` + `DATABASE_URL`），调 `listDataPlaneForms` 的 JS 等价（脚本内直接写同一 SQL，避免 import modules/——scripts 不在 B1 扫描根，可 import，但为保持脚本自包含照 notify-reconcile 直写 SQL 亦可；二选一以「与 notify-reconcile 同构」为准）。

- [ ] **Step 5: CI 接线**

`.github/workflows/ci.yml` 的 gates 步骤（现有 `check-data-contract` / `gen-data-projection --check` 所在命令串）追加：

```yaml
node scripts/gen-forms-data-projection.mjs --check
```

- [ ] **Step 6: 跑测试与门禁**

Run: `pnpm vitest run scripts/gen-forms-data-projection.test.mjs`
Run: `node scripts/gen-forms-data-projection.mjs --check`（无 DB 时应报「无 DATABASE_URL，跳过」并 exit 0——照 notify-reconcile 的 skip 约定）
Run: `pnpm run typecheck:scripts`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add scripts/gen-forms-data-projection.mjs scripts/gen-forms-data-projection.test.mjs contracts/forms/data-plane .github/workflows/ci.yml
git commit -m "feat(forms): dataPlane 字段契约生成器与 --check 门禁（#GOAL）"
```

### Task A3: 首个摊平模型 + L1 forms 指标

**Files:**
- Create: `dbt/models/forms/staging/stg_forms_submission__<slug>.sql`（由生成器产出，slug 用真实测试表单）
- Modify: `dbt/semantics/l1_metrics.yml`（首条 forms 指标）
- Test: 真仓验收步骤（数据面容器内执行）

**Interfaces:**
- Produces: 关系 `stg_forms_submission__<slug>`（列 = 头列 + `f_*`）；L1 `forms:ops:<指标名>`；报表/问数可引用。

- [ ] **Step 1: 准备真实 opt-in 表单与提交**

在目标数据面（A 期先在 mytech 面）：建一个含 2–3 个 dataPlane 字段的表单（如 `ops-round-2026-11`：`store_name(string)`、`check_count(number)`、`done(bool)`），发布并提交 ≥2 条（经表单 API/console 填报）。**dataPlane.enabled 在契约闸下发布**（A1 的门）。

- [ ] **Step 2: 跑生成器落产物**

```bash
DATABASE_URL=... node scripts/gen-forms-data-projection.mjs
git add contracts/forms/data-plane dbt/models/forms/staging
git commit -m "feat(data): 首个 dataPlane 表单摊平模型与契约（#GOAL）"
```

- [ ] **Step 3: L1 声明**

`dbt/semantics/l1_metrics.yml` 追加（示例字段按真实表单字段替换）：

```yaml
- name: forms:ops:check_count_total
  label: 巡检完成件数（合计）
  definition: dataPlane 表单 ops-round-2026-11 的 check_count 求和（验证字段级通路）
  expression: 'sum(stg_forms_submission__ops_round_2026_11.f_check_count)'
  grain: [stg_forms_submission__ops_round_2026_11.f_store_name]
  owner: data
  tier: L1
  sources: [forms]
  freshness_sla_days: 2
```

（⚠️ 模型名里的连字符在 relation 名里转下划线——生成器产出模型文件名与 relation 名都要做 `replace(/-/g,'_')` 归一，A2 模板与 `buildContract` 里 `slug`→`relationSlug` 字段锁定此规则。）

- [ ] **Step 4: 真仓验收（数据面容器内，照「先验证再做」纪律）**

```bash
# 1) 摊平模型构建
dbt build --select stg_forms_submission__<slug 归一>
# 2) 语义 sync + 编译查询
node scripts/sync-data-semantics.mjs
# 用 data 模块的 query API 或编译出的 select_sql 直接查
```

Expected: 模型 PASS；指标可查且数值 = 提交值合计；grain 维度正确。
**并行 worktree 共库会串味：本步用独立 DB 或直接在数据面容器跑。**

- [ ] **Step 5: 提交 + PR**

PR：`Closes` A 子 issue，`Refs #GOAL`。Report: dbt run 输出、指标查询结果。

---

# Phase B：件③ 收集轮次

**文件结构**

| 文件 | 职责 |
|---|---|
| `modules/forms/migrations/004_collection_rounds.sql` | 轮次/目标/值集锚三表（幂等） |
| `modules/forms/storage.ts`（改） | 轮次 CRUD/开闭/进度/锚快照 |
| `modules/forms/routes.ts`（改） | `/rounds` CRUD + 开轮/关轮 + 进度查询；提交带 roundId |
| `modules/forms/manifest.yaml`（改） | `forms.collection.assigned` / `forms.collection.due` 事件真声明 + 路由声明 |
| `modules/forms/console/`（改） | 轮次管理页签（列表/开轮/进度） |
| `modules/forms/routes.test.ts` 等 | 测试 |

### Task B1: 三表迁移 + storage

**Files:**
- Create: `modules/forms/migrations/004_collection_rounds.sql`
- Modify: `modules/forms/storage.ts`
- Test: `modules/forms/kernel.test.ts`（追加）

**Interfaces:**
- Produces:
```sql
forms.collection_round(
  id bigserial primary key,
  org text not null,
  asset_id text not null, version int not null,
  round_key text not null,             -- 如 2026-11
  kind text not null check (kind in ('targets','value_grid')),
  name text not null,
  starts_at timestamptz, ends_at timestamptz,
  status text not null default 'draft' check (status in ('draft','open','closed')),
  created_by text not null, created_at timestamptz not null default now(),
  unique (org, asset_id, round_key))
forms.collection_target(            -- 名单轮：谁该交
  round_id bigint references forms.collection_round(id),
  org text not null, user_name text not null,
  status text not null default 'pending' check (status in ('pending','submitted','waived')),
  submission_id bigint, updated_at timestamptz not null default now(),
  primary key (round_id, user_name))
forms.collection_anchor(            -- 值集轮：期望维度格子快照（开轮时生成）
  round_id bigint, org text not null,
  anchor_key text not null,          -- 如 dim 复合键或 store 标识
  status text not null default 'pending' check (status in ('pending','submitted','waived')),
  submission_id bigint, updated_at timestamptz not null default now(),
  primary key (round_id, anchor_key))
```
另：`alter table forms.submission add column if not exists round_id bigint;`
- Produces storage：`createRound/openRound/closeRound/getRound/listRounds/setAnchorSubmitted/setTargetSubmitted/roundProgress(roundId)`（progress = `{total, submitted, pending, byAnchor?}`）；`submission` 路径带 `roundId` 时写 `round_id` 并置对应 target/anchor 行 `submitted`。

- [ ] **Step 1: 写失败测试**（kernel.test.ts 追加：开轮→按 anchor 提交→progress 变化→重复提交幂等→关轮后提交被拒）
- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run modules/forms/kernel.test.ts`
Expected: FAIL（表/函数不存在）。

- [ ] **Step 3: 迁移 + storage**（SQL 逐字照上面 Interfaces 块；storage 每函数一 SQL 封装，幂等 upsert；`closeRound` 校验 status='open'）
- [ ] **Step 4: 提交路由联动**：`routes.ts` 的 `POST /defs/:assetId/submissions` 当 body 带 `roundId` 时（表单版本属该轮）写 submission.round_id 并调 `setAnchorSubmitted/setTargetSubmitted`；round 非 open ⇒ 409 `ROUND_NOT_OPEN`。
- [ ] **Step 5: 跑测试并提交**

Run: `pnpm vitest run modules/forms/kernel.test.ts modules/forms/routes.test.ts`
Expected: PASS。

```bash
git add modules/forms/migrations/004_collection_rounds.sql modules/forms/storage.ts modules/forms/routes.ts modules/forms/kernel.test.ts modules/forms/routes.test.ts
git commit -m "feat(forms): 收集轮次三表与提交联动（#GOAL）"
```

### Task B2: 路由 + 事件真声明 + 进度/催办

**Files:**
- Modify: `modules/forms/routes.ts`、`storage.ts`、`manifest.yaml`
- Test: `routes.test.ts`、`mcp.test.ts`

**Interfaces:**
- Produces:
  - `POST /rounds`（建轮+锚快照入参 anchors[]）/`GET /rounds`/`GET /rounds/:id`（含 progress）/`POST /rounds/:id/open`/`close`
  - 事件：`forms.collection.assigned`（开轮逐 anchor/逐人 emit，eventId `forms:round:<id>:assigned:<key>`）、`forms.collection.due`（到期未交，eventId 含日期）
  - `defaults` + 内置模板 `oa_collection_assigned` / `oa_collection_due`（templates/seed-builtin 三处同描——P2 经验：漏一处 = no_rules 静默丢）

- [ ] **Step 1: 失败测试**：开轮 → 收件箱/回执出现 assigned（用既有 notify 测试壳）；due 事件幂等。
- [ ] **Step 2: 路由与事件**（emit 用 `ctx.notify.emit`，org 钉 identity）
- [ ] **Step 3: manifest 逐条对齐**（路由↔声明双向核对；事件两条 + defaults + 模板三处）
- [ ] **Step 4: 跑测试**

Run: `pnpm vitest run modules/forms/routes.test.ts modules/forms/mcp.test.ts modules/notify/*.test.ts; pnpm smoke`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add modules/forms/routes.ts modules/forms/storage.ts modules/forms/manifest.yaml modules/notify/templates/builtin.ts modules/notify/seed-builtin.ts modules/forms/routes.test.ts
git commit -m "feat(forms): 收集轮次路由/事件/模板三处同描（#GOAL）"
```

### Task B3: console 轮次管理页

**Files:**
- Modify: `modules/forms/console/`（Rounds.tsx 列表+开轮弹窗+进度；index.tsx 页签）
- Test: `console.test.tsx` 追加（platformFetch mock 形态）

- [ ] Step 1–4：测试先行 → 页面（列表：round_key/kind/状态/进度条；开轮表单：round_key/name/anchors 文本域）→ 构建与 smoke → 提交 `feat(forms): 收集轮次管理页（#GOAL)`。

---

# Phase C：目标第一刀

**文件结构**

| 文件 | 职责 |
|---|---|
| `dbt/semantics/goals.yml`（新） | 目标定义声明（D2 YAML 形状） |
| `scripts/gen-goal-achievement.mjs`（新） | 读 goals.yml + l1_metrics.yml → 生成两段模型；`--check` |
| `dbt/models/goals/stg_goal_values__<goal>.sql`（生成） | 段① DuckDB 摊平（forms parquet filter form_def+round，取 value_fields） |
| `dbt/models/goals/mart_goal_achievement__<goal>.sql`（生成） | 段② PG 原生：join 段① + actual 关系 + 日期 spine → achievement_rate/progress_rate/data_status |
| `dbt/semantics/l1_metrics.yml`（改） | 每 goal×metric 两条指标（achievement_rate/progress_rate） |
| `modules/data/domain/report-templates.ts`（改） | 内置模板「目标达成」 |
| `apps/server/src/scheduler/registry.ts`（改） | `goal.daily_push` job（emit `forms.goal.daily`） |
| `modules/forms/manifest.yaml`（改） | 事件 `forms.goal.daily` + 模板 |
| 测试 | 生成器单测 + 真仓验收 |

### Task C1: goals.yml schema + 两段生成器

**Files:**
- Create: `dbt/semantics/goals.yml`、`scripts/gen-goal-achievement.mjs`、`scripts/gen-goal-achievement.test.mjs`
- Create/生成: `dbt/models/goals/*.sql`
- Modify: `.github/workflows/ci.yml`（gates 追加 `--check`）

**Interfaces:**
- Consumes: A 期 `stg_forms_submission__<slug>`（DuckDB 段直接 filter 同一 form_def + `round_id` 从提交行取——**round_id 在段① SELECT 里加**：`r['round_id']::bigint as round_id`？⚠️ round_id 不在湖里（它在 PG submission 行）——段① 从 parquet 取不到。**修正**：段① 按提交行过滤口径 = form_def_id + bizday 周期；round 归属由段② join `forms` 库？❌ 跨库。**定案**：goals.yml 的 target_source 走 A 期摊平模型（`relation: stg_forms_submission__<slug>`，按 `f_period` 字段取周期）——**round_id 不需要进湖**，目标是「维度×周期×值」三列而已，周期就是普通 dataPlane 字段（`period` string）。段② join 段①表（PG）与 actuals 关系（PG）——纯 PG join，B1 合规。）
- Produces（生成的段① 模板）：

```sql
-- 生成物
select
  {{ subject_org() }} as org,
  r['submission_id']::bigint as submission_id,
  json_extract_string(r['payload'], '$.period') as period,
  json_extract_string(r['payload'], '$.branch_num') as branch_num,
  cast(json_extract_string(r['payload'], '$.target_sale') as decimal(18,4)) as target_sale,
  cast(json_extract_string(r['payload'], '$.target_outbound') as decimal(18,4)) as target_outbound,
  r['submitted_at']::timestamptz as submitted_at
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("forms_submission_prefix") }}/bizday=*/batch_id=*/all.parquet'
) r
where r['form_def_id'] = 'goal-monthly-store'
```

- Produces（生成的段② 模板骨架，PG 原生）：

```sql
-- 段②：join 段① + actuals（actuals 来自 goals.yml.actuals → l1_metrics.yml 的 expression 解析）
with goal as (
  select period, branch_num,
         max(target_sale) as target_sale, max(target_outbound) as target_outbound
  from {{ ref('stg_goal_values__monthly_store_sale') }}
  group by 1, 2
),
actual as (
  select date_trunc('month', biz_date) as period, branch_num,
         sum(sale_amount) as actual_sale, sum(outbound_amount) as actual_outbound
  from fct_retail_sale          -- 由 goals.yml.actuals 解析出的关系与列（生成器内联）
  where biz_date >= (select min(start)) and biz_date < (select max(end)+interval '1 month')
  group by 1, 2
),
spine as (  -- 时间进度：北京时钟日界
  select g.period, g.branch_num,
    greatest(least(current_date at time zone 'Asia/Shanghai'::text::date, g.last_day) - g.first_day + 1, 0) as days_elapsed,
    g.total_days
  from goal g
)
select g.period, g.branch_num,
  g.target_sale, a.actual_sale,
  case when g.target_sale > 0 then round(a.actual_sale / g.target_sale, 4) end as sale_achievement_rate,
  ... 同 outbound ...
  s.days_elapsed::decimal / s.total_days as progress_rate,
  case when (select count(distinct biz_date) from fct_retail_sale f
              where f.biz_date >= g.first_day and f.biz_date < g.last_day + 1) >= s.total_days
       then 'complete' when ... > 0 then 'partial' else 'missing' end as data_status
from goal g join actual a using (period, branch_num) join spine s using (period, branch_num)
```

（骨架即形状；日期 spine/字段以生成器按 goals.yml 渲染为准，测试钉住生成物包含 join/三态列。）

- [ ] **Step 1: 失败测试**：`buildStageOneSql(goal)` / `buildAchievementSql(goal, l1Index)` 断言（form_def 过滤、无 join 进段①、段②含 `join`、三态列存在、actuals 引用的 relation 从 l1 解析）。
- [ ] **Step 2: goals.yml 首条**（每月 × 门店 × sale/outbound；actuals 指 `lemeng:store:sale_amount` / `lemeng:store:outbound_amount`——**以 l1_metrics.yml 实际名为准，先 grep 确认**）。
- [ ] **Step 3: 生成器 + `--check` + CI 追加**（同 A2 骨架）。
- [ ] **Step 4: 真仓（山海数据面容器）**：`dbt build --select stg_goal_values__monthly_store_sale mart_goal_achievement__monthly_store_sale`（先在测试库）。
- [ ] **Step 5: L1 两条 + sync + 编译查询验证。**
- [ ] **Step 6: 提交 + PR（C 子 issue）。**

### Task C2: 报表模板 + 告警示例

**Files:**
- Modify: `modules/data/domain/report-templates.ts`（内置模板「目标达成」：kpi 达成率×2 + table 按店 colorSemantics target=1 + line 周期节奏 + ai_text）
- Test: `report-templates.test.ts`（schema 校验过 + 槽位计数）
- 监控：`docs/` 或 config 示例挂 threshold `<0.8`（配置示例，不改代码）

- [ ] Step 1–4：失败测试 → 模板 → 验证（`pnpm vitest run modules/data/domain/report-templates.test.ts`）→ 提交。

### Task C3: 企微达成日报（scheduler job + 事件/模板）

**Files:**
- Modify: `apps/server/src/scheduler/registry.ts`（`goal.daily_push` 每日 08:30 Asia/Shanghai）
- Modify: `modules/forms/manifest.yaml` + `modules/notify/templates/builtin.ts` + `seed-builtin.ts`（事件 `forms.goal.daily` + 模板 `oa_goal_daily`，三处同描）
- Test: registry 断言 + notify 模板测试

- [ ] Step 1–4：job emit 事件（payload: goal/period/achievement_rate/top_laggers link）；fail-open 照 notify 先例 → 测试 → 提交。

### Task C4: 山海部署 + 验收

- [ ] merge 后**手动触发** `platform-core-shanhai-data` 部署（autoDeploy=false）；容器内验产物（`deploy-verify` 纪律：grep 产物，不看 CI 绿灯）。
- [ ] 真实流程：建轮 → 录格子 → 摊平/达成模型出数 → 报表看板 → 阈值告警 → 企微日报。
- [ ] 负对照：round 非 open 提交 409；target=0 行达成率 NULL；受限用户（部门门）不可见店不计入分母；重复提交幂等。
- [ ] 验收记录 `docs/superpowers/plans/2026-11-23-goal-platform-acceptance.md`（北京时间）+ PR。

---

## Self-Review

**Spec coverage**：D1→Phase A（A1 opt-in 闸/A2 生成器/--check/A3 首指标）；D3→Phase B（三表/事件/模板/console）；D2+D5+D6+D7→Phase C（两段式/店级+行级门=分母收缩/封版=天然固化/actuals 引词表）；§3 首刀范围=C4；§6 开放项按推荐案落地（v1 无审批门/复用 forms:fill/NULL/既有 monitor）。D4 外部权威=字典快照在 C4 环境步骤（开轮时同步锚），v2 非目标。✅

**Placeholder scan**：L1 指标名/actuals 关系名标注「以 l1_metrics.yml 实际名为准，先 grep 确认」= 带判据的自适应步骤，非 TBD；其余均有具体内容。✅

**Type consistency**：`DataPlaneForm.fields[].kind` ↔ 生成器 `SQL_TYPE/EXTRACT` 键一致；`slug`→`relationSlug`（- 转 _）在 A2/A3/L1 三处引用同名；round 三表列名在 B1/B2/C1 一致。✅
