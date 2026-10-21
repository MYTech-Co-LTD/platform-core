# 明细读面（Phase 0）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建出 `vw_lemeng_retail_order_line`（直读湖、逐列 cast、带封版断言），并验掉 gate 1（新鲜度）与 gate 3（读今天的竞态），同时把 pg_duckdb 内存对齐到 cgroup。

**Architecture:** 视图 = **staging 模型的 SELECT 列表与 FROM 块**，只把物化方式从 `table` 换成 `view`，从而直读湖而不是读物化表。列清单由契约生成器（`gen-data-projection.mjs`）接管，与 staging 同源；FROM 块（冷/热两段 + 封版断言）手写，靠一条**行为不变量**（闭窗日行数与 staging 相等）守住不漂移。

**Tech Stack:** dbt-core 1.9.1 + dbt-postgres、pg_duckdb 18-v1.1.1、DuckDB `read_parquet`、Node/tsx（生成器与门禁）。

## Global Constraints

- **列清单唯一事实源 = `contracts/*.json`**；视图的 SELECT 列表必须是生成物，**禁止手写**。
- **逐列显式 cast**，类型映射守 `sqlType()` 铁律：`bigint→bigint`（不许塌成 `int`）、`decimal(p,s)→numeric(p,s)`（不许裸 `numeric`）。
- **FROM 必须带封版断言**：`_SCHEMA/v3.parquet` 存在且 `schema_version = 3`；冷（`_DAY_DATA`）+ 热（`hour=`）**两段都要在**。
- **主体列 `org` 由 `{{ subject_org() }}` 注入**，位置在 `system_book` 之后（`buildStagingSelect` 的 `orgAfter`）。
- **不改动聚合面**：`fct_*`、`stg_*` 的物化方式与 SQL 一律不动。
- **视图落单 schema + `org` 列**（否决 `2026-09-26` spec §3.6 的 `tenant_<org>`）。
- 任何跨容器 exec 的判据**只用纯 ASCII 匹配串**（中文会被通道替换成 `?`，恒返 0）。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `scripts/gen-data-projection.mjs` | **改**：新增「视图面」——把 `vw_*` 的 SELECT 列表也纳入生成/校验 |
| `dbt/models/lemeng/views/vw_lemeng_retail_order_line.sql` | **新建**：视图骨架（config + FROM 冷/热 + 封版断言），SELECT 列表由生成器写入 |
| `scripts/check-data-models.mjs` | **改**：主体列扫描面扩到 `views/` |
| `dbt/tests/lemeng/assert_vw_retail_order_line_matches_stg.sql` | **新建**：行为不变量（闭窗日行数一致） |
| `deploy/data-compose.yml` | **改**：pg_duckdb 显式 `duckdb.memory_limit` |

---

### Task 1: 生成器新增「视图面」

**Files:**
- Modify: `scripts/gen-data-projection.mjs`（`runGenerate` 内，staging 分支之后）
- Test: `scripts/gen-data-projection.test.ts`

**Interfaces:**
- Consumes: `buildStagingSelect(columns, orgAfter)` → `string`（已存在，产出 `select\n  r['col']::type as col, …\n  {{ subject_org() }}       as org`）
- Produces: `viewPathFor(rootDir, contract)` → `string`（视图模型绝对路径）；`runGenerate` 额外返回被改动的视图文件列表

- [ ] **Step 1: 写失败测试**

```ts
// scripts/gen-data-projection.test.ts（追加）
it('视图面：vw_ 模型的 SELECT 列表与 staging 同源生成', () => {
  const root = mkTmpRepoWithViewSkeleton()   // 复用本文件已有的 temp-repo 构造器
  const code = runGenerate(root, {})
  const view = readFileSync(join(root, 'dbt/models/lemeng/views/vw_lemeng_retail_order_line.sql'), 'utf8')
  // 列区与 staging 逐字相同（同一 buildStagingSelect）
  const stg = readFileSync(join(root, 'dbt/models/lemeng/staging/stg_lemeng_retail_order_line.sql'), 'utf8')
  assert.equal(selectListOf(view), selectListOf(stg))
  assert.equal(code, 0)
})

it('视图面：手改视图列区 ⇒ --check 报红', () => {
  const root = mkTmpRepoWithViewSkeleton()
  const p = join(root, 'dbt/models/lemeng/views/vw_lemeng_retail_order_line.sql')
  writeFileSync(p, readFileSync(p, 'utf8').replace('as sale_money', 'as sale_money_x'))
  assert.equal(runGenerate(root, { check: true }), 1)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run scripts/gen-data-projection.test.ts -t '视图面'`
Expected: FAIL —— `ENOENT … vw_lemeng_retail_order_line.sql`（视图面尚未实现）

- [ ] **Step 3: 实现**

```js
// scripts/gen-data-projection.mjs —— 与 staging 分支并列
/** 视图模型路径：vw_<domain>_<table>.sql，统一放 dbt/models/<domain>/views/ */
export function viewPathFor(rootDir, c) {
  return join(rootDir, 'dbt/models/' + c.domain + '/views', `vw_${c.domain}_${c.table}.sql`)
}
```

在 `runGenerate` 里 staging 那一段之后追加（**逐字复用 `buildStagingSelect`**，因为视图的 FROM 同样把 parquet 别名为 `r`）：

```js
// ④b 视图面：列清单与 staging 同源（同一 buildStagingSelect）
const viewPath = viewPathFor(rootDir, c)
if (existsSync(viewPath)) {
  const before = readFileSync(viewPath, 'utf8')
  const next = rewriteSelectList(before, buildStagingSelect(c.columns, c.orgAfter))
  if (next !== before) {
    changed.push(viewPath)
    if (!opts.check) writeFileSync(viewPath, next)
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec vitest run scripts/gen-data-projection.test.ts`
Expected: PASS（含原有全部用例）

- [ ] **Step 5: 提交**

```bash
git add scripts/gen-data-projection.mjs scripts/gen-data-projection.test.ts
git commit -m "feat(data): 生成器新增视图面——vw_* 列清单与 staging 同源"
```

---

### Task 2: 视图模型骨架

**Files:**
- Create: `dbt/models/lemeng/views/vw_lemeng_retail_order_line.sql`

**Interfaces:**
- Consumes: Task 1 的 `viewPathFor` + 生成器（写入 SELECT 列表）
- Produces: PG 关系 `vw_lemeng_retail_order_line`（列集 = 契约 25 列 + `org`）

- [ ] **Step 1: 建骨架 —— 逐字复制 staging 模型，只翻 materialized**

⚠️ **不要自己写 FROM**。`gen-data-projection.mjs` 的位点识别有两条硬约束（见脚本内注释）：

1. **模型不能带前置 CTE**（`with x as (select …)`）——会被判为「嵌套位点」并**抛错**；
2. 子查询里的 `select 1 from …` 必须**写成一行**，否则会被当成第三个投影位点。

⇒ 唯一正确做法是**照抄** `dbt/models/lemeng/staging/stg_lemeng_retail_order_line.sql` 的正文：

```bash
cp dbt/models/lemeng/staging/stg_lemeng_retail_order_line.sql \
   dbt/models/lemeng/views/vw_lemeng_retail_order_line.sql
```

然后只改两处：

```diff
-{{ config(materialized='table') }}
+{{ config(materialized='view') }}
```
```diff
--- stg_lemeng_retail_order_line — …（原头注）
+-- vw_lemeng_retail_order_line — 与 stg_lemeng_retail_order_line **正文逐字相同**，只把物化方式
+-- 从 table 翻成 view ⇒ **直读湖**而不是读物化表（明细的近实时读面）。
+-- 列清单由 scripts/gen-data-projection.mjs 从契约生成，**禁止手写**；FROM 块（冷/热两段 +
+-- 封版断言 + 热侧排除已封版日子）与 staging 同源，漂移由
+-- dbt/tests/lemeng/assert_vw_retail_order_line_matches_stg.sql 兜住。
```

**为什么允许「复制 FROM」**：两条读面各自要读湖，没有能同时服务「物化一次」与「每次直读」的共用形态；而复制带来的漂移风险由 Task 4 的**行为不变量**（闭窗日行数相等）兜住——那是行为判据，比文本对比稳。



- [ ] **Step 2: 生成列区**

Run: `pnpm exec tsx scripts/gen-data-projection.mjs`
Expected: 提示改写 `dbt/models/lemeng/views/vw_lemeng_retail_order_line.sql`；文件列区变为 25 列 + `{{ subject_org() }} as org`

- [ ] **Step 3: 校验生成物幂等 + 未被手改**

Run: `pnpm exec tsx scripts/gen-data-projection.mjs --check`
Expected: exit 0

- [ ] **Step 4: 本地 YAML/SQL 结构自检（无 dbt 时）**

Run: `diff <(sed 's/^--.*//' dbt/models/lemeng/views/vw_lemeng_retail_order_line.sql) <(sed 's/^--.*//' dbt/models/lemeng/staging/stg_lemeng_retail_order_line.sql)`
Expected: 只差 `materialized='view'` 那一行（**这是本步的判据**）

> ⚠️ **别用 `grep -c "r\['"` 当判据**（本稿早先写的 `25` 是错的，2026-10-21 实测订正）：
> 该文件有**冷/热两个平铺投影位点**，每处 25 个契约列 = 50，再加 7 处出现在 FROM/注释里的 `r['`，
> 实测恒为 **57**。「25」只是**单条**投影位点的列数，拿它当全文计数判据必然假红。
> 与 staging 逐字 diff 才是真判据：它同时盖住「列区同源」与「FROM 块同源」两件事。

- [ ] **Step 5: 提交**

```bash
git add dbt/models/lemeng/views/vw_lemeng_retail_order_line.sql
git commit -m "feat(data): 新增零售明细直读湖视图 vw_lemeng_retail_order_line"
```

---

### Task 3: 门禁接线（主体列扫描面 + lock）

**Files:**
- Modify: `scripts/check-data-models.mjs`（规则 ⑩ 的扫描面）
- Modify: `deploy/data-plane.lock`（重生成）
- Test: `scripts/check-data-models.test.ts`

**Interfaces:**
- Consumes: Task 2 的视图文件
- Produces: 无（门禁）

- [ ] **Step 1: 写失败测试**

```ts
// scripts/check-data-models.test.ts（追加）
it('视图层也必须带主体列 org（规则 ⑩ 扫描面已扩到 views/）', () => {
  const root = mkTmpRepoWithView({ orgLine: false })   // 视图里去掉 org 注入
  const r = checkDataModels(root)
  assert.ok(r.violations.some((v) => v.includes('vw_lemeng_retail_order_line') && v.includes('org')))
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run scripts/check-data-models.test.ts -t '视图层'`
Expected: FAIL —— 当前扫描面只覆盖 `staging/` 与 `marts/`

- [ ] **Step 3: 实现**

```js
// scripts/check-data-models.mjs —— 规则 ⑩ 的文件集
const VIEW_RE = /^dbt\/models\/(?:.+\/)?views\/vw_[A-Za-z0-9_]+\.sql$/
// 原：stagingFiles + martsFiles
// 改为：stagingFiles + martsFiles + sqlFiles.filter((f) => VIEW_RE.test(f))
```

- [ ] **Step 4: 跑测试 + 全量门禁**

Run: `pnpm exec vitest run scripts/check-data-models.test.ts && pnpm exec tsx scripts/check-data-models.mjs`
Expected: 测试 PASS；门禁 OK

- [ ] **Step 5: 重生成 lock（视图在数据面清单树里）**

Run: `pnpm exec tsx scripts/lemeng/data-plane-lock.mjs && pnpm exec tsx scripts/check-data-plane-lock.mjs`
Expected: 写入 lock；检查 OK

- [ ] **Step 6: 提交**

```bash
git add scripts/check-data-models.mjs scripts/check-data-models.test.ts deploy/data-plane.lock
git commit -m "feat(data): 门禁扫描面扩到 views/，重生成 data-plane.lock"
```

---

### Task 4: 视图 vs staging 的行为不变量

**Files:**
- Create: `dbt/tests/lemeng/assert_vw_retail_order_line_matches_stg.sql`

**Interfaces:**
- Consumes: `vw_lemeng_retail_order_line`（Task 2）、`stg_lemeng_retail_order_line`
- Produces: dbt singular test（返回任何行即失败）

- [ ] **Step 1: 写测试**

```sql
-- assert_vw_retail_order_line_matches_stg — 视图与 staging 必须同源。
-- 为什么需要：两者的 FROM 块是**两份手写**（视图直读湖、staging 物化）。
-- 抄错一处（漏掉热侧/漏掉「排除已封版日子」的谓词）会**静默**多算或双算。
-- 判据取**闭窗日**（bizday < 上海今天）：今天的文件被 tick 重写，两侧时点不同，不可比。
with a as (
    select count(*)::bigint as n
    from {{ ref('vw_lemeng_retail_order_line') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
),
b as (
    select count(*)::bigint as n
    from {{ ref('stg_lemeng_retail_order_line') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
)
select a.n as vw_rows, b.n as stg_rows,
       '视图与 staging 行数不一致（FROM 块抄错：漏热侧 / 未排除已封版日子 / 封版断言缺失）' as note
from a, b
where a.n is distinct from b.n
union all
-- ⚠️ 空转绿守卫**必须**写成 `a.n = 0 and b.n = 0`。早先写的 `where not exists (select 1 from b)`
-- 是**死分支**：a/b 都是无 group by 的 `count(*)`，恒返一行，`not exists` 恒为假。
-- （既有 audit_*.sql 的同款守卫有效，是因为它那侧是**带 group by 的**子查询，可以为空。）
select a.n, b.n, '两侧都为空：对账在空集上「通过」是空转绿'
from a, b
where a.n = 0 and b.n = 0
```

- [ ] **Step 2: 真机跑一次（在数据面机器上，经 materialize job 的 dbt 环境）**

Run: `docker exec -w /app <dbt-runner> dbt test --select assert_vw_retail_order_line_matches_stg`
Expected: PASS（0 行返回）

- [ ] **Step 3: 变异确认（必做）**

把视图 FROM 的热侧那一段**临时注释掉**，重跑：
Expected: **FAIL 且 `vw_rows < stg_rows`** —— 证明这条测试真能抓漂移（不红就是空转绿）

- [ ] **Step 4: 复原并提交**

```bash
git add dbt/tests/lemeng/assert_vw_retail_order_line_matches_stg.sql
git commit -m "test(data): 视图与 staging 的闭窗日行数不变量"
```

---

### Task 5: pg_duckdb 内存对齐

**Files:**
- Modify: `deploy/data-compose.yml`（pg_duckdb 的 `command`）

**Interfaces:**
- Consumes: 无
- Produces: `duckdb.memory_limit` ≤ 容器 cgroup

- [ ] **Step 1: 改 command**

```yaml
    # 既有：shared_preload_libraries 是 pg_duckdb 硬要求
    # 新增：duckdb.memory_limit 默认 4096MB/连接，而本服务 mem_limit 默认 2g（2048MB）
    #   ⇒ DuckDB 以为自己有 4GB，重查询会被 cgroup OOM kill（无错误、容器重启）。
    #   收到 1536MB 留出 PG 自身与连接开销的余量。
    command: ["postgres", "-c", "shared_preload_libraries=pg_duckdb", "-c", "duckdb.memory_limit=1536MB"]
```

- [ ] **Step 2: 真机核（部署后）**

```bash
# 在 server 容器内
node -e "const{Client}=require('pg');(async()=>{const c=new Client({connectionString:process.env.DATA_WAREHOUSE_URL});await c.connect();const r=await c.query(\"select current_setting('duckdb.memory_limit') as mem\");console.log(r.rows[0]);await c.end()})()"
```
Expected: `mem = 1536MB`（不是 `4GB`）

- [ ] **Step 3: 提交**

```bash
git add deploy/data-compose.yml
git commit -m "fix(data): pg_duckdb 显式 duckdb.memory_limit=1536MB，对齐 2g cgroup"
```

---

### Task 6: 部署 + gate 2 复核（视图可见、类型正确）

**Files:** 无（真机验证）

**Interfaces:**
- Consumes: Task 2/5 的产物
- Produces: 验收结论（记录进 PR）

- [ ] **Step 1: 走部署链**

山海项目部署 → 触发 materialize job（`custom:yNWqnvY65iWz1unf`）
Expected: 末行 `MATERIALIZE_OK`（中间行 `MATERIALIZE_FAILED:dbt_build` 不算失败，脚本内建 retry）

- [ ] **Step 2: 核视图存在且类型正确**

```bash
# server 容器内，纯 ASCII 判据
node -e "const{Client}=require('pg');(async()=>{const c=new Client({connectionString:process.env.DATA_WAREHOUSE_URL});await c.connect();const t=await c.query(\"select table_name,table_type from information_schema.tables where table_name='vw_lemeng_retail_order_line'\");console.log('TYPE',JSON.stringify(t.rows));const bad=await c.query(\"select column_name,data_type from information_schema.columns where table_name='vw_lemeng_retail_order_line' and data_type='USER-DEFINED'\");console.log('USER_DEFINED_COLS',bad.rowCount);const n=await c.query(\"select count(*)::int n from information_schema.columns where table_name='vw_lemeng_retail_order_line'\");console.log('COL_COUNT',n.rows[0].n);await c.end()})()"
```
Expected: `table_type = VIEW`、`USER_DEFINED_COLS 0`、`COL_COUNT 26`（25 契约列 + `org`）

- [ ] **Step 3: 记录结论**

把三项实测值写进 PR 评论。

---

### Task 7: gate 1（新鲜度）+ gate 3（读今天的竞态）

**Files:** 无（真机验证）

**Interfaces:**
- Consumes: Task 6 的视图
- Produces: 两条 gate 的实测结论

- [ ] **Step 1: gate 1 —— 视图能看见新落湖的数据**

在上海 08:00–24:00 的 tick 时段内：记录某一班 tick 落湖的时刻 → 立刻查视图在**当天**分区的 `count(*)` → 再等 5 分钟查一次。
Expected: 后一次 ≥ 前一次，且能看到新数据；记录「落湖 → 视图可见」的延迟量级。
**红的样子**：两次完全相同且当天迟滞 —— 说明读的是缓存分区或没直读湖。

- [ ] **Step 2: gate 3 —— 撞 tick 重写时行为可控**

在 tick 正在写当天分区的窗口内（可连续重跑同一条查询来撞），跑一次视图查询。
Expected: 要么正常返回，要么 `warehouse_transient` 且**自动重试恰一次**后成功或明确失败。
**红的样子**：静默返回半截数据却报 `ok`；或裸 DuckDB `ERROR`。

- [ ] **Step 3: 记录结论并提交**

```bash
# 无代码改动；结论文本进 PR 评论
```

---

## 自检

**1. Spec 覆盖**：spec §2.2（视图层）→ Task 2/3；§4 Phase 0 六条判据 → Task 4/5/6/7 全覆盖；"契约生成器"→ Task 1；"封版断言"→ Task 2；"内存对齐"→ Task 5；"gate 1/3"→ Task 7。

**2. 占位符**：无。Task 2 Step 1 用 `cp` 复制 staging 正文 + 只翻 `materialized`，**不含任何占位 SQL**。
（早期版本曾写带 CTE 的伪骨架，**已删**——`gen-data-projection.mjs` 的位点识别明确拒绝前置 CTE、并要求子查询里的 `select 1 from …` 写成一行。Task 1 的 worker 用 `rewriteAllSelectLists` 而非单点版是对的：真实模型有两个平铺 select。）

**3. 类型一致性**：`buildStagingSelect(columns, orgAfter)`、`viewPathFor(rootDir, c)`、`runGenerate(rootDir, opts)` 全程同名同参。

---

## 不在本计划内

- Phase 1（度量组件声明面、`query_detail`、权限与掩码接线、不变量测试）——**等 Task 7 的 gate 结论出来再写**，因为 gate 1/3 的结果可能改变 Phase 1 的错误处理与重试接线。
