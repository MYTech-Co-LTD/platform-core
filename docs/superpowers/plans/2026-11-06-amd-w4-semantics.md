# W4 语义完备 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 对应路线图 §3 的 **W4**：`docs/superpowers/plans/2026-11-04-auto-metric-derivation-roadmap.md`
> 开工前重读路线图 §1（G6）、§3（W4 出口判据）、§5（台账状态），并**用命令核实代码现状**。

**Goal:** 接第二个源系统之前，把「业务对象 / 维度层级 / 业务不变量」三类语义补齐，并用门禁锁死——之后任何新源、新指标都必须挂得上、说得清。

**Architecture:** 三个声明文件（`entities.yml` / `dimensions.yml` / `invariants.yml`）落在 `dbt/semantics/`，与 `l1_metrics.yml` 并列，同为**声明侧唯一事实源**；一个校验脚本 `scripts/check-semantics.mjs` 提供纯函数供 CI 与域层复用；不变量经**数据验证**后才生成为 dbt singular test。

**Tech Stack:** YAML（`yaml` 包）/ Node ESM / dbt singular tests / Postgres 只读校验。

## Global Constraints

- **B11 单一定义**：三个新文件只声明「对象/层级/规则」，**不定义指标口径**；口径仍只在 `l1_metrics.yml`。
- **迁移/门禁幂等**：所有校验脚本可重复执行、结果确定；CI 每次全量跑。
- **未知 ≠ 没有**：引用不存在的对象/列/关系必须**报 error**，不得静默跳过。
- **先验证后落测试**：不变量只有在仓库库上实测成立率 ≥99% 才允许生成 dbt test；不达标登记为「观察项」而不是硬门。
- **不引新依赖**：只允许 `yaml`（已在依赖里）与 Node 标准库。
- **不改** `l1_metrics.yml` 的口径字段（expression/ratio/definition）；只新增 `entity:` 绑定。
- 新源接入前置闸**先落 CI warning、再升 error**（见 Task 5 的两步），避免一次性打断所有进行中的接入。

---

### Task 1: `entities.yml` 与校验器

**Files:**
- Create: `dbt/semantics/entities.yml`
- Create: `scripts/check-semantics.mjs`（纯函数：`entityIssues(doc, metricEntities)`，供 CI 与测试调用）
- Test: `scripts/check-semantics.test.mjs`

**Interfaces:**
- Produces: `entityIssues(entitiesDoc, { metricEntityById }) → string[]`（空 = 干净）
- `entities.yml` 形状：
```yaml
version: 1
entities:
  - name: branch                # 与 l1_metrics.yml 的 entity: 同名
    label: 门店
    aliases: [店铺, 门店编号]
    system_of_record: lemeng     # 权威源（一个对象只能有一个）
    identity_keys: [branch_num]  # 对齐键（跨源对齐用）
    merge_rule: prefer_source    # prefer_source | manual
    owner: data-platform
```

- [ ] **Step 1: 写失败测试**

```js
// scripts/check-semantics.test.mjs
import { describe, expect, it } from 'vitest'
import { entityIssues } from './check-semantics.mjs'

const doc = (entities) => ({ version: 1, entities })

describe('entityIssues', () => {
  it('干净声明 ⇒ 无 issue', () => {
    expect(entityIssues(doc([{ name: 'branch', label: '门店', aliases: [], system_of_record: 'lemeng', identity_keys: ['branch_num'], merge_rule: 'prefer_source', owner: 'data-platform' }]), { metricEntityById: new Map() })).toEqual([])
  })
  it('同一对象两个权威源 ⇒ issue', () => {
    const out = entityIssues(doc([]), { metricEntityById: new Map() })
    const bad = { name: 'branch', label: '门店', aliases: [], system_of_record: 'a', identity_keys: ['x'], merge_rule: 'prefer_source', owner: 'o', _secondSor: 'b' }
    expect(entityIssues(doc([bad]), { metricEntityById: new Map() }).length).toBeGreaterThan(0)
  })
  it('指标引用了未声明的 entity ⇒ issue（未知 ≠ 没有）', () => {
    const out = entityIssues(doc([]), { metricEntityById: new Map([['lemeng:retail:sales', 'branch']]) })
    expect(out.join('\n')).toContain('branch')
  })
  it('对象缺 system_of_record / identity_keys ⇒ issue', () => {
    const out = entityIssues(doc([{ name: 'x', label: 'X', aliases: [] }]), { metricEntityById: new Map() })
    expect(out.length).toBeGreaterThanOrEqual(2)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**：`pnpm exec vitest run scripts/check-semantics.test.mjs` → `Cannot find module`
- [ ] **Step 3: 实现 `check-semantics.mjs`**（导出纯函数 + CLI；CLI 读 `dbt/semantics/*.yml` 与 `l1_metrics.yml`，打印 `check-semantics: OK（entities N / dimensions M / invariants K）`）
- [ ] **Step 4: 写初版 `entities.yml`**（先覆盖现有 21 条关系涉及的实体：branch / item / client / supplier / order / outbound 等；**权威源照实写，不编**）
- [ ] **Step 5: 跑测试 + CLI** → 全绿
- [ ] **Step 6: 提交**

---

### Task 2: 48 条 entity 绑定（分批，先报告后落盘）

**Files:**
- Modify: `dbt/semantics/l1_metrics.yml`（**只加 `entity:` 字段**，不动口径）
- Create: `scripts/report-entity-coverage.mjs`（打印「有/无 entity」清单与建议对象）

**规则：**
- 每个指标只能绑一个已在 `entities.yml` 声明的对象；
- 绑定建议由脚本给出（按 `select_sql` 的关系名与对象 `identity_keys` 匹配），**人确认后才写入**；
- 分批：先 `lemeng:retail:*` / `lemeng:outbound:*` / `lemeng:contribution:*` 三族，再其余。

- [ ] **Step 1: 写覆盖率脚本**（输出 `certified_total / with_entity / orphan 清单`）
- [ ] **Step 2: 跑脚本拿到当前数**（预期 2/50）与建议映射
- [ ] **Step 3: 逐族补 `entity:` 并跑 `check-data-models` + `check-semantics`**
- [ ] **Step 4: 全仓复跑**：`check-semantics` 报 `entity 绑定 50/50`；`check-data-models: OK`
- [ ] **Step 5: 提交**

---

### Task 3: `dimensions.yml`（4 组层级 + 跨源一致性维度）

**Files:**
- Create: `dbt/semantics/dimensions.yml`
- Modify: `scripts/check-semantics.mjs`（加 `dimensionIssues`）
- Test: `scripts/check-semantics.test.mjs`（补用例）

**形状：**
```yaml
version: 1
dimensions:
  - name: branch
    relation: dim_lemeng_branch
    key: branch_num
    hierarchy:            # 自顶向下，父在前
      - { level: region_l1, column: region_l1 }
      - { level: region,    column: region_id }
      - { level: branch,    column: branch_num }
    aliases: [门店,店]
```

**校验：**
- 层级无环、每个 level 唯一、末级 = 对象的 `identity_keys`；
- 引用的 `relation` / `column` 必须存在于 `contracts/**/*.json` 或 `dbt/models/**` 的列声明里（未知 ⇒ error）；
- 同一 `(relation,key)` 不得在两个维度里重复。

- [ ] **Step 1-6**：测试先行（环 / 未知列 / 重复键 ≥3 条用例）→ 实现 → 写 4 组维度（branch 两级、area 三级、item 三级、client 两级）→ 全绿 → 提交

---

### Task 4: `invariants.yml`（先验证，后落测试）

**Files:**
- Create: `dbt/semantics/invariants.yml`
- Create: `scripts/verify-invariants.mjs`（在 `DATA_WAREHOUSE_URL` 上跑每条 SQL，算成立率）
- Create: `dbt/tests/<domain>/invariant_<name>.sql`（**仅对通过验证的条目生成**）
- Test: `scripts/verify-invariants.test.mjs`（注入假查询）

**形状：**
```yaml
version: 1
invariants:
  - name: net_eq_sale_minus_return
    relation: fct_retail_sale
    sql: "select count(*) from {{ ref('fct_retail_sale') }} where abs(net_amount - (sale_amount - return_amount)) > 0.01"
    expect: zero_rows
    severity: error
    owner: data-platform
    status: verified        # candidate | verified | observing
```

**纪律：**
- `status: candidate` 的条目不生成测试；
- 验证脚本输出每条的实际违反行数与占比；≥99% 期间成立（即违反占比 <1%）才由人改 `verified`；
- 不达标的留 `observing` 并在 §5 台账登记，**不许硬门**。

- [ ] **Step 1-6**：测试 → 实现验证脚本 → 录入 10 条候选 → 跑真机得成立率 → 人工裁决 verified/observing → 生成 dbt tests → 全绿 → 提交

---

### Task 5: 接新源前置闸

**Files:**
- Modify: `.claude/skills/collect-source/SKILL.md`（阶段 A 前置：三表检查）
- Modify: `scripts/check-semantics.mjs`（`--new-source <system>` 模式：新源必须能在 `entities.yml` 找到至少一个对象，且该对象 `system_of_record` 不得冲突）
- Modify: `.github/workflows/ci.yml`（**先 warning，后 error**：两步 PR）

- [ ] **Step 1**：加 `--new-source` 模式 + 测试（未知源 ⇒ issue；冲突权威源 ⇒ issue）
- [ ] **Step 2**：写进 `collect-source` 的阶段 A 前置清单（三条 checkbox）
- [ ] **Step 3**：CI 以 `continue-on-error: true` 接入一轮（观察不阻断）
- [ ] **Step 4**：一个发版周期后改硬门（单独 PR，写进 §5 台账）

---

## Self-Review

- 路线图 G6 三条（实体 100% / 层级可上卷 / 规则有 owner 与结果）与 W4 出口判据逐条对应 ✅
- 不引新依赖、不动口径、未知即报错 ✅
- 新源闸分两步（warning → error），避免打断进行中的接入 ✅
- 未覆盖：层级/不变量的**运行时消费**（drill 上卷、指标异常判定）——属 W5/W6，不在本波
