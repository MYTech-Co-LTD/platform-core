# 件④ 表单运营实时统计 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让表单的**单一源、当前态**统计（今日收了多少、分数合计、按班次/班级分组）走**平台 PG 实时聚合**，与「湖 → 摊平 → mart/L1」的分析通道明确分家；不把运营查询塞进报表引擎。

**Architecture:** `dataPlane` 契约从「字段白名单 + 一个 enabled」升级为「一份 `fields` + 两个能力位 `stats`/`analytics`」。`stats` 由发布者开启，`analytics` 需 `forms:data-plane` 平台审批。新增 `POST /stats` 声明式聚合端点（白名单字段/聚合、org 钉身份、短 TTL 缓存、返回 `asOf`）。报表引擎**不接**运营数据源。

**Tech Stack:** platform-core（Hono/pg/zod/vitest/React+antd）。

## Global Constraints

- 仅 platform-core；不碰数据面/dbt/湖。
- `stats` 查询**只**允许契约声明的字段与聚合；**不开放任意 SQL/JSON 表达式**；org 只来自 `identity.orgId`。
- `analytics` 发布门：新增 `forms:data-plane`（platformOnly）；部门管理员只能提申请，平台数据负责人批准后才可 `analytics.enabled=true`。
- 兼容：存量 `dataPlane.enabled=true`（如 `goal-monthly-store`）按 `analytics.enabled=true` 读取，**不迁移数据**；`--check` 生成物必须不变。
- 缓存 TTL 5–30s（默认 15s）+ 提交后失效；返回 `asOf`。
- 报表 spec/引擎不改；实时统计是 forms 模块自己的端点与页面。
- 迁移幂等（本计划无 DDL，除非新增权限码由 manifest 供给）。

## Repo / 波次

- Wave H1：**D1 契约 v2 + 发布门 + 生成器兼容** 与 **D2 stats 编译/端点/缓存**（同一 worker 串行，因共享 `contract.ts`/`routes.ts`）。
- Wave H2：**D3 console 实时统计页**（依赖 D2 API）。
- Wave H3：**D4 真机验收**（含负对照）。

---

## Task D1: 契约 v2（fields / stats / analytics）+ 发布门 + 生成器兼容

**Files:**
- Modify: `modules/forms/domain/contract.ts`
- Modify: `modules/forms/domain/contract.test.ts`
- Modify: `modules/forms/storage.ts`（`listDataPlaneForms` 读 v2；兼容 legacy）
- Modify: `modules/forms/routes.ts`（publish 校验 `forms:data-plane`）
- Modify: `modules/forms/manifest.yaml`（新增 `forms:data-plane` platformOnly）
- Modify: `scripts/gen-forms-data-projection.mjs`（读 v2 fields/analytics）
- Test: `scripts/gen-forms-data-projection.test.mjs`

**Interfaces:**
- `DataPlaneV2 = { fields?: FieldDecl[]; stats?: { enabled: boolean }; analytics?: { enabled: boolean } }`
- `FieldDecl = { field: string; kind: 'string'|'number'|'integer'|'boolean'|'date'|'enum'; agg?: Agg[]; groupable?: boolean }`
- `analyticsEnabledOf(body): boolean`：`body.dataPlane.analytics.enabled === true || (legacy body.dataPlane.enabled === true)`
- `statsEnabledOf(body): boolean`：`body.dataPlane.stats.enabled === true`
- `compileGate` 增：fields 与 schema 一致、agg/groupable 合法；`stats.enabled` 需要至少一个可聚合字段；`analytics.enabled` 只做结构校验（权限在 publish 路由）。
- `listDataPlaneForms` 改为按 `analyticsEnabledOf` 过滤；fields 优先取 `dataPlane.fields`，缺省从 schema 派生（Phase A 行为）。

- [ ] **Step 1: 写失败测试**

```ts
it('v2 fields 必须与 schema 字段一致（多/少都拒）', () => {
  const body = { schema: { type:'object', properties:{ score:{type:'number'} } },
    dataPlane: { fields:[{field:'score',kind:'number',agg:['sum']},{field:'ghost',kind:'string'}] } }
  expect(compileGate(body as never)).toMatchObject({ ok:false, code:'DATA_PLANE_FIELD_UNKNOWN' })
})
it('stats.enabled 无任何可聚合字段 ⇒ 拒', () => {
  const body = { schema:{type:'object',properties:{name:{type:'string'}}},
    dataPlane:{ stats:{enabled:true}, fields:[{field:'name',kind:'string'}] } }
  expect(compileGate(body as never)).toMatchObject({ ok:false, code:'STATS_NO_MEASURE' })
})
it('legacy dataPlane.enabled 视为 analytics.enabled（兼容）', () => {
  expect(analyticsEnabledOf({ dataPlane:{ enabled:true } })).toBe(true)
  expect(analyticsEnabledOf({ dataPlane:{ analytics:{enabled:true} } })).toBe(true)
  expect(analyticsEnabledOf({ dataPlane:{ stats:{enabled:true} } })).toBe(false)
})
it('agg 白名单：sum/avg 只允许数值字段', () => {
  const body = { schema:{type:'object',properties:{name:{type:'string'}}},
    dataPlane:{ fields:[{field:'name',kind:'string',agg:['sum']}] } }
  expect(compileGate(body as never)).toMatchObject({ ok:false, code:'STATS_AGG_TYPE_MISMATCH' })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run modules/forms/domain/contract.test.ts`
Expected: FAIL（无 v2 分支）。

- [ ] **Step 3: 实现契约 v2**

contract.ts：
```ts
export type Agg = 'sum' | 'avg' | 'count' | 'min' | 'max'
export interface FieldDecl { field: string; kind: 'string'|'number'|'integer'|'boolean'|'date'|'enum'; agg?: Agg[]; groupable?: boolean }
export function analyticsEnabledOf(body: unknown): boolean {
  const dp = (body as any)?.dataPlane
  return dp?.analytics?.enabled === true || dp?.enabled === true
}
export function statsEnabledOf(body: unknown): boolean {
  return (body as any)?.dataPlane?.stats?.enabled === true
}
```
在 compileGate 的 dataPlane 分支：
- 若 `fields` 存在：逐条校验 `field` ∈ schema.properties、`kind` 与 schema 类型一致（`string+format:date` ⇒ date；`enum` ⇒ enum）；`agg` ∈ 白名单且 `sum/avg/min/max` 只许 number/integer/date；`groupable` 只许 string/enum/date/boolean。
- 若 `stats.enabled`：至少一个字段有非空 `agg`；否则 `STATS_NO_MEASURE`。
- 若 `analytics.enabled`：结构校验同 Phase A（字段名/类型/非嵌套），但**不检查权限**。
- 未声明 `fields` 时保持 Phase A 行为（从 schema 派生），`stats.enabled` 需显式 `fields` 才能声明聚合（避免猜）。

- [ ] **Step 4: publish 门（routes.ts）**

`POST /defs/:assetId/versions/:v/publish`：
```ts
const body = await store.bodyAt(pool, org, assetId, version)
if (analyticsEnabledOf(body) && !identity.hasScope('forms:data-plane')) {
  return fail(c, 403, 'DATA_PLANE_APPROVAL_REQUIRED', 'analytics 需平台数据负责人批准（forms:data-plane）')
}
```
`stats.enabled` 不额外要求（发布者 `forms:publish` 即可）。

- [ ] **Step 5: storage/generator 兼容**

`listDataPlaneForms` 过滤改为：
```sql
where v.kind='form_def' and v.status='published'
  and (v.body->'dataPlane'->'analytics'->>'enabled' = 'true'
       or v.body->'dataPlane'->>'enabled' = 'true')
```
fields 取 `body.dataPlane.fields`（v2）或从 schema 派生（legacy）。生成器无需改模板，只改输入；`--check` 必须与 committed 逐字节一致（存量 goal 表单产物不变）。

- [ ] **Step 6: manifest 权限码**

```yaml
  - { code: forms:data-plane, name: 表单分析面暴露审批, platformOnly: true }
```

- [ ] **Step 7: 跑测试与门禁**

Run: `pnpm vitest run modules/forms/domain/contract.test.ts scripts/gen-forms-data-projection.test.mjs modules/forms/routes.test.ts`
Run: `node scripts/gen-forms-data-projection.mjs --check`
Run: `pnpm smoke`
Expected: PASS；`--check` 无 diff。

- [ ] **Step 8: 提交**

```bash
git add modules/forms/domain/contract.ts modules/forms/domain/contract.test.ts modules/forms/storage.ts modules/forms/routes.ts modules/forms/manifest.yaml scripts/gen-forms-data-projection.mjs scripts/gen-forms-data-projection.test.mjs
git commit -m "feat(forms): dataPlane v2——fields/stats/analytics 与平台审批门（#GOAL）"
```

---

## Task D2: `POST /stats` 编译 + 端点 + 缓存

**Files:**
- Create: `modules/forms/domain/stats.ts`
- Create: `modules/forms/domain/stats.test.ts`
- Modify: `modules/forms/routes.ts`
- Modify: `modules/forms/manifest.yaml`
- Modify: `modules/forms/storage.ts`（提交后失效缓存）
- Test: `modules/forms/routes.test.ts`

**Interfaces:**
- `compileStats(input, decl): { sql: string; params: unknown[] }`（纯函数）
- `POST /api/modules/forms/stats` body：
```json
{ "assetId": "score-form", "groupBy": ["class"],
  "measures": [{ "field": "score", "agg": "sum" }],
  "filter": { "submittedFrom": "2026-11-01", "submittedTo": "2026-11-23",
              "where": [{ "field": "class", "op": "eq", "value": "A" }] },
  "limit": 100 }
```
- 响应：`{ rows, asOf, truncated }`

**限制（写死）**：groupBy ≤3；measures ≤5；where ≤10；limit ≤1000；分组基数 ≤500（超出 `truncated:true`）；`agg` 必须 ∈ 该字段 `agg`；`where` 字段必须声明且 `op ∈ eq|neq|gt|gte|lt|lte|in`；`in` 值 ≤50；不接受任意 JSON path。

- [ ] **Step 1: 失败测试（纯函数）**

```ts
it('sum + groupBy 编译成参数化 SQL', () => {
  const { sql, params } = compileStats({ assetId:'f', groupBy:['class'],
    measures:[{field:'score',agg:'sum'}], limit:10 },
    { fields:[{field:'class',kind:'string',groupable:true},{field:'score',kind:'number',agg:['sum']}] })
  expect(sql).toContain("payload->>'class'")
  expect(sql).toContain("sum((payload->>'score')::numeric)")
  expect(sql).toContain('group by 1')
  expect(params).toContain('f')
})
it('未声明字段 ⇒ STATS_FIELD_NOT_ALLOWED', () => {
  expect(() => compileStats({ assetId:'f', groupBy:['ghost'], measures:[{field:'score',agg:'sum'}], limit:10 },
    { fields:[{field:'score',kind:'number',agg:['sum']}] })).toThrow(/STATS_FIELD_NOT_ALLOWED/)
})
it('sum 用在 string 字段 ⇒ STATS_AGG_TYPE_MISMATCH', () => {})
it('limit 超上限 ⇒ 400 STATS_LIMIT_TOO_LARGE', () => {})
it('in 列表 >50 ⇒ STATS_IN_TOO_LARGE', () => {})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run modules/forms/domain/stats.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 compileStats**

- 字段引用一律 `payload->>'<field>'`（参数化只用于值，不拼字段名；字段名先按声明白名单校验）。
- `sum/avg/min/max` 包 `::numeric`（date 用 `::date`）；`count` 用 `count(*)`（`field:'*'`）。
- 时间过滤：`submitted_at >= $n::timestamptz` / `< $n::timestamptz + interval '1 day'`；`submittedFrom/To` 按 `Asia/Shanghai` 日界换算（用 `AT TIME ZONE`）。
- `where` 值参数化；`in` 用 `= any($n::text[])`。
- 固定 `where org=$1 and kind='form_def' and asset_id=$2`；只查 published head（`forms.submission` 本身只落 head 版本）。
- `limit` 参数化；`group by 1..n order by 1..n`。

- [ ] **Step 4: 端点 + 缓存**

`routes.ts`：
```ts
r.post('/stats', (c) => handle(c, async () => {
  const { identity } = ctx(c)
  const body = await c.req.json()
  const assetId = String(body?.assetId ?? '')
  const version = await store.headVersion(pool, identity.orgId, assetId)
  if (version === null) return fail(c, 404, 'NO_PUBLISHED_HEAD')
  const def = await store.bodyAt(pool, identity.orgId, assetId, version)
  if (!statsEnabledOf(def)) return fail(c, 403, 'STATS_NOT_ENABLED')
  const decl = fieldDeclsOf(def)
  const { sql, params } = compileStats(body, { fields: decl })
  const key = cacheKey(identity.orgId, assetId, body)
  const hit = statsCache.get(key); if (hit && Date.now() - hit.at < 15_000) return c.json({ ...hit.value, cached: true })
  const { rows } = await pool.query(sql, params)
  const value = { rows, asOf: new Date().toISOString(), truncated: rows.length >= limit }
  statsCache.set(key, { at: Date.now(), value })
  return c.json(value)
}))
```
- 缓存上限 500 项，LRU 淘汰；`submit` 成功后 `statsCache.delete` 同 org+asset 全部键（简单遍历）。
- scope：`forms:view`（与读面一致）；数据授权由 org 钉死。

- [ ] **Step 5: manifest 声明**

```yaml
    - { method: POST, path: /stats, scope: forms:view }
```

- [ ] **Step 6: 跑测试**

Run: `pnpm vitest run modules/forms/domain/stats.test.ts modules/forms/routes.test.ts modules/forms/module.test.ts`
Expected: PASS（含负对照：未声明字段、string sum、limit 超限、in 超长、未开启 stats）。

- [ ] **Step 7: 提交**

```bash
git add modules/forms/domain/stats.ts modules/forms/domain/stats.test.ts modules/forms/routes.ts modules/forms/manifest.yaml modules/forms/storage.ts modules/forms/routes.test.ts
git commit -m "feat(forms): 运营实时统计端点（白名单/缓存/asOf）（#GOAL）"
```

---

## Task D3: console 实时统计页

**Files:**
- Create: `modules/forms/console/RealtimeStats.tsx`
- Modify: `modules/forms/console/index.tsx`（页签）
- Modify: `modules/forms/console/api.ts`
- Test: `modules/forms/console/console.test.tsx`

**Interfaces:**
- 页面：选表单（仅 `stats.enabled` 的表单）→ 选维度（groupable）/度量（agg）→ 日期范围 → 表格 + 合计行；顶部显示 `实时（截至 HH:mm:ss）`。
- 不提供任意字段输入；选项全部来自表单契约（可加一个只读接口 `GET /defs/:id` 返回 body，前端解析 `dataPlane.fields`）。

- [ ] Step 1：失败测试（列表加载、选字段、渲染行、asOf 文案、空态两种）。
- [ ] Step 2：实现页面（antd Table；移动端卡片可选；`platformFetch`）。
- [ ] Step 3：跑测试 + build：`pnpm vitest run modules/forms/console/console.test.tsx; pnpm build`。
- [ ] Step 4：提交 `feat(forms): 实时统计页（#GOAL)`。

---

## Task D4: 真机验收（含负对照）

- [ ] 建一个含 `class(string,groupable)`、`score(number,agg sum/avg)`、`submitted_date` 的表单，`dataPlane.stats.enabled=true`，发布。
- [ ] 提交 3 条（A 班 80/90、B 班 70），调 `POST /stats`：`groupBy:['class']`、`sum(score)` → A=170、B=70；`asOf` 在响应里；15s 内重复调用命中缓存。
- [ ] 负对照：
  - 未声明字段 / `sum(string)` / `limit:10000` / `in` 51 项 ⇒ 400 机检码；
  - 未开 `stats` 的表单 ⇒ 403 `STATS_NOT_ENABLED`；
  - 跨租户（另一 org 的 PAT）看不到本 org 数据；
  - `analytics.enabled` 由部门管理员发布 ⇒ 403 `DATA_PLANE_APPROVAL_REQUIRED`；平台管理员发布 ⇒ 200。
- [ ] 验收记录写 `docs/superpowers/plans/2026-11-23-realtime-stats-acceptance.md`（北京时间）。

---

## Self-Review

**Spec coverage**：D9 双通道 → 本计划只做运营通道（分析通道已由 A/B/C 落地）；D10 契约拆 fields/stats/analytics + `forms:data-plane` → D1；D11 `POST /stats` 白名单/缓存/asOf → D2；console → D3；负对照 → D4。报表引擎不改（D9 硬约束）。✅

**Placeholder scan**：无 TBD；SQL/接口/错误码均具体。✅

**Type consistency**：`FieldDecl/Agg` 在 D1 定义，D2/D3 引用同名；`analyticsEnabledOf/statsEnabledOf` 在 D1 定义，storage/routes 引用；`compileStats` 在 D2 定义，D3 只消费 HTTP。✅
