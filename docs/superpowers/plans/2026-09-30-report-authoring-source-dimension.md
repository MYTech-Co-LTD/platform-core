# 语义的源维度 实施计划（报表制作域 5/6）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落 spec §3⑧「语义必须带**源维度**」的两道（**裁剪 + 写入闸**）与它们的共同前提（**「某租户接了哪些源」这条今天无处可取的事实**）——外加 spec 待办 7 的**命名一次改到位**（`<源>:<业务域>:<指标>`）。

**Architecture:**
- **「源」的身份**：源系统（如 `lemeng`）**新增为 L1 声明的必填字段** `source`（单值：L1 本就是逐源口径）。
  ⚠️ **不许与既有 `l1_metrics.yml` 的 `sources` 混用**——那个字段是「指标背后实际读的**对象存储路径**」（人读、选填、无门禁），语义完全不同。
  落库列名用 **`source_system`**，因为 `data.metrics.source` **已被占用**（取值 `l1`/`l2` =「谁写的、谁能改」）。
- **「谁接了哪个源」**：新表 **`platform.tenant_source`**（与 `platform.tenant_module` 同构：`tenant_id` + 标识 + `enabled` + `config`）。
  落 `platform` 是因为**架构 lint B1**（`apps/`+`packages/` 只许 `platform`、`modules/<id>/` 只许自己的 schema，`scripts/lint-architecture.mjs:271-275`）——
  登记若落 `data.*`，平台管理面/开通/对账全部读不到。**代价**：模块读不到 `platform` ⇒ 由**宿主按请求投影**给它（现成先例 `TENANT_STORAGE`）。
- **两道判据**：**裁剪**收口在唯一裁剪函数 `visibleMetrics`（四消费方都经它，`catalog-consumers.test.ts` 是机器判据）；**写入闸**插在 `writeL2` 的 `resolveL1Base` 成功之后（那时才第一次拿到 base 行）。
- **改名**：`<域>:<指标>` → **`<源>:<业务域>:<指标>`**（`lemeng:retail:net_sales`）——`(org,id)` 主键下，第二源才能用同一个业务概念名声明而不撞 `duplicate key`。

**Tech Stack:** node-postgres（两侧迁移）+ Hono（宿主中间件 + 模块路由）+ dbt 声明 yml + zod；React/antd 只读展示。**零新依赖**。

## Global Constraints

1. **术语不许混**（本计划最容易错的一条）：
   - `l1_metrics.yml` 的 **`sources`**（既有）= **对象存储路径列表**，人读、选填、**无门禁** ⇒ 本计划**原样不动**。
   - 新增的 **`source`**（yml 字段）= **源系统单值**（`^[a-z][a-z0-9_]*$`，如 `lemeng`）⇒ 必填、有门禁。
   - DB 列名 **`source_system`**（`data.metrics.source` 已被 `l1`/`l2` 占用，**别改既有列**）。
2. **B1 是本计划的形状来源**：`platform.tenant_source` 只能被 `apps/`+`packages/` 读；`modules/data/**` **不得**出现 `platform.` 引用（会红）。模块要的数据一律走**宿主投影**（`c.set` → `c.get`）。
3. **投影的挂载序是硬约束**（`apps/server/src/loader.ts:483-499` 的既有注释）：投影中间件必须在**启用闸门之后**、`app.route(base, m.router)` **之前**——否则中间件永不执行，模块 `c.get(...)` 恒 `undefined`。
4. **两侧迁移都幂等**：`apps/server/src/migrations/007_*.sql`（平台侧，记账表 `platform.schema_migrations`）与 `modules/data/migrations/006_*.sql`（模块侧）都写成可重复执行（`if not exists` / `exception when duplicate_object then null`）。**写前先 `ls` 两侧目录确认号段**。
5. ⚠️ **动 `dbt/**` 就必须同提交重生成 lock**（订正记录 2026-09-30，Task 3 实施中发现）：`deploy/data-plane-manifest.txt` 把 `dbt/` 作为**目录条目**覆盖，
   而 `scripts/check-data-plane-lock.mjs` 逐文件比 **sha256** ⇒ 改 `l1_metrics.yml` 后不重生成 lock，`gates` 必红。
   命令：`pnpm exec tsx scripts/lemeng/data-plane-lock.mjs`（**Task 3 与 Task 4 各自都要做一次**；原稿只排在 Task 4，是分工错误）。
6. **改名必须一次改全**（漏一处 = 门禁红或运行期 404）：`dbt/semantics/l1_metrics.yml` 声明、`check-data-models.mjs` 的 `METRIC_NAME_RE`（`:157`）、`sync-data-semantics.mjs` 的兜底正则（`:75-76`）、`metricToAuditFileName` 派生的**文件名**（`dbt/tests/audit_<源>__<业务域>__<指标>.sql`，映射唯一事实源在 `check-data-models.mjs:221-233`）、`deploy/data-plane.lock`（**重生成命令**：`pnpm exec tsx scripts/lemeng/data-plane-lock.mjs`，见 `data-plane-manifest.txt:16-18`）、四个测试文件的夹具、以及 `dbt/README.md` 与 `modules/data/README.md` 的示例串。
6. **裁剪必须收口一处**：只改 `modules/data/domain/authz.ts` 的 `visibleMetrics`，**四消费方**（`GET /metrics` / MCP `tools/list` / `list_agent` 的 `list_metrics` / `query_metric` 解析路径）都经它；并**扩展** `modules/data/catalog-consumers.test.ts` 钉住新签名（防将来新消费方绕开）。
7. **零新依赖**；只动 `apps/server/**`、`packages/platform-sdk/**`、`modules/data/**`、`dbt/**`、`scripts/**`、`deploy/**`；**不碰** `apps/mb-proxy/**`。
8. **提交**：Conventional Commits，**单 scope**（`feat(data):` / `feat(platform):` / `chore(dbt):`），每任务一提交；不删改 provenance trailer。
9. **测试口径**：`DATABASE_URL` 由 shell 提供（正典见 README）；模块测试 `DATABASE_URL=… pnpm --filter data test`；宿主 `pnpm --filter @platform/server test`；跨包 `pnpm typecheck`。
10. **不在本计划范围**：agent 的**自绘规格面**与**提议/确认流**（§3⑥、§4.3–4.5）→ **计划 6**；契约 `domain` 与指标 `source` 的**自动映射**（本计划只要求两者**同名约定**，不做推导——`contracts/customers/` 仍空，可枚举的源清单尚不存在）。

---

### Task 1: 平台侧登记表 `platform.tenant_source` + 开通写入 + 管理端点

**Files:**
- Create: `apps/server/src/migrations/007_tenant_source.sql`（**先 `ls apps/server/src/migrations/` 确认号段**）
- Modify: `apps/server/src/routes/admin.ts`（新增 `GET`/`PUT /sources`，照 `GET`/`PUT /storage` 的形态）
- Modify: `scripts/provision-tenant.mjs`（`--source <源>` 可多次 + 步骤串）
- Test: `apps/server/src/routes/admin.test.ts`（追加）

**Interfaces:**
- Consumes: 既有 `requireScope('tenant:admin')` + CSRF 中间件（`admin.ts:52-65`）、`writeAudit`（`admin.ts:38-50`）。
- Produces:
  - 表 `platform.tenant_source(tenant_id int references platform.tenant(id), source text, enabled boolean not null default true, config jsonb not null default '{}', primary key(tenant_id, source))`。
  - `GET /api/platform/admin/sources` → `{ sources: [{ source, enabled }] }`（本租户）。
  - `PUT /api/platform/admin/sources` body `{ sources: string[] }`（**整体替换启用集**：列表里的置 `enabled=true`，不在列表里的置 `false`；`.strict()`）→ `{ ok: true }`；审计 action `admin.sources.update`。
  - `provision-tenant.mjs --source <源>`（可重复）⇒ `tenantProvisionSteps` 里出现 `source:<源>` 步骤并写表（`on conflict (tenant_id, source) do update set enabled = true`）。

- [ ] **Step 1: 写迁移**

```sql
-- 007_tenant_source.sql — 「某租户接了哪些源」（spec §3⑧ 的前提，计划 5）。
-- 与 platform.tenant_module 同构（tenant_id + 标识 + enabled + config）：接入是平台侧动作，
-- 登记必须落在 platform schema —— 架构 lint B1 不许 modules/** 读 platform、也不许 apps/** 读 data。
-- 幂等：部署每次全量重跑迁移（migrate.ts 按 platform.schema_migrations 记账去重），文件本身仍写成可重复。
create table if not exists platform.tenant_source(
  tenant_id int not null references platform.tenant(id),
  source text not null,
  enabled boolean not null default true,
  config jsonb not null default '{}',
  primary key(tenant_id, source)
);
```

- [ ] **Step 2: 写失败测试**（`admin.test.ts`：照既有 `/storage` 那组用例的壳）

```ts
  it('★ 已接入源：PUT 整体替换 + GET 回读；非 tenant:admin 403', async () => {
    // 用既有 harness（见同文件 storage 用例：登录拿 cookie → 带 x-csrf-token）
    const put = await app.request('/api/platform/admin/sources', {
      method: 'PUT', headers: { ...adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ sources: ['lemeng'] }),
    })
    expect(put.status).toBe(200)
    const got = await (await app.request('/api/platform/admin/sources', { headers: adminHeaders })).json()
    expect(got.sources).toEqual([{ source: 'lemeng', enabled: true }])

    // 整体替换语义：换成另一个源 ⇒ 前一个 enabled=false（不删行，保留痕迹）
    await app.request('/api/platform/admin/sources', {
      method: 'PUT', headers: { ...adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ sources: [] }),
    })
    expect((await (await app.request('/api/platform/admin/sources', { headers: adminHeaders })).json()).sources)
      .toEqual([{ source: 'lemeng', enabled: false }])

    // 多余键 ⇒ 400（.strict()）
    expect((await app.request('/api/platform/admin/sources', {
      method: 'PUT', headers: { ...adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ sources: [], extra: 1 }),
    })).status).toBe(400)
  })
```

- [ ] **Step 3: 跑测试确认红** → `DATABASE_URL=… pnpm --filter @platform/server exec vitest run src/routes/admin.test.ts`

- [ ] **Step 4: 实现**（`admin.ts`：两个端点；**写操作沿用既有 CSRF + 审计**；`provision-tenant.mjs`：`--source` 解析进 `opts.sources`，`tenantProvisionSteps` 加步骤，写表）

```ts
  const SourcesBody = z.object({ sources: z.array(z.string().min(1).max(64)).max(50) }).strict()

  app.get('/sources', async (c) => {
    const t = c.get('tenant')
    const { rows } = await deps.pool.query(
      'select source, enabled from platform.tenant_source where tenant_id = $1 order by source', [t.id])
    return c.json({ sources: rows })
  })

  app.put('/sources', async (c) => {
    const t = c.get('tenant')
    const parsed = SourcesBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    // 整体替换**不删行**（保留 enabled=false 的痕迹，便于对账与审计）
    await deps.pool.query(
      `insert into platform.tenant_source (tenant_id, source, enabled)
       select $1, s, (s = any($2::text[])) from unnest($2::text[]) as s
       on conflict (tenant_id, source) do update set enabled = excluded.enabled`,
      [t.id, parsed.data.sources])
    await deps.pool.query(
      `update platform.tenant_source set enabled = false where tenant_id = $1 and not (source = any($2::text[]))`,
      [t.id, parsed.data.sources])
    await writeAudit(deps.pool, t.id, actorOf(c), 'admin.sources.update', { sources: parsed.data.sources })
    return c.json({ ok: true })
  })
```

- [ ] **Step 5: 跑测试确认绿 + 宿主全量** → `pnpm --filter @platform/server test`

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/migrations/007_tenant_source.sql apps/server/src/routes/admin.ts apps/server/src/routes/admin.test.ts scripts/provision-tenant.mjs
git commit -m "feat(platform): 租户已接入源登记表 + 管理端点 + 开通流程写入"
```

---

### Task 2: 宿主按请求投影给模块（照 `TENANT_STORAGE` 先例）

**Files:**
- Modify: `packages/platform-sdk/src/module.ts`（新键常量 + 类型 + `ModuleManifest` 加 **`tenantSources?: boolean`**——⚠️ **别叫 `sources`**：那会与 dbt 声明里「存储路径」的 `sources` 撞名，正是 Constraint 1 要防的）
- Modify: `apps/server/src/loader.ts`（`MountEnv.Variables` 加键 + 投影中间件）
- Modify: `modules/data/manifest.yaml`（**`tenantSources: true`**）+ `modules/data/routes/context.ts`（本地 Vars 加键）
- Test: `apps/server/src/loader.test.ts`（追加）+ `modules/data/routes/metrics.test.ts`（追加一条冒烟）

**Interfaces:**
- Consumes: Task 1 的表；既有投影先例（`TENANT_STORAGE` 键常量 `module.ts:41-45`、宿主写入 `loader.ts:61-63,491-499`、模块读取内联声明）。
- Produces:
  - `export const TENANT_SOURCES = 'platform.tenantSources'`（SDK 导出；带「宿主 set / 模块 get 的约定，编译器不连线」同款注释）。
  - 宿主投影：`m.manifest.tenantSources === true` 的模块，其路由基路径上挂中间件——**查 `platform.tenant_source` 取 `enabled=true` 的集合**，`c.set(TENANT_SOURCES, string[])`。
  - 模块侧：`modules/data` 的本地 `ModuleVars.Variables` 加 `[TENANT_SOURCES]?: string[]`。

- [ ] **Step 1: 写失败测试**（`loader.test.ts`：断言「声明 `tenantSources: true` 的模块，其请求里 `c.get(TENANT_SOURCES)` 是数组；未声明的不设」；`metrics.test.ts`：断言模块能读到）

- [ ] **Step 2: 跑测试确认红**

- [ ] **Step 3: 实现**

```ts
// module.ts（SDK）
/**
 * 「本租户已接入的源」的 Hono context 变量键（计划 5）。
 * 同 TENANT_STORAGE：**宿主 set / 模块 get 的约定**，编译器不连线 ⇒ 改名是破坏性变更。
 * 值与 `platform.tenant_source` 里 `enabled = true` 的集合一致（宿主按**本次请求所属租户**投影）。
 */
export const TENANT_SOURCES = 'platform.tenantSources'
```

```ts
// loader.ts：MountEnv.Variables 加 [TENANT_SOURCES]?: string[]；在 storage 投影同一位置挂
        if (m.manifest.tenantSources) {
          const projectSources: MiddlewareHandler<MountEnv> = async (c, next) => {
            const t = c.get('tenant') as TenantRow | undefined
            if (t) {
              const { rows } = await deps.pool.query(
                'select source from platform.tenant_source where tenant_id = $1 and enabled = true',
                [t.id])
              c.set(TENANT_SOURCES, rows.map((r) => r.source as string))
            }
            await next()
          }
          app.use(base + '/*', projectSources)   // ⚠️ 必须在启用闸门之后、app.route 之前
        }
```

> ⚠️ **与 `TENANT_STORAGE` 的一个刻意的不同**：storage 的投影是**零 IO**（读的是租户行上已有的列）；本投影**每请求一查**（源是集合，落在表里）。
> 量级小（本机同库、`primary key(tenant_id, source)` 命中索引）⇒ **先不做缓存**（「无案例不立标准」）；要压测有了数再加 TTL 缓存，**别提前加**。

- [ ] **Step 4: 跑测试确认绿 + 回归** → `pnpm --filter @platform/server test`、`pnpm --filter data test`、`pnpm typecheck`、`pnpm exec tsx scripts/check-manifests.mjs`

- [ ] **Step 5: Commit**

```bash
git add packages/platform-sdk/src/module.ts apps/server/src/loader.ts apps/server/src/loader.test.ts modules/data/manifest.yaml modules/data/routes/context.ts
git commit -m "feat(platform): 宿主把「已接入源」按请求投影给模块（照 TENANT_STORAGE 先例）"
```

---

### Task 3: 源字段进声明面（`source` 必填）+ 落库

**Files:**
- Modify: `dbt/semantics/l1_metrics.yml`（每条加 **`source: lemeng`**；`sources` 存储路径**原样不动**）
- Modify: `modules/data/migrations/006_metrics_source_system.sql`（**先 `ls modules/data/migrations/` 确认号段**）
- Modify: `scripts/sync-data-semantics.mjs`（不再丢弃 → 落 `source_system`；`ComparableMetric` 与 `comparableOf` 加该字段，使漂移可比）
- Modify: `scripts/check-data-models.mjs`（`REQUIRED_METRIC_FIELDS` 加 `source`；新增形状规则 `^[a-z][a-z0-9_]*$`；文件头注与 `:756` 的说明串同步）
- Modify: `modules/data/domain/metric-store.ts`（`MetricRow` 加 `sourceSystem: string | null`）+ `upsertL1Metric` 写入
- Modify: `deploy/data-plane.lock`（⚠️ **重生成**，不是手改：`pnpm exec tsx scripts/lemeng/data-plane-lock.mjs`）
- Modify: `dbt/README.md`（两处「必填 N 项」清单会因新增必填字段而过期）
- Modify（类型收严强制，夹具补字段）：`modules/data/catalog-consumers.test.ts`、`modules/data/routes/metrics.test.ts`、`modules/data/domain/semantic-compiler.test.ts`、`modules/data/domain/metric-store.test.ts`
- Test: `scripts/sync-data-semantics.test.ts`、`scripts/check-data-models.test.ts`、`modules/data/domain/metric-store.test.ts`

**Interfaces:**
- Produces: `data.metrics.source_system text`（**可空**：L2 行没有源）；L1 行的取值恒等于声明的 `source`。

- [ ] **Step 1: 写迁移 + 失败测试**

```sql
-- 006_metrics_source_system.sql — L1 口径的**源系统**（spec §3⑧ 的源维度；计划 5）。
-- ⚠️ 与既有 `data.metrics.source`（取值 l1/l2 = 谁写的）**不是一回事**，故列名用 source_system。
-- 幂等：可重复执行。
alter table data.metrics add column if not exists source_system text;
```

```ts
  it('★ L1 行的 source_system 等于声明的 source；L2 行为 null', async () => {
    // 走 sync 的纯核（declarationsFromYaml）断言映射，再落库断言列值
  })
```

- [ ] **Step 2: 跑测试确认红** → `pnpm exec tsx --test`（scripts 侧用 vitest：`pnpm exec vitest run --dir scripts`）+ `DATABASE_URL=… pnpm --filter data test`

- [ ] **Step 3: 实现**（`declarationsFromYaml` 返回体加 `sourceSystem: String(m.source)`；`upsertL1Metric` 写该列；`upsertMetric`（L2 路）显式写 `null`；`check-data-models` 加必填与形状）

- [ ] **Step 4: 跑测试确认绿 + `pnpm exec tsx scripts/sync-data-semantics.mjs --check`（应报「无漂移」）**

> ⚠️ **顺序告诫（2026-09-30，Task 3 实施中发现）**：「无漂移」**只在 sync 写库之后读**才有意义——既有测试卫生问题：
> `modules/data/routes/metrics.test.ts` 的 L1 夹具 id 与真实声明同名、其 `afterAll` 会删掉**平台桶里的真行**；
> `metric-store` 测试的 `source_probe`/`entry_l1` 又不带前缀、不被清理 ⇒ 本机跑完 data 测试后 `--check` 会报「新增 1 / 删除 2」。
> 顺序：`sync`（写库）→ `--check`（读）→ 再跑 data 测试。

- [ ] **Step 5: Commit**

```bash
git add dbt/semantics/l1_metrics.yml modules/data/migrations/006_metrics_source_system.sql scripts/sync-data-semantics.mjs scripts/check-data-models.mjs modules/data/domain/metric-store.ts
git commit -m "feat(data): L1 声明加必填 source + 落库 source_system（源维度的事实源）"
```

---

### Task 4: 改名 `<源>:<业务域>:<指标>`（一次改全）

**Files:**
- Modify: `dbt/semantics/l1_metrics.yml`（`retail:net_sales` → `lemeng:retail:net_sales`；两条都改）
- Rename: `dbt/tests/audit_retail__net_sales.sql` → `dbt/tests/audit_lemeng__retail__net_sales.sql`
- Modify: `scripts/check-data-models.mjs`（`METRIC_NAME_RE` 三段 + 头注与 `:756` 说明串）
- Modify: `scripts/sync-data-semantics.mjs`（兜底正则三段）
- Modify: `deploy/data-plane.lock`（**重生成**，不是手改。Task 3 已建立同款先例：**每次动 `dbt/**` 都要重生成**）
- Modify: 四个测试文件的夹具 + `dbt/README.md` + `modules/data/README.md` 的示例
- Test: 上述各测试

**Interfaces:** 无新接口（形态变更）。

- [ ] **Step 1: 改声明与正则**（逐处）

```js
// check-data-models.mjs：`<源>:<业务域>:<指标>`，三段都小写蛇形
const METRIC_NAME_RE = /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/
```
（`metricToAuditFileName` 的 `:`→`__` 映射**不用改**——它对段数不敏感 ✓，文件名自然变成 `audit_lemeng__retail__net_sales.sql`。）

- [ ] **Step 2: 跑门禁确认红**（先跑一次 `pnpm exec tsx scripts/check-data-models.mjs`，应报「对账文件不存在」= 改名没改全的证据）

- [ ] **Step 3: 改全 + 重生成 lock**

```bash
git mv dbt/tests/audit_retail__net_sales.sql dbt/tests/audit_lemeng__retail__net_sales.sql
pnpm exec tsx scripts/check-data-models.mjs          # 应 OK
pnpm exec tsx scripts/lemeng/data-plane-lock.mjs     # 重生成 lock（清单里该文件 sha/路径都会变）
pnpm exec tsx scripts/check-data-plane-lock.mjs      # 应 OK
```

- [ ] **Step 4: 改夹具与文档**（`grep -rn 'retail:net_sales' --include='*.ts' --include='*.tsx' --include='*.md' --include='*.json'` 逐条改；**确认没有漏**：`scripts/sync-data-semantics.test.ts`、`scripts/check-data-models.test.ts`、`modules/data/domain/semantic-compiler.test.ts`、`modules/data/console/metrics/index.test.tsx`、`scripts/e2e-data-cross-tenant.test.ts`（经 `E2E_METRIC_ID` 的部分**只改文档串**，env 值由运行方给））

- [ ] **Step 5: 跑全量测试与门禁** → `pnpm exec vitest run --dir scripts`、`DATABASE_URL=… pnpm --filter data test`、`pnpm typecheck`、`check-data-models`、`check-data-plane-lock`

- [ ] **Step 6: 记录数据侧影响**（写进报告与 README）：**L2 行不存 `baseMetric` 列**（只存编译后的 `select_sql` 与 `description: L2 派生自 <旧 id>`）⇒ 改名**不动既有 L2 的 SQL**，只有 `description` 文本里的旧 id 变陈旧；**MCP 工具名 = 指标 id** 会随改名变化（对外可见，属预期）。

- [ ] **Step 7: Commit**（**单 scope**）

```bash
git add -A dbt scripts modules/data deploy/data-plane.lock
git commit -m "feat(data): 指标命名改三段式 <源>:<业务域>:<指标>（解同名冲突）+ 锁重生成"
```

---

### Task 5: 裁剪收口 + 写入闸

**Files:**
- Modify: `modules/data/domain/authz.ts`（`visibleMetrics` 加源维度）
- Modify: 四个消费方（`routes/metrics.ts`、`routes/mcp.ts`、`domain/agent-loop.ts`、`domain/query-service.ts` 的调用点）
- Modify: `modules/data/routes/metrics.ts`（`writeL2` 加闸）
- Test: `modules/data/catalog-consumers.test.ts`（**扩展**）、`modules/data/domain/authz.test.ts`、`modules/data/routes/metrics.test.ts`

**Interfaces:**
- Produces:
  - `visibleMetrics(catalog, requester, adoptedSources: ReadonlySet<string>): MetricRow[]`——**新签名**（第三个参数必填）。
    过滤规则：`m.sourceSystem === null || adoptedSources.has(m.sourceSystem)`（**L2 行恒可见**：它是本租户自己写的，没有源维度）。
  - 写入闸：`writeL2` 在 `resolveL1Base` 成功后判 `base.sourceSystem` 是否在已接入集内；不在 ⇒ `403 { error: 'METRIC_SOURCE_NOT_ADOPTED', its_source, your_sources }`。

- [ ] **Step 1: 写失败测试**（`authz.test.ts`：三行词表——已接入源的 L1、未接入源的 L1、L2 ⇒ 断言只出前两行；`catalog-consumers.test.ts`：扩展那条「四消费方都经 `visibleMetrics`」的机器判据，**钉住新签名**；`metrics.test.ts`：未接入源 ⇒ 403 带 `its_source`/`your_sources`）

- [ ] **Step 2: 跑测试确认红**

- [ ] **Step 3: 实现**（`visibleMetrics` 加参；四处调用点从**投影**取集合——`c.get(TENANT_SOURCES) ?? []`；`writeL2` 加闸）

> ⚠️ 四处调用点**必须都改**——漏一处会让那条路径**放行未接入源的指标**（而 `catalog-consumers.test.ts` 正是防这个的机器判据，先扩展它再改代码）。

- [ ] **Step 4: 跑测试确认绿 + 全模块** → `DATABASE_URL=… pnpm --filter data test`

- [ ] **Step 5: 复核 spec §3⑧ 的那条 fail-open**（**不加代码**，只钉住）：宿主门卫已保证无身份 ⇒ **401**（`packages/platform-sdk/src/module.ts:195-198`），模块内的「空列表」分支只有 `orgId === ''` 才够得着。**补一条断言**（无 identity 请求 `GET /metrics` ⇒ 401）钉住它，并在 README 写明「这不是模块自己判的，是门卫判的」。

- [ ] **Step 6: Commit**

```bash
git add modules/data/domain/authz.ts modules/data/domain/authz.test.ts modules/data/catalog-consumers.test.ts modules/data/routes/metrics.ts modules/data/routes/metrics.test.ts modules/data/routes/mcp.ts modules/data/domain/agent-loop.ts modules/data/domain/query-service.ts
git commit -m "feat(data): 词表按租户已接入源裁剪（收口 visibleMetrics）+ 未接入源的写入闸 403"
```

---

### Task 6: 防漂对账（平台登记 ↔ console 声明）+ console env 键

**Files:**
- Create: `scripts/reconcile-tenant-sources.mjs`（照 `reconcile-data-tenants.mjs` 的骨架）
- Modify: `deploy/data-compose.yml`（两个 console 服务的 `environment:` 各加一行 `ADOPTED_SOURCES: ${ADOPTED_SOURCES_<账套>:-}`）
- Test: `scripts/reconcile-tenant-sources.test.ts`（纯核对账函数）

**Interfaces:**
- Consumes: `platform.tenant_source`（平台侧）、console env `ADOPTED_SOURCES`（声明侧）。
- Produces: 四桶双向差集 + 出口码 `0`（干净）/ `1`（漂移）/ `2`（对不成账），打印风格 `[reconcile-sources] …` + `✓/✗`。

- [ ] **Step 1: 写纯核函数与测试**（纯函数 `diffSources(platformRows, consoleDecls)` → 四桶：`missingInConsole` / `missingInPlatform` / `disabledButDeclared` / `declaredButDisabled`；**元素字段恒在**，照既有脚本的形态）

- [ ] **Step 2: 跑测试确认红 → 实现 → 绿**

- [ ] **Step 3: 接入口与打印**（`main()`：env 取 `DATABASE_URL`；console 声明从**参数或 env** 读——⚠️ **不要**去 SSH 读 console env（违反唯一通道），改为**运行方传入**：`ADOPTED_SOURCES_3120=lemeng ADOPTED_SOURCES_64188=lemeng pnpm exec tsx scripts/reconcile-tenant-sources.mjs`，并在用法行写明「值从 openship 项目 env 取」）

- [ ] **Step 4: Commit**

```bash
git add scripts/reconcile-tenant-sources.mjs scripts/reconcile-tenant-sources.test.ts deploy/data-compose.yml
git commit -m "feat(scripts): 已接入源对账（平台登记 ↔ console 声明，四桶双向差集）"
```

---

### Task 7: 文档（README + SOP）

**Files:**
- Modify: `modules/data/README.md`（「语义（词表）」小节：源维度的两列、裁剪与写入闸、命名三段式）
- Modify: `deploy/data-plane-deploy-sop.md`（console 的 `ADOPTED_SOURCES` 声明键 + 对账命令 + 纳入验收清单）

- [ ] **Step 1: 写文档**（逐字要点：
  - **数据侧影响（订正记录 2026-09-30，Task 4 评审转办）**：改名**不动既有 L2 行的 SQL**（L2 落库的是**编译后的** `select_sql`，`data.metrics` 没有 `base_metric` 列）——只有 `description` 文本里的「L2 派生自 <旧 id>」会陈旧；而 **MCP 工具名 = 指标 id**，故改名**对外可见**（属预期）。① `l1_metrics.yml` 的 `sources`（存储路径）与新 `source`（源系统）**语义不同，别混**；② 命名 `<源>:<业务域>:<指标>`；③ 裁剪在 `visibleMetrics` 一处收口 + 写入闸 403 的形状；④ 无身份 **401 由宿主门卫给**，不是模块判的；⑤ 对账命令与「值从 openship env 取」；⑥ **源登记 ↔ 契约 `domain` 只要求同名约定，本计划不做自动映射**）
- [ ] **Step 2: Commit**

```bash
git add modules/data/README.md deploy/data-plane-deploy-sop.md
git commit -m "docs(deploy): 源维度的接线与边界（console 声明键 / 对账 / 命名三段式）"
```

---

## Self-Review（写完后自查）

**1. spec 覆盖**：§3⑧ 的**裁剪**（Task 5）＋**写入闸**（Task 5，403 形状照 spec 的 `its_source`/`your_sources`）＋**前提「谁接了哪个源」**（Task 1 表 + Task 2 投影 + Task 6 对账）＋**fail-open 复核**（Task 5 Step 5）；待办 7 的**两条都做**（Task 3 字段 + Task 4 改名）；待办 6 的**三件**（① 契约 `domain` 已存在、② 平台登记 = Task 1、③ 防漂对账 = Task 6）。
**2. 占位符扫描**：无 TBD；`…` 只用于命令里的 `DATABASE_URL` 重复前缀。
**3. 类型一致性**：`TENANT_SOURCES`（Task 2 产，Task 5 消）；`visibleMetrics(catalog, requester, adoptedSources)` 新签名在 Task 5 内产消且被 `catalog-consumers.test.ts` 钉住；`sourceSystem: string | null`（Task 3 产，Task 5 消）；`METRIC_SOURCE_NOT_ADOPTED` 的 body 形状（`its_source`/`your_sources`）与 spec 逐字一致。

## 已定裁决（人裁 2026-09-30，实施前不要再翻）

| # | 问题 | 裁决 | 依据 |
|---|---|---|---|
| 1 | 登记表落哪 | **`platform.tenant_source` + 宿主按请求投影**（不放模块 schema） | B1：`modules/**` 读不到 `platform`、`apps/**` 读不到 `data` ⇒ 放 platform 才能让管理面/开通/对账自足；投影有 `TENANT_STORAGE` 现成先例 |
| 2 | 源维度字段形态 | **新增单值 `source`**（L1 逐源口径） | 既有 `sources` 是**存储路径列表**，语义不同、不能兼用（侦查实测） |
| 3 | DB 列名 | **`source_system`** | `data.metrics.source` 已被 `l1`/`l2` 占用 |
| 4 | 命名 | **改三段式 `<源>:<业务域>:<指标>`**（趁 agent 通路尚未上线） | `(org,id)` 主键下，第二源才能用同一业务概念名声明而不撞键 |
| 5 | 投影是否每请求查库 | **是，先不做缓存** | storage 投影零 IO 是因为读的是租户行列；源是集合只能查表。量小，要压测再加 |

## 与另几份计划的关系

| 计划 | 内容 | 状态 |
|---|---|---|
| 1–4 | 底座 / 写保护 / 管理面 / 反代会话 | 已交付（PR #329 / #385 / #338 / #366+#372） |
| **5（本份）** | **语义的源维度**（§3⑧ + 待办 6/7） | 待实施 |
| 6 | **agent 制作通路**：自绘声明式规格 + 严格字段白名单 + 提议≠新建/确认流 + `tier` 与「未声明口径」可见性（§3⑥、§4.3–4.5） | 待写 |
