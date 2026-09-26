# 数据面主体列（`org`）落地实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 dbt 的 staging / marts 模型带上主体列 `org`，使 `modules/data` 的行级授权谓词 `WHERE org = '<orgId>'` 在数据面上真的有着力点。

**Architecture:** 新增单定义点 macro `dbt/macros/subject_org.sql`（读 env 键 `LEMENG_SUBJECT_ORG`，缺失或空串都响亮失败）；新湖三个 staging 模型与 marts 各**注入**一列（marts 不用「从 staging 透传」—— 判据要单一形状 `as org`，且模型自足，见 Task 1 Step 4 的实施订正）；再给 `scripts/check-data-models.mjs` 加一条**静态门禁**把这个形状钉住。

**Tech Stack:** dbt（Jinja macro + YAML schema）、Node ESM（`.mjs` 静态门禁）、vitest（门禁 fixtures）。

**设计正典：** `docs/superpowers/specs/2026-09-26-subject-org-column-design.md`（已合入 main）。
**上位：** `docs/architecture.md` §2.2 末注「缺口 A」、issue #176。

---

## Global Constraints

- **env 键名逐字 = `LEMENG_SUBJECT_ORG`**（与 `LEMENG_ZOS_*` 同族）。**值 = 该部署租户的 `casdoor_org`，绝不落仓、不进 argv、不进文档**——本计划里只出现键名与取法。
- **不改 `contracts/`**：`org` 不是契约列（契约 `lemeng.retail_order_line.json` 逐名 18 列，不含 org）。
- **不改 `scripts/sync-data-semantics.mjs` 的 `L1_SUBJECT_COLUMN`（保持 `'org'`）、不改 `dbt/semantics/l1_metrics.yml` 的 `grain`**（`[system_book, bizday]` 仍成立）。
- **不改生产物化 job、不跑真库**：那是同批 spec B 的事（spec §3）。
- **`dbt parse` / `dbt build` 本机跑不了**（本机无 dbt）⇒ 任何步骤**不许**声称跑过；它的验证归 spec B 的 Step 0。
- **提交格式**：`<type>(<scope>): <一句话>`；本计划的提交是 `feat` ⇒ **必须先有 issue**（Task 1 Step 0 开），PR body 写 `Closes #<新 issue>`；**不要写 `Closes #176`**（#176 的「缺口 B：平台超管 signal」没被本计划解决，关不掉）。
- **波次**：本计划三个任务**全部落在一个 PR、且共享文件**（`dbt/models/**` 与 `scripts/check-data-models.*`）⇒ **串行单 worker**，不拆波（团队规则：波内不得改同一文件）。

---

## 文件结构（决定任务边界）

| 文件 | 动作 | 职责 |
|---|---|---|
| `dbt/macros/subject_org.sql` | **新建** | 主体列 `org` 的**唯一定义点**（env 读取 + 两道 fail-closed） |
| `dbt/models/common/staging/stg_lemeng_retail_order_line.sql` | 改 | 加一列 `org` |
| `dbt/models/common/staging/stg_lemeng_branch.sql` | 改 | 加一列 `org` |
| `dbt/models/common/staging/stg_lemeng_item.sql` | 改 | 加一列 `org` |
| `dbt/models/common/marts/fct_retail_sale.sql` | 改 | 注入 `org` 常量（`{{ subject_org() }} as org`，**不透传**） |
| `dbt/models/common/staging/schema.yml` | 改 | 三个模型各登记 `org` 列（`not_null`）+ 订正 `:30` 那句 |
| `dbt/models/common/marts/schema.yml` | 改 | 登记 `org` 列（`not_null` + 说明「relation 内单值」） |
| `scripts/check-data-models.mjs` | 改 | 新增规则 ⑩（主体列形状）+ 豁免名单 + 空转自检 |
| `scripts/check-data-models.test.ts` | 改 | 基线 fixture 升级 + 规则 ⑩ 的四格 fixtures |
| `dbt/README.md`、`dbt/macros/generate_schema_name.sql`、`scripts/sync-data-semantics.mjs` | 改 | 三处陈旧的「marts 行里的 org 列」叙述收口 |

**任务边界**：Task 1 = 列落地（让真实仓先带上 `org`，此时门禁还没这条规则 ⇒ 每个提交都是绿的）；Task 2 = 门禁（规则 + fixtures，此时真仓已合规 ⇒ 真仓自检用例也是绿的）；Task 3 = 文档收口。

---

### Task 1: 主体列落地（macro + 三个 staging + marts + 两个 schema.yml）

**Files:**
- Create: `dbt/macros/subject_org.sql`
- Modify: `dbt/models/common/staging/stg_lemeng_retail_order_line.sql:64-66`、`stg_lemeng_branch.sql:19-21`、`stg_lemeng_item.sql:20-22`
- Modify: `dbt/models/common/marts/fct_retail_sale.sql:63-71`（+ 头注）
- Modify: `dbt/models/common/staging/schema.yml:30,32-39`（+ 另两个模型的 columns）
- Modify: `dbt/models/common/marts/schema.yml:20-43`

**Interfaces:**
- Produces: macro `subject_org()` —— 无参，返回**已带单引号的字面量**字符串，例如调用 `{{ subject_org() }} as org` 渲染成 `'<租户键>' as org`。Task 2 的静态门禁按 `as org` 这个渲染后的形状判（它只看模板文本，所以判据写 `\bas\s+org\b`）。
- Produces: 四个模型的输出列里含 `org`（varchar 字面量）。
- Consumes: 无（本任务不依赖前面的任务）。

- [ ] **Step 0: 开 issue（`feat` 的前置，纪律硬要求）**

```bash
gh issue create --title "feat(data-stack): 数据面主体列 org 落地——marts/staging 补 org + dbt 侧门禁（#176 缺口 A）" \
  --body "按 spec docs/superpowers/specs/2026-09-26-subject-org-column-design.md 实施仓内那半（spec A）。
范围：macro subject_org + 新湖三 staging + fct_retail_sale + 两个 schema.yml + check-data-models 新增主体列门禁 + 订正五处陈旧叙述。
真机（scope 回读 / 凭据负测 / #175 裁决 / 补生产 job env）归 spec B。
Refs #176"
```

记下输出的 issue 号 `#N`，后面每个提交都 `Refs #N`、PR body 写 `Closes #N`。

- [ ] **Step 1: 写 macro**

创建 `dbt/macros/subject_org.sql`：

```jinja
{#
  subject_org.sql — 数据面**主体列**（`org`）的唯一定义点。
  设计正典：docs/superpowers/specs/2026-09-26-subject-org-column-design.md

  ── 它解决什么 ──────────────────────────────────────────────────────────────────────
  `modules/data/domain/authz.ts` 的 `authorize()` **恒拼** `<select_sql> WHERE <主体列> = '<orgId>'`，
  而主体列写死为 `org`（scripts/sync-data-semantics.mjs 的 `L1_SUBJECT_COLUMN`）。
  主体列在**真实关系里不存在**时，拼出的 SQL 必然以仓库错误（502）收场（issue #176 缺口 A）
  ⇒ 本 macro 就是让那一列存在。

  ── 值从哪来 ────────────────────────────────────────────────────────────────────────
  值 = **该部署租户的 casdoor_org**，经 env 键 `LEMENG_SUBJECT_ORG` 注入。
  **不落仓、不进 argv、不进文档**（取值口径与取法见 dbt/README.md「多租户跑法」节）。

  ── 两道 fail-closed（为什么不能直接写 env_var）─────────────────────────────────────
  `env_var('X')` 在 **X 未定义**时报错，但在 **X 已定义且为空串**时**正常返回 `''`** ⇒ 那种形态会把
  「配了但配错」放行成**静默的空 org**：写入侧看着成功、读取侧 `where org = $1` 一行都查不到
  （空串不是 NULL，非空约束也拦不住）。所以空串这道断言必须由本 macro 自己响亮失败。

  ── 与 var('tenant') 的分工（刻意解耦）──────────────────────────────────────────────
  `var('tenant')` 决定**物化落点**（schema 名，见 macros/generate_schema_name.sql）；
  本 macro 决定**行内主体**。两者在多租户跑法下同源，但单租户（P1 私有化）跑法下**必须分叉**：
  那份配置**不给** `tenant` var 是合法形态（dbt/README「多租户跑法」节），而 org 列
  **任何时候都必须有值** ⇒ 不用 `var('tenant')` 承担 org。
#}
{% macro subject_org() -%}
    {%- set o = env_var('LEMENG_SUBJECT_ORG') | trim -%}
    {%- if o == '' -%}
        {{ exceptions.raise_compiler_error(
            "LEMENG_SUBJECT_ORG 为空：org 是行级授权的主体列，空串不是 NULL —— "
            ~ "它会静默写进行里，让 where org = $1 一行都查不到（写成功、读不到，最难查）。"
            ~ "把该部署租户的 casdoor_org 配进 env（键名与取法见 dbt/README.md 多租户跑法节）再跑。") }}
    {%- endif -%}
    '{{ o }}'
{%- endmacro %}
```

- [ ] **Step 2: 三个 staging 模型各加一列（紧随 `system_book` 之后）**

`dbt/models/common/staging/stg_lemeng_retail_order_line.sql`，把

```jinja
  r['system_book']::varchar as system_book,
  r['bizday']::date         as bizday,
```

改成

```jinja
  r['system_book']::varchar as system_book,
  {{ subject_org() }}       as org,
  r['bizday']::date         as bizday,
```

`dbt/models/common/staging/stg_lemeng_branch.sql`，把

```jinja
  r['system_book']::varchar  as system_book,
  r['snapshot']::date        as snapshot,
```

改成

```jinja
  r['system_book']::varchar  as system_book,
  {{ subject_org() }}        as org,
  r['snapshot']::date        as snapshot,
```

`dbt/models/common/staging/stg_lemeng_item.sql`，把

```jinja
  r['system_book']::varchar as system_book,
  r['snapshot']::date as snapshot,
```

改成

```jinja
  r['system_book']::varchar as system_book,
  {{ subject_org() }} as org,
  r['snapshot']::date as snapshot,
```

- [ ] **Step 3: 三个 staging 文件的头注订正（同一批改，别留到后面）**

三处「契约 N 列全带」要补上注入列，否则文件自己说「列集 = 契约列」，而下面多了一列：

- `stg_lemeng_retail_order_line.sql:56`：`-- 【三】契约 18 列**全带**（一对一不许丢列）`
  → 追加一行：`--    （另加 **dbt 注入列 `org`**：主体列，非契约列，见 dbt/macros/subject_org.sql）`
- `stg_lemeng_branch.sql:17`：`…（16 列全带，本层不加语义）。` → 改为
  `…（16 列全带，本层不加语义；**另加 dbt 注入列 `org`**）。`
- `stg_lemeng_item.sql:17`：同上，`108 列全带` → `108 列全带，本层不加语义；**另加 dbt 注入列 `org`**）。`

- [ ] **Step 4: marts 注入主体列**

`dbt/models/common/marts/fct_retail_sale.sql`，把

```jinja
select
    system_book,
    bizday,
    sum(sale_money)::numeric(20,2) as net_amount,
    count(distinct order_no)       as order_count
from {{ ref('stg_lemeng_retail_order_line') }}
group by
    system_book,
    bizday
```

改成

```jinja
select
    system_book,
    {{ subject_org() }} as org,
    bizday,
    sum(sale_money)::numeric(20,2) as net_amount,
    count(distinct order_no)       as order_count
from {{ ref('stg_lemeng_retail_order_line') }}
group by
    system_book,
    bizday
```

> ⚠️ **2026-09-26 实施订正（原计划写的是「从 staging 透传 + 进 GROUP BY」，那是错的）**：
> 透传形态是**裸 `org,`**，而 Step 2 的门禁判据是 **`as org`**（单一形状）——两者自相矛盾，
> 规则一上线就把真仓的 `fct_retail_sale.sql` 判红。改为**注入常量**：判据守得住，
> 且 marts 模型自足（不必先确认上游 staging 有没有那一列）。同一轮运行里 macro 取同一个 env
> ⇒ 与 staging 的 `org` 恒等。`org` **不进 GROUP BY**（常量不必进）。

并在该文件的**粒度头注**（`-- 粒度（grain）：**(system_book, bizday)** —— 账套 × 业务日` 那一段）后追加：

```jinja
-- ⚠️ `org` 是**主体列**（行级授权谓词 WHERE org = … 的着力点，见 dbt/macros/subject_org.sql）：
--   本模型用 `{{ subject_org() }}` **直接注入常量**（**不从 staging 透传**）—— 两个理由：
--   ① 规则 ⑩ 的判据是**单一形状** `as org`（scripts/check-data-models.mjs），注入形态才守得住；
--   ② 模型自足：新加 marts 模型时不必先确认上游 staging 有没有那一列。
--   同一轮运行里 macro 取的是同一个 env ⇒ 与 staging 的 org **恒等**，不存在两份值。
--   它是常量、**不参与口径**，故不进 GROUP BY；每个租户物化进自己的 schema
--   （macros/generate_schema_name.sql）⇒ **单个 relation 内 org 恒为单值**，粒度仍写作 (system_book, bizday)。
```

- [ ] **Step 5: `staging/schema.yml` 登记三处 + 订正 `:30`**

`dbt/models/common/staging/schema.yml:30` 那句：

```yaml
      `contracts/common/lemeng.retail_order_line.json`（18 列）为准。
```

改成

```yaml
      `contracts/common/lemeng.retail_order_line.json`（18 列）为准；**另加 dbt 注入列 `org`**（主体列，
      非契约列，见 `dbt/macros/subject_org.sql`）。
```

然后给**三个** staging 模型的 `columns:` 各加一条（放在 `system_book` 之后、`bizday`/`snapshot` 之前，与模型里的列序一致）：

```yaml
      # ── dbt 注入的主体列（非契约列；行级授权谓词 WHERE org = … 的着力点）────────────────
      - name: org
        description: '主体列 = 该部署租户的 casdoor_org（经 env `LEMENG_SUBJECT_ORG` 注入，值不落仓）。**不是契约列**：契约只有 18/16/108 列，本列由 dbt 层加（dbt/macros/subject_org.sql）。'
        tests:
          - not_null
```

- [ ] **Step 6: `marts/schema.yml` 登记 `org`**

在 `dbt/models/common/marts/schema.yml` 的 `columns:` 里，`system_book` 那条之后加：

```yaml
      - name: org
        description: '主体列 = 该部署租户的 casdoor_org（经 env `LEMENG_SUBJECT_ORG` 注入，值不落仓）。本模型由 `subject_org` 宏注入常量（**只写宏名，不写调用形态** —— 见下面的警告）；不参与口径，每个租户物化进自己的 schema ⇒ **单个 relation 内恒为单值**，故模型粒度仍写作 (system_book, bizday)。行级授权谓词 `WHERE org = …` 的着力点（modules/data/domain/authz.ts）。'
        tests:
          - not_null
```

同时把该模型的 `description`（`:17-19` 那段）末尾补一句：

```yaml
      含**主体列 `org`**（由 `subject_org` 宏注入常量，见 dbt/macros/subject_org.sql）；粒度不受它影响 ——
      每个租户物化进自己的 schema，relation 内 org 恒为单值。
```

> ⚠️ **2026-09-26 实测订正（issue #261）**：上面两处**原稿写的是 Jinja 调用形态**（双大括号 + 宏名 + 括号），
> 那会**把 `dbt parse` 打挂**——description 在**解析期**就被渲染，而那时的上下文里**项目 macro 不可见**
> ⇒ 报 `'<宏名>' is undefined`。本仓的 `marts/schema.yml` 因此把**生产物化 job 打红过一次**。
> ⇒ **凡是写在 `.yml` 的 `description` 里的文字，一律只写宏名、不写调用形态**；连当反例写也不许
> （反例同样会被渲染）。模型 `.sql` 里的调用**不受此限**（那是正常用法）。

- [ ] **Step 7: 跑门禁与单测（此刻应当**全绿**：新列不违反任何既有规则）**

```bash
pnpm exec tsx scripts/check-data-models.mjs
pnpm run test:guard
```

Expected: 两条都是 exit 0。**注意这两条绿的语义**：它证明的是「**没有回归**」，
**不是**「org 列写对了」——后者要等 Task 2 的规则 ⑩ 与 spec B 的 `dbt parse`。

- [ ] **Step 8: 重跑投递 lock（**改了 `dbt/` 下的文件就必须有这一步**）**

`dbt/**` 在数据面投递清单里 ⇒ 改一个字节、加一个文件，`deploy/data-plane.lock` 就对不上，
`check-data-plane-lock` 会红。

```bash
pnpm exec tsx scripts/lemeng/data-plane-lock.mjs
pnpm exec tsx scripts/check-data-plane-lock.mjs
```

Expected: `data-plane-lock: 写入 deploy/data-plane.lock（8 条清单条目 → 39 个文件）`，随后自检 `OK`
（新增 macro 会多出一行；文件数 38 → 39）。

⚠️ **本步是实测踩空后的回填**：2026-09-26 执行本计划时，Step 7 的 `pnpm run test:guard` 先把
`check-data-plane-lock` 的 CLI 用例打红了（`deploy/data-plane.lock: 7 处违规`），才发现原计划漏了它。
**别把它当预防性步骤跳过**——`test:guard` 里那条用例就是它的检测器。

- [ ] **Step 9: commit**

```bash
git add dbt/macros/subject_org.sql dbt/models/common/staging dbt/models/common/marts
git commit -m "feat(data-stack): 数据面主体列 org 落地——macro + 三个 staging + marts 注入（Refs #N）"
```

（把 `#N` 换成 Step 0 的 issue 号。）

---

### Task 2: 门禁规则 ⑩（主体列形状）+ fixtures

**Files:**
- Modify: `scripts/check-data-models.mjs:143`（常量区）、`:679` 后（规则区）
- Modify: `scripts/check-data-models.test.ts:42-46`（常量）、`:60-100`（基线）、`:136` 后的 describe 块

**Interfaces:**
- Consumes: Task 1 的 `as org` 渲染形状（门禁只看模板文本）。
- Produces: 导出常量 `SUBJECT_ORG_RE`、`SUBJECT_ORG_EXEMPT`（供 fixtures 引用豁免名单，避免第二处事实源）。

- [ ] **Step 1: 升级 fixtures 基线（**必做，否则既有 fixtures 会集体变红**）**

基线里 `MARTS` 指向 `dbt/models/common/marts/fct_retail_sale.sql`，它**不在豁免名单**里 ⇒ 加了规则 ⑩ 之后，
基线自己就违规，`check-data-models.test.ts` 里所有 `variant()` 派生的用例会连带变红。
在 `compliant()` 的 `[MARTS]` 片段里加一行（放在 `'3120' as system_book,` 之后）：

```ts
      "    'acme' as org,",
```

（基线的 STAGING 常量指向 `stg_lemeng_retail_detail.sql`，**在豁免名单内** ⇒ 不用动它。）

- [ ] **Step 2: 写规则 ⑩ 的 fixtures（先写、先看它红）**

在 `check-data-models.test.ts` 的「门禁六格 + 附加两格」describe **之后**新开一个 describe。
**取违规的形态照抄既有用例**：直接 `checkDataModels(root)`（该文件已 import 它），
断言风格也用既有的 `toHaveLength(1)` —— **基线必须恰好 0 违例**，所以一处变异通常恰好 1 条。

```ts
describe('格⑩：主体列 org（issue #176 缺口 A / spec 2026-09-26-subject-org-column-design）', () => {
  it('格⑩-1：基线干净 —— 同时覆盖「豁免文件缺列不算违规」这一半', () => {
    // 基线的 STAGING 常量 = stg_lemeng_retail_detail.sql（在豁免名单里），它**没有** `as org`；
    // 基线的 MARTS 已按 Step 1 带上 `as org` ⇒ 这里必须恰好 0 违例。
    expect(checkDataModels(fixture(compliant()))).toEqual([])
  })

  it('格⑩-2：marts 缺 `as org` → 恰好 1 条，且指到那个模型文件', () => {
    const root = variant((f) => {
      f[MARTS] = f[MARTS].replace("    'acme' as org,\n", '')
    })
    const violations = checkDataModels(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.file).toBe(MARTS)
    expect(violations[0]?.message).toContain('org')
  })

  it('格⑩-3：只在**注释**里写 `as org` → 仍违规（注释位不算代码位，同实现判断①）', () => {
    const root = variant((f) => {
      // 把真列换成注释里的一句话：掩码后代码位没有 `as org` ⇒ 必须红（否则「写句注释就过关」）
      f[MARTS] = `-- 被注掉了：'acme' as org\n` + f[MARTS].replace("    'acme' as org,\n", '')
    })
    const violations = checkDataModels(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.file).toBe(MARTS)
  })

  it('格⑩-4：**非豁免** staging 缺 `as org` → 恰好 1 条（staging 侧同样在扫描面内）', () => {
    const root = variant((f) => {
      // 非豁免的 staging 必须同时有源声明，否则会先因规则 ④ 变红 ⇒ 这里补一份源（6 空格缩进，
      // 与基线里 `- name: retail_detail` 同级）
      f[SOURCES] = f[SOURCES] + '      - name: retail_order_line\n'
      f['dbt/models/common/staging/stg_lemeng_retail_order_line.sql'] = [
        "with r as (select * from read_parquet('s3://bucket/lemeng/retail_order_line/**/*.parquet'))",
        'select',
        "    r['system_book']::varchar as system_book",
        'from r',
        '',
      ].join('\n')
    })
    const violations = checkDataModels(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.file).toBe('dbt/models/common/staging/stg_lemeng_retail_order_line.sql')
  })

  it('格⑩-5：扫描面全落豁免上 ⇒ 空转自检报违规（规则空转 = 门禁不存在）', () => {
    // 只留「声明的源 + 那个**豁免**的 staging 文件」，不建任何 marts ⇒ subjectScanned === 0。
    // 规则 ④ 双向在这一份里是满足的（lemeng.retail_detail ↔ stg_lemeng_retail_detail），
    // 所以这一条违规只能来自空转自检。
    const files = compliant()
    delete files[MARTS]
    const violations = checkDataModels(fixture(files))
    expect(violations).toHaveLength(1)
    expect(violations[0]?.message).toContain('空转')
  })
})
```

⚠️ 若 Step 6 跑出来某格违例数不是 1（而是 2+），**先看是哪条规则多报了**再改断言 ——
不要为了凑数把 `toHaveLength(1)` 放宽成 `toBeGreaterThan(0)`（那会把「多报」这个真缺陷一起放行）。

- [ ] **Step 3: 跑 fixtures，确认格⑩-2/3/4 红**

```bash
pnpm run test:guard
```

Expected: 格⑩-2 / ⑩-3 / ⑩-4 / **⑩-5 FAIL**（规则还不存在，空转自检自然也还没有）
—— ⑩-5 是**实测补充**（原计划只列了前三格）；其余全绿（含既有的 258 条）。

- [ ] **Step 4: 写常量**

`scripts/check-data-models.mjs` 常量区（`:143` 附近，`METRIC_NAME_RE` 之后）：

```js
/** marts 模型：`dbt/models/**\/marts/*.sql`（含 `fct_*` 与将来的 `dim_*`——主数据维度表同样按租户物化）。 */
const MARTS_RE = /^dbt\/models\/(?:.+\/)?marts\/[A-Za-z0-9_]+\.sql$/

/** 主体列（`org`）的注入形态：`… as org`。**注释掩码后**判（注释里提一句不算，同实现判断①）。 */
export const SUBJECT_ORG_RE = /\bas\s+org\b/

/**
 * 主体列门禁的**文件级豁免**（必须显式登记 + 写理由；不许靠「没扫到」）。
 * `stg_lemeng_retail_detail.sql`：旧湖、**待退役**，且该文件自身列集是暂定
 * （头注「列全集按 T6 实测样本补齐」）⇒ 不为它补 org。**退役那笔要顺手收回本条豁免。**
 */
export const SUBJECT_ORG_EXEMPT = new Map([
  [
    'dbt/models/common/staging/stg_lemeng_retail_detail.sql',
    '旧湖（待退役）且自身列集是暂定；退役那笔要顺手收回本条豁免',
  ],
])
```

- [ ] **Step 5: 写规则 ⑩**

`check-data-models.mjs` 的 `checkDataModels` 里，**`// ── 规则 ⑤⑥⑦：语义声明` 之前**（即 `:679` 那个 for 循环之后）插入：

```js
  // ── 规则 ⑩：数据面主体列（org）───────────────────────────────────────────────
  // 为什么这条必须是**静态门禁**而不只靠 dbt 测试：modules/data/domain/authz.ts 的 authorize()
  // **恒拼** `WHERE <主体列> = '<orgId>'`，而主体列写死为 `org`
  // （scripts/sync-data-semantics.mjs 的 L1_SUBJECT_COLUMN）⇒ 关系里少这一列，拼出的 SQL 必然以
  // 仓库错误（502）收场，而**静态看不出来**（旧状态正是这样活了很久，issue #176 缺口 A）。
  // 本规则只管**形状**（模型里有没有这一列）；**值非空**由 dbt 测试管（schema.yml 的 not_null）。
  // 设计：docs/superpowers/specs/2026-09-26-subject-org-column-design.md
  const subjectFiles = sqlFiles.filter((f) => STAGING_RE.test(f) || MARTS_RE.test(f))
  let subjectScanned = 0
  for (const rel of subjectFiles) {
    if (SUBJECT_ORG_EXEMPT.has(rel)) continue
    subjectScanned++
    const masked = maskSqlComments(readFileSync(join(rootDir, rel), 'utf8'))
    if (!SUBJECT_ORG_RE.test(masked)) {
      push(
        rel,
        0,
        'staging / marts 模型里没有主体列 `org`（须形如 `{{ subject_org() }} as org`，macro 见 dbt/macros/subject_org.sql）—— 行级授权的谓词是 `WHERE org = <orgId>`（modules/data/domain/authz.ts 恒拼），关系里少这一列 ⇒ 查询必以仓库错误（502）收场。设计见 docs/superpowers/specs/2026-09-26-subject-org-column-design.md',
      )
    }
  }
  // 空转自检：规则什么都没扫到（或全落豁免里）= 它存在与否没有区别 ⇒ 判违规
  // （形态同 check-tenant-isolation.mjs 的空转自检）。
  if (subjectScanned === 0 || SUBJECT_ORG_EXEMPT.size >= subjectFiles.length) {
    push(
      DBT_DIR,
      0,
      '主体列门禁没有扫到任何模型（或全部落在豁免名单里）—— 规则空转 = 门禁不存在，判违规：改扫描面或收窄豁免名单',
    )
  }
```

- [ ] **Step 6: 跑 fixtures，确认全绿**

```bash
pnpm run test:guard
pnpm exec tsx scripts/check-data-models.mjs
```

Expected: 两条 exit 0，且格⑩ 五格全绿。其中「真仓自检」那条用例（跑真仓、要求干净）能绿，
正是因为 Task 1 已经让真实模型带上了 `as org` —— 两个任务**顺序不能倒**。

- [ ] **Step 7: commit**

```bash
git add scripts/check-data-models.mjs scripts/check-data-models.test.ts
git commit -m "feat(guard): check-data-models 加主体列门禁——staging/marts 必须有 org（Refs #N）"
```

---

### Task 3: 陈旧的「marts 行里的 org 列」叙述收口

**Files:**
- Modify: `dbt/README.md:215-217`
- Modify: `dbt/macros/generate_schema_name.sql:16-18`
- Modify: `scripts/sync-data-semantics.mjs:18-22`
- Modify: `docs/superpowers/specs/2026-09-26-subject-org-column-design.md`（§2.3 扫描面措辞）

**Interfaces:**
- Consumes: Task 1（列已落地）、Task 2（门禁已守）。
- Produces: 无对外接口；本任务是文档一致性。

- [ ] **Step 1: 三处**（逐处照做，不要把「目标形态」留成已实现）

1. `dbt/README.md:215-217` —— 原文断言「模块里的 `identity.orgId`、**marts 行里的 `org` 列**、数据面 schema 三者同源」。
   在该句后补一句：
   `（\`org\` 列已随 spec 2026-09-26-subject-org-column-design 落地：dbt 侧由 \`dbt/macros/subject_org.sql\` 注入，静态门禁见 \`scripts/check-data-models.mjs\` 规则 ⑩）`
2. `dbt/macros/generate_schema_name.sql:16-18` —— 同句注释，同样补一句指向 `subject_org.sql`。
3. `scripts/sync-data-semantics.mjs:18-22` —— 头注「⚠️ 物化出来的行在**真库上目前跑不通**（已知边界，issue #176）」，
   改为：

```
// ── ⚠️ 主体列已补、但**真库验证尚未做**（issue #176 缺口 A 的仓内那半已落地）─────────────
// `dbt/models/**` 已由 macros/subject_org.sql 注入 `org` 列，authorize() 拼的
// `WHERE org = '<orgId>'` 因此有了着力点。**但真库出数的验收归 spec B**
// （docs/superpowers/specs/2026-09-26-subject-org-column-design.md §4）——
// 本机没有 dbt/pg_duckdb，别把「静态门禁绿」读成「真机跑过了（2026-09-26 状态）。
```

- [ ] **Step 2: 订正 spec §2.3 的扫描面措辞（一条，保持文档与代码同源）**

实施时把扫描面放宽到了**全部 marts 模型**（不只 `fct_*`）——主数据维度表同样按租户物化，将来第一个
`dim_*` mart 若逃检，就是同族缺口。把 spec 里那句

> `dbt/models/**/marts/fct_*.sql` 与 `dbt/models/**/staging/stg_*.sql`

改成

> `dbt/models/**/marts/*.sql`（含 `fct_*` 与将来的 `dim_*`）与 `dbt/models/**/staging/stg_*.sql`

- [ ] **Step 3: 全量门禁 + 类型 + 提交**

> ⚠️ **`dbt/README.md` 与 `dbt/macros/generate_schema_name.sql` 也在投递清单里**（`dbt/**`）
> ⇒ 本任务同样要重跑投递 lock（同 Task 1 Step 8；2026-09-26 实测第二次踩到）：

```bash
pnpm exec tsx scripts/lemeng/data-plane-lock.mjs   # dbt/** 改了就必须重跑（见上）
pnpm exec tsx scripts/check-manifests.mjs
pnpm exec tsx scripts/lint-architecture.mjs
pnpm exec tsx scripts/check-compose.mjs
pnpm exec tsx scripts/check-env-example.mjs
pnpm exec tsx scripts/check-data-models.mjs
pnpm exec tsx scripts/check-data-plane-lock.mjs
pnpm exec tsx scripts/check-tenant-isolation.mjs   # 需 DATABASE_URL，缺库即 exit 1（见下）
pnpm typecheck
pnpm run test:guard
```

Expected: 全 exit 0。`check-tenant-isolation` **本机可能因缺 `DATABASE_URL` 而 exit 1**——那是
它的设计（判据是「真库里每张表都有 org 列」，不静默跳过），由 CI 的 `gates` job 带 PG 跑；**不许**因此跳过它。

```bash
git add dbt/README.md dbt/macros/generate_schema_name.sql scripts/sync-data-semantics.mjs \
        docs/superpowers/specs/2026-09-26-subject-org-column-design.md
git commit -m "docs(data-stack): 收口 marts org 列的陈旧叙述 + spec 扫描面订正（Refs #N）"
```

---

## 交付与交接

- [ ] **开 PR**（一个 PR 装三个提交；squash 合并）

```bash
git push -u origin <分支名>
gh pr create --title "feat(data-stack): 数据面主体列 org 落地 + dbt 侧门禁（Closes #N）" \
  --body "Closes #N
设计：docs/superpowers/specs/2026-09-26-subject-org-column-design.md
本机验证：check-data-models / test:guard / typecheck / 七道守卫（check-tenant-isolation 本机缺 DATABASE_URL，交 CI）
**未验**：dbt parse 与真库出数（本机无 dbt/pg_duckdb）⇒ 归 spec B 的 Step 0
Refs #176"
```

- [ ] **合并顺序（与 spec B 的接口，spec §3 已写死）**：本 PR 合入后，生产物化 job 会因缺
  `LEMENG_SUBJECT_ORG` **响亮失败**（告警会响）。⇒ **先由 spec B 侧补 job env（幂等、无害），再合本 PR**。
  若接受一次告警，则不必倒序。

- [ ] **交接给 spec B 的三件事**（不在本计划内，别在本 PR 顺手做）：
  1. 用现成容器跑一次 `dbt parse`（顺带核 `LEMENG_SUBJECT_ORG=` 空串时是否命中 macro 的报错）
  2. 生产 job 补 `LEMENG_SUBJECT_ORG`（值 = 该部署租户的 `casdoor_org`，经 openship env）
  3. 真库出数验收（L1 指标不再 502）

---

## Self-Review（写计划后自查）

**Spec 覆盖**：spec §2.1 macro → Task 1 Step 1 ✓；§2.2 范围（三 staging + marts + 豁免）→ Task 1 Step 2/4 + Task 2 Step 4 豁免名单 ✓；
§2.2 列序 → Step 2 逐字给出 ✓；§2.3 门禁三判据 + fixtures → Task 2 ✓；§2.3「刻意不做」的单值 singular test → 未写入（**有意**，spec 明确不做）✓；
§2.4 五处订正 → Task 1 Step 3（三处）+ Step 5（schema.yml:30）+ Task 3 Step 1（另三处）✓；
§3 合并顺序 → 交接节 ✓；§4 验收命令 → 各任务 Step 与 Task 3 Step 3 ✓；§5 非目标 → Global Constraints 逐条挡住 ✓；§6 未验清单 → 交接节 + Task 1 Step 7 的绿语义说明 ✓。

**占位符扫描**：无 TBD/TODO；`#N` 是「Step 0 开 issue 后填入」的显式指代（有 Step 0 兑现），不是待定；所有代码块都是可粘贴的完整内容。

**一致性**：宏名 `subject_org()` 在 Task 1/2/3 里同名同形；env 键 `LEMENG_SUBJECT_ORG` 全文逐字一致；
门禁常量名 `MARTS_RE` / `SUBJECT_ORG_RE` / `SUBJECT_ORG_EXEMPT` 在 Task 2 定义、Task 2 用例与 Task 3 订正里引用一致；
豁免文件名与真实路径逐字一致（`dbt/models/common/staging/stg_lemeng_retail_detail.sql`）。

**与 spec 的一处有意偏差**（已在该处写明并在 Task 3 Step 2 回写 spec）：扫描面由 `marts/fct_*.sql` 放宽为 `marts/*.sql`。
