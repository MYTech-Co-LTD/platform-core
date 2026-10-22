# bot 问数下钻 Phase 2（明细读面并入 + 敏感列门）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把透传 PoC `lemeng:retail:order_line` 并入下钻声明面——行域收 `FINISHED`、grain 26→8、价格列改成 `data:cost` 门控的**条件列**（无码 ⇒ 列缺席），聚合面与下钻面从此同一个行域。

**Architecture:** 声明面只改 `dbt/semantics/l1_metrics.yml` 的一个指标块（新增一个度量组件 `line_amount@line`、表达式内嵌 FINISHED CASE、`detail.columns` 声明条件列）；`sync-data-semantics` 把它物化进 `data.metrics` 的 `drill_detail` jsonb（多一个 `columns` 键，**无 DDL、无迁移**）；执行面在 `drill.ts` 的内层/外层投影各追加 `max(<col>) as <col>`，授权判定复用 `requester.hasScope`。掩码机制（`mask.ts` / `mask_spec` / `maskedSelectSql`）**一字不动**：条件列是「不给这列」，不是「给了看不清」。

**Tech Stack:** dbt 1.91 + pg_duckdb（直读湖视图）、YAML 闭集门禁（check-data-models / check-column-scope-monotonicity）、Hono + zod、pg（jsonb）、openclaw native plugin。

**Spec:** `docs/superpowers/specs/2026-10-22-drillthrough-phase2-design.md`（唯一事实源）。前序 Phase 1 已上线（v469 / 数据面 v99→v101）。

---

## ⚠️ 两处**已裁定的偏差**（开工前先读，别再翻案）

计划与 spec §3.2 / §3.3 一致，执行时**不要**顺手「修正」成口头稿：

1. **契约 `sensitivity` 本批不标**（spec §3.2）。标了会激活 `applyDefaultMaskTier` 的**整值 nullify**，把 `sale_money` 一起藏掉——本批要的是列级门，不是整值门。契约层「这一列敏感」的机器声明缺口**登记给 #780**，本批不留假声明。
2. **聚合面保留读 `stg_lemeng_retail_order_line`**（spec §3.3）。不换 `vw_`：stg 是物化的（聚合查询不碰 S3），现有 audit 比的正是 stg ↔ 湖；两面同源由「vw 正文与 stg 逐字同源」保证，不需要同一个关系名。代价 = 双时钟（Phase 1 设计，非本批引入）。

---

## Global Constraints

- **行域统一** `state = 'FINISHED'`（含退货行；REPAID / CANCELED 不在；非 FINISHED 行在聚合面贡献 0）。聚合面把谓词内嵌进 `expression` 的 CASE，下钻面写在 `detail.filter`——**分组集不统一**（某店日全为作废行时，聚合面出零值组、下钻面 0 行）；两处**声明**漂移 = `scripts/sync-data-semantics.test.ts` 的真事实源用例红（`assert_drill_order_line_matches_metric` 守的是行域**数据同量**，读不到声明）。
- **聚合面关系不动**：`expression` 引用的仍是 `stg_lemeng_retail_order_line`（§3.3）。
- **`mask.ts` / `mask_spec` / `maskedSelectSql` 一字不动**；条件列**不进** `mask_spec`。
- **缺席 ≠ NULL**：无码时该列**不出现在回包 `columns` / `rows`**；不得投影成 `cast(null as …)`。
- **声明面是闭集，先改门禁**：Task 2/3（门禁）必须先于 Task 6（YAML 迁移）落地。
- **投影保持 value-first**：`select (<expr>) as value, <dims>[, max(<col>) as <col>…] from <relation>` —— mask 的整值头部替换按这个形状设计（Phase 1 终审 C1）。
- **`detail.columns[].col` 不许与 `dimensions` 重叠、不许叫 `value`、不许重复**（门禁 + sync 双判）。
- **grain / dimensions 闭集 = 8 列**：`system_book, bizday, branch_num, order_no, order_detail_num, item_num, item_code, order_transaction_type`。排除全部金额/数量列与 `state` / `batch_id` / `hour` / `org` / 门店名 / 时间列。
- **`item_code` 契约明文恒为空串**（上游订单 API 无此字段）——保留在闭集只因它在契约列集里，`definition` 必须注明。
- **改 `dbt/` 任意文件 ⇒ 重跑 `pnpm exec tsx scripts/lemeng/data-plane-lock.mjs`**（`deploy/data-plane.lock` 覆盖 `dbt/` 目录型条目，CI 的 `check-data-plane-lock` 会红）。
- **提交纪律**：Conventional Commits；feat 先建 issue，PR body 含 `Closes #N`；squash 合并；**只等 CI CLEAN**，不拿 UNSTABLE 强合；不手写 CHANGELOG；不删改 provenance trailer。
- **`scripts/` 是 checkJs**：导出函数单形状、字段恒在对象，不写可辨识联合（字面量类型会被加宽，假绿先例）。
- **shell 里 `$VAR` 紧跟中文必须写 `${VAR}`**（bash 3.2 吃掉）。
- **本地跑 server 测试需要 `DATABASE_URL`**；本计划的 `drill.test.ts` / 门禁单测**都不需要真库**。
- **运维一律走 openship MCP**，不裸 SSH。

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `modules/data/domain/authz.ts` | `DrillColumn` 类型 + `DrillBinding.columns` | 改 |
| `modules/data/domain/metric-store.ts` | `drillBindingOf` 解析条件列（坏形状 ⇒ 整绑定作废） | 改 |
| `modules/data/domain/audit-store.ts` | 审计 drill 面加 `grantedColumns` | 改 |
| `modules/data/domain/drill.ts` | 条件列投影 + 授权过滤 + 审计 | 改 |
| `modules/data/domain/drill.test.ts` | 条件列单测（无码/有码/坏形状/审计） | 改 |
| `scripts/check-data-models.mjs` + `.test.ts` | `detail` 键闭集 + `columns` 形状 | 改 |
| `scripts/check-column-scope-monotonicity.mjs` + `.test.ts` | 规则 ⑤：`grantedBy` ∈ manifest 码 | 改 |
| `scripts/sync-data-semantics.mjs` + `.test.ts` | `detailDetailOf` / `detailColumnsOf` / `drillOf` / `drillTripleOf` | 改 |
| `dbt/semantics/l1_metrics.yml` | `line_amount@line` 组件 + `order_line` 声明迁移 | 改 |
| `dbt/README.md` | `detail` 键闭集文档（门禁头注要求同步维护） | 改 |
| `dbt/tests/lemeng/audit_lemeng__retail__order_line.sql` | 行域收 FINISHED | 改 |
| `dbt/tests/lemeng/assert_drill_order_line_matches_metric.sql` | **新建**：行域**数据面同量**不变量（读不到声明） | 新建 |
| `deploy/openclaw/data-query-plugin/index.js` + `lib.test.js` | 工具描述补「条件列缺席 = 未授权」 | 改 |
| `deploy/openclaw/data-query-plugin/skills/data-query/SKILL.md` | 明细下钻节补一行 | 改 |
| `modules/data/domain/agent-loop.ts` | 同名工具描述补同一口径 | 改 |
| `deploy/data-plane.lock` | 派生，`dbt/` 改动后重算 | 改 |

---

### Task 0: 建 issue + 对齐基线

**Files:** 无代码改动。

**Interfaces:**
- Produces: issue 编号 `#N`（后续所有提交/PR 引用它）。

- [ ] **Step 1: spec 先合 main**——spec 分支 `docs/2026-10-22-drillthrough-phase2-design` 提 PR（docs 类型，body 贴 spec 路径），等 CI CLEAN 后 squash 合并。**spec 不在 main 上就开工 = 没有唯一事实源。**

- [ ] **Step 2: fetch 并对齐**

```bash
git fetch origin main && git ls-remote origin refs/heads/main
```

从 `origin/main` 拉新分支 `feat/bot-drillthrough-phase2`（多会话并行纪律：动手前必 fetch，别在本工作树的 docs 分支上继续写）。

- [ ] **Step 3: 建 issue**（feat 门禁）

标题：`feat(data): bot 问数明细下钻 Phase 2——明细读面并入 order_line + data:cost 条件列`
正文：spec 路径 + 本计划路径 + 两处已裁定偏差（§3.2 / §3.3）一句话。记下 `#N`。

---

### Task 1: 类型与读侧——`DrillColumn` / `DrillBinding.columns` / `drillBindingOf`

**Files:**
- Modify: `modules/data/domain/authz.ts:108-117`（`DrillBinding`）
- Modify: `modules/data/domain/metric-store.ts:156-166`（`drillBindingOf`；`DrillBinding` import 处补 `DrillColumn`）
- Test: `modules/data/domain/drill.test.ts`

**Interfaces:**
- Produces: `export interface DrillColumn { col: string; grantedBy: string }`；`DrillBinding` 增 `columns?: DrillColumn[]`（**可选 = 未声明**，不是空数组）。
- Consumes: 无。

- [ ] **Step 1: 写失败测试**（`drill.test.ts` 的 `runDetailQuery` describe 内追加）

```ts
  it('detail.columns 坏形状 ⇒ 整个下钻绑定作废（no_detail_binding，fail-closed）', async () => {
    // 读侧不信任存储形状（同三键纪律）：一份读不懂的权限声明，宁可不给下钻，
    // 也不按它去投影列——「半绑」会让未授权列有暴露面。
    const { pool, audits } = fakePool([{
      ...METRIC_ROW, id: 'drill:badcols',
      drill_detail: { relation: 'vw_t', filter: 'true', columns: [{ col: 'order_detail_std_price' }] },
    }])
    const sqls: string[] = []
    const out = await runDetailQuery(depsOf(pool, sqls), ORG, req(), 'drill:badcols', ARGS, {})
    expect(out).toEqual({ status: 'denied', metricId: 'drill:badcols', reason: 'no_detail_binding', detail: NO_BINDING_DETAIL })
    expect(sqls).toEqual([])
    expect(audits[0].params[AUDIT_REASON]).toBe('no_detail_binding')
  })

  it('detail.columns 合法 ⇒ 绑定照常成立（条件列由执行面消费，Task 5 验）', async () => {
    const { pool } = fakePool([{
      ...METRIC_ROW, id: 'drill:cols',
      drill_detail: { relation: 'vw_t', filter: 'true', columns: [{ col: 'order_detail_std_price', grantedBy: 'data:cost' }] },
    }])
    const out = await runDetailQuery(depsOf(pool, []), ORG, req(), 'drill:cols', ARGS, {})
    expect(out.status).toBe('ok')
  })
```

- [ ] **Step 2: 跑测试确认失败**：`pnpm --filter data test -- drill.test.ts` → 第一条 FAIL（坏 columns 仍被当合法绑定 ⇒ `ok`）。

- [ ] **Step 3: 实现**

`authz.ts` 在 `DrillBinding` 之前加：

```ts
/** 下钻的条件列（spec 2026-10-22 §2.3）：持 `grantedBy` 才投影；无码 ⇒ 该列**不在场**。 */
export interface DrillColumn {
  col: string
  grantedBy: string
}
```

`DrillBinding` 末尾加：

```ts
  /** 条件列（spec 2026-10-22 §2.3）：缺省 = 无（**字段缺席**，不是空数组）。 */
  columns?: DrillColumn[]
```

`metric-store.ts` 的 `drillBindingOf` 改为：

```ts
function drillBindingOf(row: Record<string, unknown>): DrillBinding | undefined {
  const expr = row.drill_expr
  const dims = row.drill_dims
  const detail = row.drill_detail
  if (typeof expr !== 'string' || expr === '') return undefined
  if (!Array.isArray(dims) || dims.length === 0 || dims.some((d) => typeof d !== 'string' || d === '')) return undefined
  if (typeof detail !== 'object' || detail === null) return undefined
  const d = detail as { relation?: unknown; filter?: unknown; columns?: unknown }
  if (typeof d.relation !== 'string' || d.relation === '' || typeof d.filter !== 'string' || d.filter === '') return undefined
  // 条件列（spec 2026-10-22 §2.3）：给了就必须是合法非空数组；坏形状 ⇒ **整个绑定作废**
  // （fail-closed：宁可不给下钻，也不按一份读不懂的权限声明投影列）。缺省 = 字段缺席。
  let columns: DrillColumn[] | undefined
  if (d.columns !== undefined) {
    if (!Array.isArray(d.columns) || d.columns.length === 0) return undefined
    const out: DrillColumn[] = []
    for (const item of d.columns) {
      if (item === null || typeof item !== 'object') return undefined
      const it = item as { col?: unknown; grantedBy?: unknown }
      if (typeof it.col !== 'string' || it.col === '' || typeof it.grantedBy !== 'string' || it.grantedBy === '') return undefined
      out.push({ col: it.col, grantedBy: it.grantedBy })
    }
    columns = out
  }
  return {
    expr, dims: dims as string[], relation: d.relation, filter: d.filter,
    ...(columns === undefined ? {} : { columns }),
  }
}
```

文件头 import 行原文是 `import type { DrillBinding, MaskSpec, MetricDef, MetricParamDef } from './authz'`，改为：

```ts
import type { DrillBinding, DrillColumn, MaskSpec, MetricDef, MetricParamDef } from './authz'
```

- [ ] **Step 4: 跑测试 + 类型**：`pnpm --filter data test -- drill.test.ts` → PASS；`pnpm --filter data typecheck` → 绿。

- [ ] **Step 5: Commit**

```bash
git add modules/data/domain/authz.ts modules/data/domain/metric-store.ts modules/data/domain/drill.test.ts
git commit -m "feat(data): 下钻绑定接条件列（DrillColumn + 读侧 fail-closed 解析）"
```

---

### Task 2: 门禁——`check-data-models` 的 `detail` 键闭集 + `columns` 形状

**Files:**
- Modify: `scripts/check-data-models.mjs`（`if (composeRaw !== undefined)` 块内、`detail.filter` 检查之后，约 1155-1174 行）
- Test: `scripts/check-data-models.test.ts`（`describe('下钻三键 + measures…')` 内追加）

**Interfaces:**
- Produces: `detail` 闭集 `{relation, filter, columns}`；`columns[].{col, grantedBy}` 形状判据。Task 6 的 YAML 必须过这条门。

- [ ] **Step 1: 写失败测试**（沿用 `drillCompliant()` / `variant` / `fixture` helper）

```ts
  /** 把 flow 形态的 detail 换成带条件列的 block 形态（同一份零违规夹具的单点变异）。 */
  const withColumns = (yamlLines: string[]): Record<string, string> => {
    const files = drillCompliant()
    files[METRICS] = files[METRICS].replace(
      `    detail: { relation: vw_t, filter: "state = 'FINISHED'" }`,
      ['    detail:', '      relation: vw_t', `      filter: "state = 'FINISHED'"`, ...yamlLines].join('\n'),
    )
    return files
  }

  it('detail.columns 合法条件列 ⇒ 零违规', () => {
    const files = withColumns(['      columns:', '        - { col: order_detail_std_price, grantedBy: data:cost }'])
    expect(checkDataModels(fixture(files))).toEqual([])
  })

  it('detail.columns：蛇形键名写错（granted_by）⇒ 拒（静默不生效是这里最怕的形态）', () => {
    const files = withColumns(['      columns:', '        - { col: order_detail_std_price, granted_by: data:cost }'])
    const vs = checkDataModels(fixture(files))
    expect(vs.some((v) => /未知键/.test(v.message) && /granted_by/.test(v.message))).toBe(true)
  })

  it('detail.columns：col 与 dimensions 重叠 / 叫 value / 重复 / 空数组 ⇒ 各自拒', () => {
    const inDims = withColumns(['      columns:', '        - { col: system_book, grantedBy: data:cost }'])
    expect(checkDataModels(fixture(inDims)).some((v) => /dimensions/.test(v.message))).toBe(true)

    const asValue = withColumns(['      columns:', '        - { col: value, grantedBy: data:cost }'])
    expect(checkDataModels(fixture(asValue)).some((v) => /value/.test(v.message))).toBe(true)

    const dup = withColumns([
      '      columns:',
      '        - { col: order_detail_std_price, grantedBy: data:cost }',
      '        - { col: order_detail_std_price, grantedBy: data:cost }',
    ])
    expect(checkDataModels(fixture(dup)).some((v) => /重复/.test(v.message))).toBe(true)

    const empty = withColumns(['      columns: []'])
    expect(checkDataModels(fixture(empty)).some((v) => /非空数组/.test(v.message))).toBe(true)
  })

  it('detail：未知键（如 colums 拼错）⇒ 拒', () => {
    const files = withColumns(['      colums:', '        - { col: order_detail_std_price, grantedBy: data:cost }'])
    const vs = checkDataModels(fixture(files))
    expect(vs.some((v) => /未知键/.test(v.message))).toBe(true)
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run scripts/check-data-models.test.ts -t 'detail.columns'`
Expected: FAIL（门禁当前不认识 `columns`：前两格零违规=假绿，变异格无违规）。

- [ ] **Step 3: 实现**（`detail.filter` 检查之后追加）

```js
      // ⑤-x2 条件列（spec 2026-10-22 §2.3）：`detail` 是键**闭集**，`columns` 每项 `{col, grantedBy}`。
      //   为什么要闭集：拼错的键名（`granted_by` / `colums`）会被静默忽略——声明写了但不生效，
      //   正是本仓最怕的失败形态；门禁期红掉它，不等到「某列对所有人都不出现」才发现。
      if (detail !== undefined && detail !== null && typeof detail === 'object') {
        const D = /** @type {Record<string, unknown>} */ (detail)
        for (const k of Object.keys(D)) {
          if (k !== 'relation' && k !== 'filter' && k !== 'columns') {
            push(metric.file, 0, `指标 \`${metric.name}\` 的 detail 有未知键 \`${k}\` —— detail 是闭集 {relation, filter, columns}；拼错的键名会被**静默忽略**（写着但不生效）。`)
          }
        }
        if (D.columns !== undefined) {
          const cols = D.columns
          const dimsOfMetric = Array.isArray(metric.fields?.dimensions)
            ? metric.fields.dimensions.map(String) : []
          if (!Array.isArray(cols) || cols.length === 0) {
            push(metric.file, 0, `指标 \`${metric.name}\` 的 detail.columns 必须是**非空**数组（每项 {col, grantedBy}）；不需要条件列就别写这个键。`)
          } else {
            const seen = new Set()
            for (const item of cols) {
              if (item === null || typeof item !== 'object' || Array.isArray(item)) {
                push(metric.file, 0, `指标 \`${metric.name}\` 的 detail.columns 里有非对象项 ${JSON.stringify(item)} —— 每项必须是 {col, grantedBy}。`)
                continue
              }
              const it = /** @type {Record<string, unknown>} */ (item)
              for (const k of Object.keys(it)) {
                if (k !== 'col' && k !== 'grantedBy') {
                  push(metric.file, 0, `指标 \`${metric.name}\` 的 detail.columns 项有未知键 \`${k}\`（只许 col / grantedBy；大小写敏感）。`)
                }
              }
              const col = typeof it.col === 'string' ? it.col : ''
              if (!/^[a-z_][a-z0-9_]*$/.test(col)) {
                push(metric.file, 0, `指标 \`${metric.name}\` 的 detail.columns[].col ${JSON.stringify(it.col)} 必须是蛇形列名。`)
              } else if (col === 'value') {
                push(metric.file, 0, `指标 \`${metric.name}\` 的 detail.columns 不许用 \`value\` —— 它是回包值列的固定别名（spec 2026-10-21 §2.4）。`)
              } else if (dimsOfMetric.includes(col)) {
                push(metric.file, 0, `指标 \`${metric.name}\` 的 detail.columns 列 \`${col}\` 同时出现在 dimensions 里 —— 维度本来就无条件返回，再声明条件列会让同名列有两条来源。`)
              } else if (seen.has(col)) {
                push(metric.file, 0, `指标 \`${metric.name}\` 的 detail.columns 列 \`${col}\` 重复声明。`)
              }
              seen.add(col)
              const g = it.grantedBy
              if (typeof g !== 'string' || g.trim() === '') {
                push(metric.file, 0, `指标 \`${metric.name}\` 的 detail.columns[].grantedBy 必须是非空权限码字符串（方向同 mask.grantedBy：持有 ⇒ 看原值）。`)
              }
            }
          }
        }
      }
```

- [ ] **Step 4: 跑测试 + 真仓门禁**

```bash
pnpm exec vitest run scripts/check-data-models.test.ts
pnpm exec tsx scripts/check-data-models.mjs   # 真仓此刻仍零违规（YAML 还没改）
```

- [ ] **Step 5: Commit**

```bash
git add scripts/check-data-models.mjs scripts/check-data-models.test.ts
git commit -m "feat(data): check-data-models 收 detail 键闭集与 detail.columns 形状"
```

---

### Task 3: 门禁——血缘单调门规则 ⑤（条件列的授权码必须真实存在）

**Files:**
- Modify: `scripts/check-column-scope-monotonicity.mjs`（`for (const m of metrics)` 循环内，规则 ① 之后）
- Modify: 文件头注的「判据（写死，别扩）」清单（加第 ⑤ 条）
- Test: `scripts/check-column-scope-monotonicity.test.ts`

**Interfaces:**
- Consumes: `loadManifestCodes(rootDir)`（已有）、`fixture({ metricLines })`（已有）。
- Produces: 规则 ⑤ —— `detail.columns[].grantedBy ∈ permissions[].code`。Task 6 的 `data:cost` 必须过这条。

- [ ] **Step 1: 写失败测试**（`describe('血缘单调门：判据')` 内追加）

```ts
  it('⑤ detail.columns[].grantedBy 不在 manifest ⇒ 违规（码发不出去 ⇒ 该列对所有人静默缺席）', () => {
    const v = checkColumnScopeMonotonicity(fixture({
      metricLines: [
        '    detail:',
        '      relation: vw_lemeng_retail_order_line',
        '      filter: "state = \'FINISHED\'"',
        '      columns:',
        '        - { col: order_detail_std_price, grantedBy: data:ghost }',
      ],
    }))
    // 只挑「命中 data:ghost 的那条」断言——不钉总条数（别的判据的条数会随夹具演进漂）
    const hit = v.filter((x) => x.message.includes('data:ghost'))
    expect(hit).toHaveLength(1)
    expect(hit[0]?.message).toContain('gross_rate')
    expect(hit[0]?.message).not.toContain('required_scope')   // 认哪一条（别让别的分支兜住）
  })

  it('⑤ detail.columns[].grantedBy 在 manifest（data:cost）⇒ 不违规', () => {
    expect(checkColumnScopeMonotonicity(fixture({
      metricLines: [
        '    detail:',
        '      relation: vw_lemeng_retail_order_line',
        '      filter: "state = \'FINISHED\'"',
        '      columns:',
        '        - { col: order_detail_std_price, grantedBy: data:cost }',
      ],
    }))).toEqual([])
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec vitest run scripts/check-column-scope-monotonicity.test.ts -t '⑤'`
Expected: 第一条 FAIL（`[]`，长度 0）。

- [ ] **Step 3: 实现**

文件头注的判据清单（`④ 指标 required_scope …` 之后）加：

```
//     ⑤ 指标 `detail.columns[].grantedBy` 必须 ∈ manifest `permissions[].code`——同 ①：
//        码发不出去 ⇒ 该列对**所有人**静默缺席（fail-closed 方向，但功能等于白声明）。
```

主循环内、规则 ① 的 `if (Array.isArray(m?.mask)) { … }` 之后加：

```js
    // ⑤ 条件列（下钻 spec 2026-10-22 §2.3）的授权码必须真实存在。
    //    与 ① 同因：装载器按各租户 org 逐个 upsert，没在 manifest 声明就发不出去 ⇒
    //    `hasScope(c.grantedBy)` 恒 false ⇒ 该列对**所有人**静默缺席（功能白声明，且没人报错）。
    //    形状问题归 check-data-models（这里只判「码存不存在」）。
    if (Array.isArray(m?.detail?.columns)) {
      for (const item of m.detail.columns) {
        const g = item?.grantedBy
        if (typeof g !== 'string' || g === '') continue
        if (!codes.has(g)) {
          violations.push({
            file: L1_DECLARATIONS_REL,
            message: `指标 \`${name}\` 的 \`detail.columns\` 声明了授权码 \`${g}\`，但 ${DATA_MANIFEST_REL} 的`
              + ' `permissions[]` 里没有它 —— 码发不出去 ⇒ 该列对**所有人**静默缺席'
              + '（fail-closed，但声明等于白写）。修法：在 manifest 里声明该码，或改掉 `grantedBy`。',
          })
        }
      }
    }
```

- [ ] **Step 4: 跑测试 + 真仓**

```bash
pnpm exec vitest run scripts/check-column-scope-monotonicity.test.ts
pnpm exec tsx scripts/check-column-scope-monotonicity.mjs
```

- [ ] **Step 5: Commit**

```bash
git add scripts/check-column-scope-monotonicity.mjs scripts/check-column-scope-monotonicity.test.ts
git commit -m "feat(data): 血缘单调门加规则⑤——条件列的授权码必须真实存在"
```

---

### Task 4: sync 编译——`detail.columns` 物化 + `--check` 比对面

**Files:**
- Modify: `scripts/sync-data-semantics.mjs`
  - `ComparableMetric` typedef 的 `drillDetail` 说明（约 137-138 行）
  - `declarationsFromYaml` 的 `drillDetail:` 表达式（约 746-753 行）→ 调 `drillDetailOf`
  - 新增导出 `drillDetailOf` / `detailColumnsOf`（放在 `drillOf` 附近，约 815 行前）
  - `drillOf` / `drillTripleOf` 透传 `columns`
- Test: `scripts/sync-data-semantics.test.ts`

**Interfaces:**
- Produces:
  - `drillDetailOf(detail, metricName, dims): { relation: string, filter: string, columns?: DrillColumn[] } | null`
  - `detailColumnsOf(v, metricName, dims): DrillColumn[] | null`（`null` = 未声明；坏形状**抛**）
  - `drillOf(row)` 返回的 `DrillBinding` 带 `columns`；`drillTripleOf(row)` 的 `drillDetail` 带 `columns`
- **关键坑**：`drillDetail` 在 `comparableOf` 的 16 元组里。库侧 `drillTripleOf` 若不透传 `columns` ⇒ 声明侧有、库侧无 ⇒ `--check` **恒报更新**（漂移信号作废）。

- [ ] **Step 1: 写失败测试**（`describe('declarationsFromYaml：下钻编译…')` 内追加）

```ts
  it('detail.columns：物化进 drillDetail；未声明时**不写键**（不是空数组）', () => {
    const cols = [{ col: 'order_detail_std_price', grantedBy: 'data:cost' }]
    const withCols = declarationsFromYaml({
      metrics: [{ ...base, compose: 'a@b', dimensions: dims, detail: { ...detail, columns: cols } }],
      measures: { 'a@b': 'sum(x)' },
    })
    expect(withCols[0].drillDetail).toEqual({
      relation: 'vw_lemeng_retail_order_line', filter: "state = 'FINISHED'", columns: cols,
    })

    const without = declarationsFromYaml({
      metrics: [{ ...base, compose: 'a@b', dimensions: dims, detail }],
      measures: { 'a@b': 'sum(x)' },
    })
    expect(without[0].drillDetail).toEqual({ relation: 'vw_lemeng_retail_order_line', filter: "state = 'FINISHED'" })
  })

  it('detail.columns 形状坏 ⇒ 响亮失败（sync 手跑路径，不静默物化坏权限声明）', () => {
    const mk = (columns: unknown) => () => declarationsFromYaml({
      metrics: [{ ...base, compose: 'a@b', dimensions: dims, detail: { ...detail, columns } }],
      measures: { 'a@b': 'sum(x)' },
    })
    expect(mk([])).toThrow(/非空数组/)
    expect(mk([{ col: 'order_detail_std_price', granted_by: 'data:cost' }])).toThrow(/未知键/)
    expect(mk([{ col: 'system_book', grantedBy: 'data:cost' }])).toThrow(/dimensions/)
    expect(mk([{ col: 'value', grantedBy: 'data:cost' }])).toThrow(/value/)
    expect(mk([{ col: 'x_price', grantedBy: '' }])).toThrow(/grantedBy/)
    expect(mk([{ col: 'x_price', grantedBy: 'data:cost' }, { col: 'x_price', grantedBy: 'data:cost' }])).toThrow(/重复/)
  })

  it('drillOf / drillTripleOf 透传 columns（库侧不透传 ⇒ --check 恒报更新）', () => {
    const cols = [{ col: 'order_detail_std_price', grantedBy: 'data:cost' }]
    const detailWithCols = { relation: 'vw_x', filter: 'true', columns: cols }
    expect(drillOf({
      id: 'a', title: 'A', description: '', requiredScope: null, subjectColumn: 'org',
      selectSql: 'select sum(t.c) as value from t', groupBy: 'g', params: {}, sourceSystem: 'lemeng',
      totalable: false, slaDays: 1, freshnessRelations: [], masks: null,
      drillExpr: '(sum(x))', drillDims: ['system_book'], drillDetail: detailWithCols,
    })?.columns).toEqual(cols)

    expect(drillTripleOf({ drill: { expr: '(sum(x))', dims: ['system_book'], relation: 'vw_x', filter: 'true', columns: cols } }))
      .toEqual({ drillExpr: '(sum(x))', drillDims: ['system_book'], drillDetail: detailWithCols })

    // 反向对照：未声明 ⇒ 两侧都不写键（否则恒不等）
    expect(drillTripleOf({ drill: { expr: '(sum(x))', dims: ['s'], relation: 'vw_x', filter: 'true' } }).drillDetail)
      .toEqual({ relation: 'vw_x', filter: 'true' })
  })
```

- [ ] **Step 2: 跑测试确认失败**：`pnpm exec vitest run scripts/sync-data-semantics.test.ts -t 'detail.columns'` → FAIL。

- [ ] **Step 3: 实现**

`drillOf` 之前插入（两个新导出 + 复用判据）：

```js
/**
 * 声明 `detail.columns` → 物化形态（spec 2026-10-22 §2.3）。
 *
 * 为什么在 sync 侧**抛而不是落 null**：本脚本会被手跑（不经 CI）。门禁（check-data-models）
 * 是 CI 权威，这里兜的是「手跑时把坏权限声明物化进库」——一份读不懂的条件列声明，
 * 最坏形态是某列对所有人消失或对不该看的人出现，宁响亮勿静默。
 *
 * @param {unknown} v 声明里的 `detail.columns` 原值
 * @param {string} metricName 指标名（只用于错误信息）
 * @param {unknown} dims 声明的 `dimensions` 原值（只用于「不许与维度重叠」判据；形状坏时跳过）
 * @returns {Array<{ col: string, grantedBy: string }> | null} null = 未声明
 */
export function detailColumnsOf(v, metricName, dims) {
  if (v === undefined || v === null) return null
  if (!Array.isArray(v) || v.length === 0) {
    throw new Error(`指标 \`${metricName}\` 的 \`detail.columns\` 必须是非空数组（每项 {col, grantedBy}）`)
  }
  const dimsList = Array.isArray(dims) ? dims.map(String) : []
  /** @type {Array<{ col: string, grantedBy: string }>} */
  const out = []
  const seen = new Set()
  for (const raw of v) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`指标 \`${metricName}\` 的 \`detail.columns\` 里有非对象项 ${JSON.stringify(raw)}`)
    }
    const it = /** @type {Record<string, unknown>} */ (raw)
    for (const k of Object.keys(it)) {
      if (k !== 'col' && k !== 'grantedBy') {
        throw new Error(`指标 \`${metricName}\` 的 \`detail.columns\` 项有未知键 \`${k}\`（只许 col / grantedBy）`)
      }
    }
    const col = typeof it.col === 'string' ? it.col : ''
    if (!/^[a-z_][a-z0-9_]*$/.test(col)) {
      throw new Error(`指标 \`${metricName}\` 的 \`detail.columns[].col\` ${JSON.stringify(it.col)} 必须是蛇形列名`)
    }
    if (col === 'value') {
      throw new Error(`指标 \`${metricName}\` 的 \`detail.columns\` 不许用 \`value\`（回包值列的固定别名）`)
    }
    if (dimsList.includes(col)) {
      throw new Error(`指标 \`${metricName}\` 的 \`detail.columns\` 列 \`${col}\` 同时出现在 dimensions 里`)
    }
    if (seen.has(col)) {
      throw new Error(`指标 \`${metricName}\` 的 \`detail.columns\` 列 \`${col}\` 重复声明`)
    }
    seen.add(col)
    const grantedBy = typeof it.grantedBy === 'string' ? it.grantedBy.trim() : ''
    if (grantedBy === '') {
      throw new Error(`指标 \`${metricName}\` 的 \`detail.columns[].grantedBy\` 必须是非空权限码字符串`)
    }
    out.push({ col, grantedBy })
  }
  return out
}

/**
 * 声明 `detail` → 物化形态（三键之一；`columns` 缺省**不写键**）。
 *
 * @param {unknown} detail 声明里的 `detail` 原值（undefined = 未声明）
 * @param {string} metricName 指标名（只用于错误信息）
 * @param {unknown} dims 声明的 `dimensions` 原值
 * @returns {{ relation: string, filter: string, columns?: Array<{ col: string, grantedBy: string }> } | null}
 */
export function drillDetailOf(detail, metricName, dims) {
  if (detail === undefined) return null
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return null
  const d = /** @type {Record<string, unknown>} */ (detail)
  if (typeof d.relation !== 'string' || typeof d.filter !== 'string') return null
  for (const k of Object.keys(d)) {
    if (k !== 'relation' && k !== 'filter' && k !== 'columns') {
      throw new Error(`指标 \`${metricName}\` 的 \`detail\` 有未知键 \`${k}\`（闭集 {relation, filter, columns}）`)
    }
  }
  const columns = detailColumnsOf(d.columns, metricName, dims)
  return columns === null
    ? { relation: d.relation, filter: d.filter }
    : { relation: d.relation, filter: d.filter, columns }
}
```

`declarationsFromYaml` 的 `drillDetail:` 三元表达式整段替换为：

```js
      drillDetail: drillDetailOf(m.detail, name, m.dimensions),
```

`drillOf` 的 return 改为：

```js
  return {
    expr, dims, relation: detail.relation, filter: detail.filter,
    ...(detail.columns === undefined ? {} : { columns: detail.columns }),
  }
```

`drillTripleOf` 的 return 改为：

```js
  const detail = d.columns === undefined
    ? { relation: d.relation, filter: d.filter }
    : { relation: d.relation, filter: d.filter, columns: d.columns.map((c) => ({ col: c.col, grantedBy: c.grantedBy })) }
  return { drillExpr: d.expr, drillDims: [...d.dims], drillDetail: detail }
```

`ComparableMetric` typedef 的 `drillDetail` 行改为：

```js
 * @property {{ relation: string, filter: string, columns?: Array<{ col: string, grantedBy: string }> } | null} drillDetail
 *                  下钻明细关系、行域过滤与条件列（声明 `detail` 的物化值；null = 未声明。
 *                  `columns` 缺省**不写键**——库侧 `drillTripleOf` 必须同形，否则 --check 恒报更新）
```

- [ ] **Step 4: 跑测试 + 类型**

```bash
pnpm exec vitest run scripts/sync-data-semantics.test.ts
pnpm run typecheck:scripts
pnpm exec tsx scripts/sync-data-semantics.mjs --check   # 真仓此刻应仍「无漂移」（YAML 未改）
```

- [ ] **Step 5: Commit**

```bash
git add scripts/sync-data-semantics.mjs scripts/sync-data-semantics.test.ts
git commit -m "feat(data): sync 物化 detail.columns 并接进 --check 比对面"
```

---

### Task 5: 执行面——条件列投影 + 审计 `grantedColumns`

**Files:**
- Modify: `modules/data/domain/drill.ts`（`rollupOver` 53-56、`buildDrillSql` 60-70、门序 119-154、投影 172、上卷 184-187、审计 76-85 / 236-238）
- Modify: `modules/data/domain/audit-store.ts:40`
- Test: `modules/data/domain/drill.test.ts`

**Interfaces:**
- Consumes: `DrillBinding.columns?: DrillColumn[]`（Task 1）。
- Produces:
  - `buildDrillSql(drill, requested, where, orderBy, desc, limit, offset, columns?: readonly DrillColumn[])`
  - 审计 `drill` 面形状 `{ dimensions, rowCountTotal, grantedColumns: string[] }`（**恒有第三个键**，空数组 = 未展示）

- [ ] **Step 1: 写失败测试**（`drill.test.ts` 追加）

```ts
/** 声明了条件列的指标行（drill_detail 多一个 columns 键——与 sync 物化形状一致）。 */
const COLUMN_ROW: Record<string, unknown> = {
  ...METRIC_ROW,
  id: 'drill:cols',
  drill_detail: { ...(METRIC_ROW.drill_detail as Record<string, unknown>), columns: [{ col: 'order_detail_std_price', grantedBy: 'data:cost' }] },
}
const COST = { scopes: ['data:query', 'data:cost'] }

describe('条件列（spec 2026-10-22 §2.3）', () => {
  it('无 data:cost ⇒ 投影里没有该列（缺席，不是 NULL），审计 grantedColumns=[]', async () => {
    const { pool, audits } = fakePool([COLUMN_ROW])
    const sqls: string[] = []
    const out = await runDetailQuery(depsOf(pool, sqls), ORG, req(), 'drill:cols', ARGS, {})
    expect(out.status).toBe('ok')
    expect(sqls[0]).not.toContain('order_detail_std_price')   // 不投影、不 cast(null)
    expect(sqls[0]).not.toContain('max(')
    expect(JSON.parse(audits[0].params[AUDIT_DRILL] as string))
      .toEqual({ dimensions: DRILL.dims, rowCountTotal: 15222, grantedColumns: [] })
  })

  it('有 data:cost ⇒ 内层与外层各一次 max(col) as col（值在 value 之后）', async () => {
    const { pool, audits } = fakePool([COLUMN_ROW])
    const sqls: string[] = []
    const out = await runDetailQuery(depsOf(pool, sqls), ORG, req(COST), 'drill:cols', ARGS, {})
    expect(out.status).toBe('ok')
    // 整串钉（只断言子串会放过「内层漏 max ⇒ 42803」这类编译错）
    expect(sqls[0]).toBe(
      "select system_book, bizday, branch_num, order_no, sum(value) as value, max(order_detail_std_price) as order_detail_std_price from ( select ((sale_amount@order - return_amount@line)) as value, system_book, bizday, branch_num, order_no, max(order_detail_std_price) as order_detail_std_price from vw_t where org = 'org_a' AND state = 'FINISHED' AND bizday BETWEEN '2026-10-19'::date AND '2026-10-20'::date group by system_book, bizday, branch_num, order_no ) t group by system_book, bizday, branch_num, order_no order by value desc limit 50 offset 0")
    expect(JSON.parse(audits[0].params[AUDIT_DRILL] as string))
      .toEqual({ dimensions: DRILL.dims, rowCountTotal: 15222, grantedColumns: ['order_detail_std_price'] })
  })

  it('子集上卷：条件列两层都在，外层 group by 只按请求维度', async () => {
    const { pool } = fakePool([COLUMN_ROW])
    const sqls: string[] = []
    await runDetailQuery(depsOf(pool, sqls), ORG, req(COST), 'drill:cols', ARGS, { dimensions: ['system_book', 'bizday'] })
    expect(sqls[0]).toBe(
      "select system_book, bizday, sum(value) as value, max(order_detail_std_price) as order_detail_std_price from ( select ((sale_amount@order - return_amount@line)) as value, system_book, bizday, max(order_detail_std_price) as order_detail_std_price from vw_t where org = 'org_a' AND state = 'FINISHED' AND bizday BETWEEN '2026-10-19'::date AND '2026-10-20'::date group by system_book, bizday, branch_num, order_no ) t group by system_book, bizday order by value desc limit 50 offset 0")
  })

  it('条件列不可作为维度请求、也不可 orderBy（它不是维度）', async () => {
    const { pool } = fakePool([COLUMN_ROW])
    const asDim = await runDetailQuery(depsOf(pool, []), ORG, req(COST), 'drill:cols', ARGS, { dimensions: ['order_detail_std_price'] })
    expect(asDim).toEqual({ status: 'denied', metricId: 'drill:cols', reason: 'bad_param', detail: 'unknown_dimension:order_detail_std_price' })
    const asOrder = await runDetailQuery(depsOf(pool, []), ORG, req(COST), 'drill:cols', ARGS, { orderBy: 'order_detail_std_price' })
    expect(asOrder).toEqual({ status: 'denied', metricId: 'drill:cols', reason: 'bad_param', detail: 'unknown_orderby:order_detail_std_price' })
  })

  it('整值掩码 + 条件列：value 头被 null 化，条件列照常投影（掩码只改内层 value 头）', async () => {
    const MASKED_COL_ROW: Record<string, unknown> = {
      ...COLUMN_ROW, id: 'drill:cols_masked',
      mask_spec: [{ column: null, kind: 'nullify', grantedBy: 'data:precise' }],
    }
    const { pool } = fakePool([MASKED_COL_ROW])
    const sqls: string[] = []
    await runDetailQuery(depsOf(pool, sqls), ORG, req(COST), 'drill:cols_masked', ARGS, {})
    expect(sqls[0]).toContain('cast(null as numeric) as value, system_book')
    expect(sqls[0]).toContain('max(order_detail_std_price) as order_detail_std_price')
  })
})

describe('buildDrillSql 条件列（纯函数）', () => {
  it('无 columns ⇒ 与 Phase 1 的 SQL 逐字一致（回归：默认参数不许改形状）', () => {
    const p = buildDrillSql(DRILL, DRILL.dims, "org = 'o' AND state = 'FINISHED'", 'value', true, 50, 0)
    expect(p.sql).toBe("select system_book, bizday, branch_num, order_no, sum(value) as value from ( select system_book, bizday, branch_num, order_no, ((sale_amount@order - return_amount@line)) as value from vw_t where org = 'o' AND state = 'FINISHED' group by system_book, bizday, branch_num, order_no ) t group by system_book, bizday, branch_num, order_no order by value desc limit 50 offset 0")
  })

  it('给了 columns ⇒ 内外层都追加 max(col) as col', () => {
    const p = buildDrillSql(DRILL, DRILL.dims, 'w', 'value', true, 50, 0,
      [{ col: 'order_detail_std_price', grantedBy: 'data:cost' }])
    expect(p.sql).toContain(', max(order_detail_std_price) as order_detail_std_price from vw_t')
    expect(p.sql).toContain('sum(value) as value, max(order_detail_std_price) as order_detail_std_price from (')
  })
})
```

同时**改既有的 ok 路径断言**（`drill.test.ts:206`）：

```ts
    expect(JSON.parse(audits[0].params[AUDIT_DRILL] as string)).toEqual({ dimensions: DRILL.dims, rowCountTotal: 15222, grantedColumns: [] })
```

- [ ] **Step 2: 跑测试确认失败**：`pnpm --filter data test -- drill.test.ts` → 新增用例 FAIL（SQL 里没有 `max(`、审计没有 `grantedColumns`）。

- [ ] **Step 3: 实现**

`drill.ts` 顶部 import 加 `DrillColumn`：

```ts
import type { DrillBinding, DrillColumn, Requester } from './authz'
```

`rollupOver` 增尾参（**外层形状仍只有一份**）：

```ts
function rollupOver(inner: string, dims: string[], orderBy: string, desc: boolean, limit: number, offset: number, extra = ''): string {
  const d = dims.join(', ')
  return `select ${d}, sum(value) as value${extra} from ( ${inner} ) t group by ${d} order by ${orderBy} ${desc ? 'desc' : 'asc'} limit ${limit} offset ${offset}`
}
```

新增投影助手（放在 `rollupOver` 之前）：

```ts
/** 条件列投影（spec 2026-10-22 §2.3）：`max(<col>) as <col>`，内层与外层同形。
 * 为什么用 max 而不是裸列：外层 group by 通常比原子粒度粗，裸列会 42803（不在 GROUP BY 里）。
 * 原子粒度（缺省请求）下组内恒一行 ⇒ max = 该行原值；粗粒度下是「组内某一行的值」，
 * **不是聚合语义**（spec §5 已知边界）。 */
function columnProjection(columns: readonly DrillColumn[]): string {
  return columns.length === 0 ? '' : `, ${columns.map((c) => `max(${c.col}) as ${c.col}`).join(', ')}`
}
```

`buildDrillSql` 增尾参并用它：

```ts
export function buildDrillSql(
  drill: DrillBinding, requested: string[], where: string,
  orderBy: string, desc: boolean, limit: number, offset: number,
  columns: readonly DrillColumn[] = [],
): DrillPlan {
  const atomic = drill.dims.join(', ')
  const extra = columnProjection(columns)
  const inner =
    `select ${atomic}, (${drill.expr}) as value${extra} from ${drill.relation} where ${where} group by ${atomic}`
  const sql = rollupOver(inner, requested, orderBy, desc, limit, offset, extra)
  const rowCountSql = `select count(*) as n from ${drill.relation} where ${where}`
  return { sql, rowCountSql, dimensions: requested }
}
```

`runDetailQuery` 里：
1. 审计局部函数的 `drillFacet` 类型改：

```ts
    drillFacet: { dimensions: string[]; rowCountTotal: number; grantedColumns: string[] } | null,
```

2. **门序**：维度校验的 `requested = [...dims]` 块之后、`const orderBy = …` 之前插入
   （此处 `requester` 已在函数前段的 `if (!requester) { … unauthenticated … }` 收窄成非空，可直接点属性）：

```ts
  // 条件列（spec 2026-10-22 §2.3）：持 `grantedBy` 才投影；无码 ⇒ 该列**不在场**（缺席，不是 NULL）。
  // 放在维度校验之后、orderBy 之前——它只影响投影，不参与权限拒绝链（拒绝链全在 authorize）。
  const granted = (drill.columns ?? []).filter((c) => requester.hasScope(c.grantedBy))
  const extra = columnProjection(granted)
```

3. `const plan = buildDrillSql(...)` 传 `granted`：

```ts
  const plan = buildDrillSql(drill, requested, where, orderBy, desc, limit, offset, granted)
```

4. 内层投影串加 `${extra}`（value-first 形状不变，条件列在维度之后）：

```ts
  const projection = `select (${drill.expr}) as value, ${requested.join(', ')}${extra} from ${drill.relation}`
```

5. 外层上卷传 `extra`：

```ts
  const sql = rollupOver(
    `${masked.sql} where ${where} group by ${drill.dims.join(', ')}`,
    requested, orderBy, desc, limit, offset, extra,
  )
```

6. ok 审计加 `grantedColumns`：

```ts
  await audit('ok', retried ? 'lake_race_retry' : null, result.rows.length,
    maskingAuditOf(masked.applied, masked.exempted),
    { dimensions: requested, rowCountTotal, grantedColumns: granted.map((c) => c.col) })
```

`audit-store.ts:40` 改：

```ts
  /** 下钻面（spec 2026-10-21 §2.5 / 2026-10-22 §2.3）：粒度、总数与**本次实际展示的条件列**。
   *  `grantedColumns` 恒在场（空数组 = 未展示）——审计要能回答「哪次查询把价格列给出去了」。
   *  聚合审计为 null。 */
  drill?: { dimensions: string[]; rowCountTotal: number; grantedColumns: string[] } | null
```

- [ ] **Step 4: 跑测试 + 类型**

```bash
pnpm --filter data test -- drill.test.ts
pnpm --filter data typecheck
```

Expected: 全绿（含既有的掩码/竞态/门序用例——它们证明**没加条件列时行为一字未变**）。

- [ ] **Step 5: Commit**

```bash
git add modules/data/domain/drill.ts modules/data/domain/audit-store.ts modules/data/domain/drill.test.ts
git commit -m "feat(data): 下钻条件列投影（data:cost 门控）+ 审计记 grantedColumns"
```

---

### Task 6: 声明面迁移——`line_amount@line` + `order_line` 八列闭集 + 条件列

**Files:**
- Modify: `dbt/semantics/l1_metrics.yml`（`measures:` 段加一个组件；`order_line` 整块替换，约 950-1000 行）
- Modify: `dbt/README.md:176-177`（`detail` 键闭集描述）
- Modify: `deploy/data-plane.lock`（重生成）
- Test: `scripts/sync-data-semantics.test.ts`（真事实源用例）

**Interfaces:**
- Consumes: Task 2/3 的门禁（先于本任务）、Task 4 的 `drillDetailOf`。
- Produces: `data.metrics` 里 `lemeng:retail:order_line` 行的 `drill_expr/drill_dims/drill_detail`（含 `columns`）。

- [ ] **Step 1: 写失败测试**（`sync-data-semantics.test.ts` 的真事实源 describe 内追加）

```ts
  it('★ 真事实源：order_line 的下钻绑定（8 列闭集 + 条件列）', () => {
    const rows = readDeclarations(ROOT)
    const row = new Map(rows.map((r) => [r.id, r])).get('lemeng:retail:order_line')
    expect(row?.drillExpr).toBe('(sum(sale_money))')
    expect(row?.drillDims).toEqual([
      'system_book', 'bizday', 'branch_num', 'order_no',
      'order_detail_num', 'item_num', 'item_code', 'order_transaction_type',
    ])
    expect(row?.drillDetail).toEqual({
      relation: 'vw_lemeng_retail_order_line',
      filter: "state = 'FINISHED'",
      columns: [{ col: 'order_detail_std_price', grantedBy: 'data:cost' }],
    })
    // 聚合面表达式：FINISHED 内嵌 + 仍以 sum( 开头（可加判定）+ 仍带关系限定（deriveRelation）
    expect(row?.selectSql).toMatch(/^select sum\(case when stg_lemeng_retail_order_line\.state = 'FINISHED'/)
  })
```

- [ ] **Step 2: 跑测试确认失败**：`pnpm exec vitest run scripts/sync-data-semantics.test.ts -t 'order_line 的下钻绑定'` → FAIL（当前 `drillExpr` 为 null）。

- [ ] **Step 3: 改 YAML**

`measures:` 段末尾（`return_amount@line` 之后）追加：

```yaml
  # 行级原始金额度量（spec 2026-10-22 §2.2）：不承载口径——行域由指标侧钉
  # （聚合面 expression 的 CASE、下钻面 detail.filter），组件体只做行级求和。
  line_amount@line: >-
    sum(sale_money)
```

`order_line` 整块替换（从段首注释到 `sources:` 行）：

```yaml
  # ── 零售订单明细行（2026-10-21 建；2026-10-22 Phase 2 收口权限面）────────────────
  # 下钻绑定的**载体指标**：聚合面答「合计/分布」，下钻面（query_detail）答「多少行 / 哪几行造成的」。
  # 行数唯一权威 = 下钻回包的 rowCountTotal（不是聚合面的 1000 行截断）。
  # 行域统一 `state = 'FINISHED'`（**含退货行**；REPAID / CANCELED 不在）：非 FINISHED 行在聚合面贡献 0；
  #   分组集**不统一**（聚合面可能出现「某店日全为作废行 ⇒ 零值组」，下钻面同一店日是 0 行）。
  #   聚合面把谓词内嵌进 expression（聚合面没有 detail.filter 可用），下钻面写在 detail.filter；
  #   两处**声明**漂移由 scripts/sync-data-semantics.test.ts 的真事实源用例钉死；assert_drill_order_line_matches_metric.sql
  #   守的是**行域数据同量**（vw-FINISHED vs stg-CASE-FINISHED），它读不到声明。
  # 粒度 = 8 列原子行键闭集（业务键 distinct = 总行数，2026-10-21 真机核实；batch_id 不拆行）。
  # 价格列是**条件列**（detail.columns，grantedBy: data:cost）：无码 ⇒ 列**不在场**（缺席，不是 NULL）。
  #   它**不是**值级掩码——该列在 sale_amount@order 的赠品判别式内部，nullify 会让判别式变 NULL、
  #   污染聚合值（Phase 1 spec §7 订正 2 的算术仍成立）。
  # ⚠️ 契约层**未**打 sensitivity（spec 2026-10-22 §3.2）：打标会激活默认档**整值** nullify，
  #    把 sale_money 一起藏掉。列级暴露的机器声明缺口归 #780 后续，别在这里补假声明。
  # ⚠️ 若将来有人给本列加值级 `mask`（按列），两个方向都**不是**响亮失败（`mask.ts` 的按列替换
  #    跳过 `as ` 后的别名位，issue #824）：① 声明用**裸列名** ⇒ 投影变成
  #    `max(cast(null as numeric)) as <col>`——合法 SQL、列**在场但整列 NULL**（静默；审计仍记该列）；
  #    ② 声明用**限定列名** ⇒ 本投影是不限定列名，掩码正则一个都不命中 ⇒ **掩码不生效（fail-open）**。
  #    结论：给本列打列级掩码前**必须先裁决**「掩码生效 ⇒ 整列缺席（推荐）vs 列在场全 NULL」，
  #    缺口归 #995；别指望它自己报错。
  - name: 'lemeng:retail:order_line'
    label: 零售订单明细行
    definition: >-
      乐檬零售订单明细的**行级**读面（一行 = 一个订单明细行）。
      用途是**定位根因**：聚合指标答「是多少」，本指标答「哪几行造成的」。
      **行数的唯一权威 = query_detail 回包的 rowCountTotal**（不受 limit/分组影响）；
      聚合面（query_data）仍受 1000 行截断，**不要**拿它数行。
      行域 = state='FINISHED' 的全部行（**含退货行**；已退款 REPAID / 作废 CANCELED 不在）。
      维度闭集（8 列）= 账套 × 业务日 × 门店 × 订单号 × 明细行号 × 商品 × 交易类型。
      ⚠️ item_code 契约明文**恒为空串**（上游订单 API 无此字段），别当成有效商品码。
      ⚠️ 价格列 order_detail_std_price 需 `data:cost` 授权——**未授权时该列不在回包里**
      （是「无权限看这一列」，不是「这行没值」，也不是「没有数据」）。
      ⚠️ 本指标**不承载口径**（销售/退货判别式、赠品排除全在 fct_* 那族）；
      拿它对账前先读 lemeng:retail:net_sales 的 definition。
      前置核实（2026-10-21 真机）：业务键（账套×日×单号×行号）distinct = 总行数 ⇒ 无重复；
      加 batch_id 后仍无重复 ⇒ 85 个批次不拆行；hour 无空值。
    expression: >-
      sum(case when stg_lemeng_retail_order_line.state = 'FINISHED'
               then stg_lemeng_retail_order_line.sale_money else 0 end)
    grain: [system_book, bizday, branch_num, order_no, order_detail_num, item_num,
            item_code, order_transaction_type]
    owner: data-platform
    tier: experimental
    source: lemeng
    freshness_sla_days: 1
    sources:
      - 's3://<bucket>/lemeng/retail_order_line/system_book=<账套>/bizday=<日期>/hour=<时>/all.parquet'
    compose: 'line_amount@line'
    dimensions: [system_book, bizday, branch_num, order_no, order_detail_num, item_num,
                 item_code, order_transaction_type]
    detail:
      relation: vw_lemeng_retail_order_line
      filter: "state = 'FINISHED'"
      columns:
        - { col: order_detail_std_price, grantedBy: data:cost }
```

`dbt/README.md:176-177` 的 `detail` 描述改为：

```
`detail` = 键**闭集** `{relation, filter, columns}`：`relation` 必须合 `vw_*` 且
`dbt/models/**/views/<relation>.sql` 在仓（Phase 1 下钻只读直读湖视图），`filter` = 非空、
不含分号的布尔表达式；`columns`（选填）= **条件列**数组，每项 `{col, grantedBy}`
（`col` 蛇形、不与 `dimensions` 重叠、不许叫 `value`、不重复；`grantedBy` 必须是 manifest
里真实存在的权限码）——**持码才投影，无码 ⇒ 该列不在回包里**（缺席，不是 NULL；
spec 2026-10-22 §2.3）。条件列**不是**值级掩码，不进 `mask`。
```

- [ ] **Step 4: 重生成 lock + 跑全套门禁 / 测试**

```bash
pnpm exec tsx scripts/lemeng/data-plane-lock.mjs
pnpm exec tsx scripts/check-data-models.mjs
pnpm exec tsx scripts/check-column-scope-monotonicity.mjs
pnpm exec tsx scripts/check-data-plane-lock.mjs
pnpm exec vitest run scripts/sync-data-semantics.test.ts
pnpm exec tsx scripts/sync-data-semantics.mjs --check      # 本地库没刷 ⇒ 报「更新 1」是预期；
                                                          # 报「无漂移」也不代表线上已刷（本任务未连库）
```

Expected: 三条门禁全绿；sync 测试全绿。

- [ ] **Step 5: Commit**

```bash
git add dbt/semantics/l1_metrics.yml dbt/README.md deploy/data-plane.lock
git add scripts/sync-data-semantics.test.ts
git commit -m "feat(data): order_line 并入下钻声明面——FINISHED 行域 + 8 列闭集 + data:cost 条件列"
```

---

### Task 7: 对账——audit 改域 + 新不变量 `assert_drill_order_line_matches_metric`

**Files:**
- Modify: `dbt/tests/lemeng/audit_lemeng__retail__order_line.sql`
- Create: `dbt/tests/lemeng/assert_drill_order_line_matches_metric.sql`
- Modify: `deploy/data-plane.lock`（重生成）

**Interfaces:**
- Consumes: `vw_lemeng_retail_order_line`（Phase 1 已在仓）、`stg_lemeng_retail_order_line`、Task 6 的 expression。
- Produces: 一条 dbt singular test —— 守**数据面同量**（vw-FINISHED vs stg-CASE-FINISHED，按账套×业务日对齐）；**它读不到 YAML 声明**，两处声明漂移由 `scripts/sync-data-semantics.test.ts` 的真事实源用例钉死。

- [ ] **Step 1: 改 audit（行域收 FINISHED）**

冷腿 `where` 行改为：

```sql
    where r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
      and r['state']::varchar = 'FINISHED'
```

热腿 `where` 行改为：

```sql
    where r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
      and r['state']::varchar = 'FINISHED'
      and not exists (select 1 from read_parquet('s3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_order_line_prefix") }}/_DAILY/*.parquet') m where cast(m['system_book'] as varchar) = cast(r['system_book'] as varchar) and cast(m['bizday'] as date) = cast(r['bizday'] as date))
```

`materialized` CTE 的 `where` 改为：

```sql
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
      and state = 'FINISHED'
```

头注追加一段（**别让后人把「对账绿」读成「全部状态都已对账」**）：

```
-- ── 2026-10-22 Phase 2：行域收 FINISHED（与指标同域）────────────────────────────────
-- 指标 lemeng:retail:order_line 的两面行域都是 state='FINISHED'（聚合面内嵌进 expression、
-- 下钻面写在 detail.filter）⇒ 本对账也只看 FINISHED 行，才是「与受测面同量对比」。
-- ⚠️ 边界：REPAID / CANCELED 行**不再被本对账覆盖**（staging 若在这部分丢行，这里看不见）。
--    本对账守的是 FINISHED 行域的湖↔物化一致性；全状态一致性没有独立守护，登记为已知边界。
```

- [ ] **Step 2: 新建不变量测试**

```sql
-- assert_drill_order_line_matches_metric.sql — 行域数据同量不变量（spec 2026-10-22 §2.6）。
--
-- 它守的是**数据面同量**：`vw_` 直读湖的 FINISHED 行 vs `stg_` 按 CASE 物化的 FINISHED 行，
-- 按 (system_book, bizday) 对齐——两跳之间丢行 / 丢分区 / cast 错会红。
-- ⚠️ 它**读不到 YAML 声明**（两侧谓词都是本文件硬编码的独立参考实现），所以**声明漂移不会让它红**；
--    声明层守卫在 scripts/sync-data-semantics.test.ts 的真事实源用例。
--
-- 形态同 audit_* / Phase 1 的 assert_drill_*：返回任何行即失败；full join 缺一侧按 0 计
--（inner join 对「单侧局部丢分区」结构性失明）；金额 numeric(20,2) = 1 分容差；
-- 只测**闭窗日**（bizday < 上海今天：当日分区被 tick 持续重写，两侧时点不同不可比）；
-- 两侧皆空 ⇒ 空转绿守卫报一行。
with drill as (
    select system_book, bizday,
           count(*)::bigint                as line_count,
           sum(sale_money)::numeric(20,2)  as amount
    from {{ ref('vw_lemeng_retail_order_line') }}
    where state = 'FINISHED'
    group by 1, 2
),
metric as (
    select system_book, bizday,
           count(case when state = 'FINISHED' then 1 end)::bigint as line_count,
           sum(case when state = 'FINISHED' then sale_money else 0 end)::numeric(20,2) as amount
    from {{ ref('stg_lemeng_retail_order_line') }}
    group by 1, 2
)
select coalesce(a.system_book, b.system_book) as system_book,
       coalesce(a.bizday, b.bizday)           as bizday,
       a.line_count as drill_lines,  b.line_count as metric_lines,
       a.amount     as drill_amount, b.amount     as metric_amount,
       'vw-FINISHED 与 stg-CASE-FINISHED 数据不同量（单侧分区缺失 / 行域数据漂移）' as note
from drill a
full join metric b using (system_book, bizday)
where coalesce(a.bizday, b.bizday) < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
  and (coalesce(a.line_count, 0) <> coalesce(b.line_count, 0)
       or abs(coalesce(a.amount, 0) - coalesce(b.amount, 0)) > 0.01)

union all

select null, null, null, null, null, null,
       '空转绿：闭窗日两侧有一侧为空，对账在空集上「通过」是空转绿（不是对上了）'
where (select count(*) from drill  where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)) = 0
   or (select count(*) from metric where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)) = 0
```

- [ ] **Step 3: 重生成 lock + 静态门禁**

```bash
pnpm exec tsx scripts/lemeng/data-plane-lock.mjs
pnpm exec tsx scripts/check-data-plane-lock.mjs
pnpm exec tsx scripts/check-data-models.mjs          # 每条声明指标仍须有 audit_*（文件名未变）
```

`dbt test` 需要真库与湖，本任务**不本地跑**——由 Task 9 的真机 materialize 跑。

- [ ] **Step 4: Commit**

```bash
git add dbt/tests/lemeng/audit_lemeng__retail__order_line.sql dbt/tests/lemeng/assert_drill_order_line_matches_metric.sql deploy/data-plane.lock
git commit -m "test(data): order_line audit 收 FINISHED 行域 + 新增两面同源不变量"
```

---

### Task 8: 可发现性——工具描述与 SKILL 指引（零代码逻辑）

**Files:**
- Modify: `deploy/openclaw/data-query-plugin/index.js`（`query_detail` 的 description 字符串）
- Modify: `deploy/openclaw/data-query-plugin/lib.test.js`
- Modify: `deploy/openclaw/data-query-plugin/skills/data-query/SKILL.md`（「明细下钻」节）
- Modify: `modules/data/domain/agent-loop.ts`（`query_detail` 的 description 数组）

**Interfaces:**
- Consumes: 无（纯文案）。
- Produces: 模型行为规则——「回包少一列 = 未授权，不是无数据」。

- [ ] **Step 1: 写失败测试**（`lib.test.js` 两条既有测试内各加一条断言）

```js
  // 条件列缺席 = 未授权（2026-10-22 spec §2.3/§2.7）：别把「没权限看」答成「没有数据」
  assert.match(src, /条件列|未授权/);
```

SKILL 那条测试内加：

```js
  assert.match(skill, /未授权/);
```

- [ ] **Step 2: 跑测试确认失败**：`node --test deploy/openclaw/data-query-plugin/lib.test.js` → FAIL。

- [ ] **Step 3: 改文案**

`index.js` 的 `query_detail` description 末尾追加一句（保持单行字符串风格）：

```
"回包可能**少一列**（如 order_detail_std_price）：那是条件列未授权（无 data:cost），**不是没有数据**——如实答「该列需授权」，不要当成 NULL、0 或未采集。",
```

`agent-loop.ts` 的 `query_detail` 描述数组里追加一条（同口径、同风格）：

```ts
      '回包可能**少一列**（条件列）：那是未授权（如 data:cost），**不是没有数据/不是 NULL**——如实说明「该列需授权」。',
```

`SKILL.md`「## 明细下钻（query_detail，spec §2.6）」节末尾加一条：

```
- **回包可能少一列**：`lemeng:retail:order_line` 的 `order_detail_std_price` 等条件列**需授权**才出现（无 `data:cost` ⇒ 该列不在 `columns`/`rows` 里）。这是**未授权**，不是「没有数据」、不是 NULL、不是 0——如实答「该列需授权」。
```

- [ ] **Step 4: 跑测试**：`node --test deploy/openclaw/data-query-plugin/lib.test.js` → 全绿；`pnpm --filter data test` → 绿。

- [ ] **Step 5: Commit**

```bash
git add deploy/openclaw/data-query-plugin/index.js deploy/openclaw/data-query-plugin/lib.test.js \
        deploy/openclaw/data-query-plugin/skills/data-query/SKILL.md modules/data/domain/agent-loop.ts
git commit -m "docs(data): 条件列缺席=未授权——工具描述与 SKILL 指引同口径"
```

---

### Task 9: 真机部署与验收（spec §4 全表）

**Files:** 无新代码；全部经 openship MCP 操作（唯一通道）。

- [ ] **Step 1: PR + 合并**——PR 标题 `feat(data): bot 问数明细下钻 Phase 2 (#N)`，body 含 `Closes #N` + 两处已裁定偏差（§3.2 / §3.3）+ 回滚节（spec §7）。等 CI **CLEAN**（不拿 UNSTABLE 强合）；merge main = 平台门禁全绿自动部署。

- [ ] **Step 2: 部署后验证（deploy-verify 纪律）**——容器创建时间 > 镜像构建时间；**更强判据 = 新行为在线可观测**：进容器 grep 产物含 `grantedColumns`（按 `deploy-verify-grep-container-not-http` 记忆的配方；宿主 HTTP 面先 401，别拿它当判据）。

- [ ] **Step 3: 数据面四步链**（merge ≠ 上线，记忆 `shanhai-data-plane-delivery-chain`）：
  1. 山海主项目部署（openship MCP 触发）⇒ dbt 工件更新；
  2. 跑 sync（数据面既有 sync job，`post_jobs_by_key_run`）⇒ 验 `data.metrics` 里 `lemeng:retail:order_line` 的 `drill_expr IS NOT NULL`、`drill_detail->'columns'` 是那一条；
  3. `sync-data-semantics --check` 零漂移（**零漂移才算物化到位**）；
  4. 触发 materialize（dbt build），日志含 `assert_drill_order_line_matches_metric` 与 `audit_lemeng__retail__order_line` PASS。

- [ ] **Step 4: 变异确认（判据只有变异能证真，逐个做、只读）**：

| 变异（在容器内用只读 SQL 或临时改声明后重跑） | 必须看到 |
|---|---|
| `detail.filter` 去掉 `state='FINISHED'` | `rowCountTotal` ≠ 14935（不预设新值，判据是「≠」） |
| expression 的 CASE 写成 `state <> 'FINISHED'`（**声明**变异） | `scripts/sync-data-semantics.test.ts` 真事实源用例红；若该变异同时改变了数据面（如已重新物化），新不变量 `assert_drill_order_line_matches_metric` 也可能返回 >0 行——但**声明**的守卫是那条单测，不是新不变量 |
| `grantedBy` 改成清单外的码 | 门禁 ⑤ 红（本地 `pnpm exec tsx scripts/check-column-scope-monotonicity.mjs` 即可复现） |
| `granted` 不过滤（对无码者也投影） | 单测红（Task 5 第二格） |

> 声明的变异在**本机**跑（改工作区 → 跑门禁/单测 → `git checkout` 还原）；真机只做只读 SQL 对照，不长期改线上声明。

- [ ] **Step 5: spec §4 六条逐条验收**

1. `query_detail(lemeng:retail:order_line, bizday=2026-10-20)` ⇒ `rowCountTotal = 14935`；`2026-10-21` ⇒ `14395`（**行域未变必须逐字复现**）。
2. **无** `data:cost`：回包 `columns` 不含 `order_detail_std_price`；审计 `drill.grantedColumns = []`。
3. **授予** `data:cost`：同一查询 `columns` 含该列；抽查若干行 = 该行 `std_price`；审计 `grantedColumns = ["order_detail_std_price"]`。
4. 聚合面：`query_data(lemeng:retail:order_line, bizday=2026-10-20)` 的 value 与
   `select sum(sale_money) from vw_lemeng_retail_order_line where state='FINISHED' and bizday='2026-10-20'` **逐分一致**。
5. `npm run gates` 绿（含新增门禁用例）+ 数据面 `dbt test` 绿。
6. **渠道轮（企微真机轮，避开部署窗口）**：问「10-20 有多少行」⇒ 14935；问「按商品看明细」⇒ rows 含 `item_num`；无码者问「标准价是多少」⇒ 如实答「该列需授权」，**不是**「没有数据」。

- [ ] **Step 6: 回滚演练（桌面）**——声明面回滚 = revert YAML + 跑 sync ⇒ 下钻绑定消失（`query_detail` 回 `no_detail_binding`）、聚合面回 26 列；代码回滚与之同批。把两种开关写进 PR 的「回滚」节。**无数据迁移、无 DDL。**

---

### Task 10: spec 附录 + 收尾

**Files:**
- Modify: `docs/superpowers/specs/2026-10-22-drillthrough-phase2-design.md`（末尾加「实施订正」节）

- [ ] **Step 1: spec 附录**——记录实施期与计划的偏离（若有）与三条实证：锚值复现、审计面形状、变异确认结果。**没做的别写**。

- [ ] **Step 2: CHANGELOG 不手写**（`release.mjs` 生成）；确认提交均为 conventional、squash 后 subject 带 `(#N)`、provenance trailer 未被删改。

- [ ] **Step 3: 经验沉淀**——先查重（WeKnora hybrid-search），命中则更新原条目：候选条目 =「下钻条件列 vs 值级掩码的边界」「mask 正则对 `max(col) as col` 的双替换」。不新建重复条目。

---

## Self-Review 记录

- **Spec 覆盖**：
  - §2.2 声明面（measures / expression FINISHED / grain=dimensions 8 列 / detail.columns / 硬约束 8 条）→ Task 6；
  - §2.3 条件列（声明、无码缺席、审计 grantedColumns、不是掩码）→ Task 1 / 5；
  - §2.4 执行面（门序、内层/外层形状、rollupOver 尾参、columns 顺序）→ Task 5；
  - §2.5 门禁与 sync（check-data-models、单调门 ⑤、sync 物化、类型、无迁移）→ Task 2 / 3 / 4 / 1；
  - §2.6 对账（audit 改域 + 新不变量）→ Task 7；
  - §2.7 可发现性（definition 重写 → Task 6；SKILL/工具描述 → Task 8）；
  - §4 验收六条 + 变异表 → Task 9；§7 回滚 → Task 9 Step 6。
- **两处偏差**（§3.2 不打 sensitivity、§3.3 聚合面留 stg）在计划头与 Global Constraints 各写一遍，Task 6 的 YAML 注释也写死——**三处口径同源**。
- **类型一致性**：`DrillColumn{col,grantedBy}` 贯穿 Task 1/4/5；`drillDetail` 在声明侧、库侧（`drillTripleOf`）、比对元组三处同形（Task 4 专门钉「库侧不透传 ⇒ 恒报更新」）；审计面 `{dimensions,rowCountTotal,grantedColumns}` 在 Task 5 的 `audit-store.ts` 与 `drill.ts` 两处一致。
- **无占位符**：所有代码块、SQL、命令均为逐字可执行内容；真机步骤给出判据与操作通道（openship MCP）。
- **风险点**（执行时留意，不是待办）：
  1. `mask.ts` 的按列替换会同时命中 `max(<col>) as <col>` 的两处——**本批没有任何列掩码作用于该列**，故不触发；已写进 YAML 注释与 dbt/README 的边界说明。
  2. `check-data-models` 的 `detail` 键闭集会拒绝一切历史/未来的未知键——当前仓内只有 `relation`/`filter`，无存量风险。
  3. 锚值 14935 / 14395 是 Phase 1 已测值：**行域不变则必须逐字复现**，不等就是行域或主体过滤漂了，停下来查，不要改锚。
