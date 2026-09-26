# 数据面主体列（`org`）落地设计（issue #176 · 架构 §2.2 末注「缺口 A」）

> **一句话**：给 dbt 的 staging / marts 模型注入一列 `org`（值 = 该部署租户的 `casdoor_org`），
> 让 `modules/data` 的行级授权谓词在数据面上**真的有着力点**。
>
> **本 spec 只做仓内那半**（模型 + 门禁 + 订正）。真机验证（`scope` 回读 / 凭据负测 / `#175` 桶策略裁决）
> 与**生产物化 job 的变更**归**同批的 spec B**——两半性质不同（有门禁可守、可本机验 vs 只能真机验），
> 验收标准天然分开；两半**无共享文件**，可并行。
> ⚠️ **spec B 尚未落仓**（本文件先落）；它落仓时回填文件名与本文件的互指。

上位依据：`docs/architecture.md` §2.2 末注（2026-09-26 订正）「缺口 A」；issue #176「缺口 A」段。
同批订正还把「AI 洞察」的入口口径改了（授权内直读数据面）——**本 spec 不改那条**，但它让本 spec 更硬：
入口一放开，行级授权就成了可见范围的**唯一着力点**。

---

## 0 已拍板的决策（2026-09-26，用户确认）

| # | 决策 | 为什么 |
|---|---|---|
| 1 | **拆两份 spec**：A 仓内（本文件）/ B 真机 | A 有静态门禁可守、本机可验；B 的结论（`scope` 验通不通）可能触发改造 ⇒ 混在一份里会让 A 的验收被 B 阻塞 |
| 2 | `org` 值走**新 env 键** `LEMENG_SUBJECT_ORG`；**缺失或为空 ⇒ 响亮失败** | fail-closed。**空串不是 NULL** ⇒ 若允许空串，「配了但配错」会变成静默的空 `org`：写入侧看着成功、读取侧 `where org = $1` 一行都查不到（与 `check-tenant-isolation.mjs` 里那条「可空 org 会静默消失」同族，只是更难查） |
| 3 | 改生产 job（补 env）**归 spec B**；**A 不碰生产** | A 保持纯仓内。安全前提：决策 2 让「没配」= **响亮失败**，A 先合入**不会**留下静默坏态 |
| 4 | 注入点做成**单定义点 macro**，不散写 5 处 | 散写时「空串」这条断言要复制 5 份；且与 `generate_schema_name.sql`（schema 名的唯一定义点）同风格 |
| 5 | staging **也加**（不只 marts） | ③「明细层开成直读视图」若只有 marts 带 `org`，明细探索没有行级锚点。现在加是一行 macro，将来补要把整条链再动一遍 |

---

## 1 现状事实（逐条带出处）

1. **授权谓词恒拼、不检查目标关系有没有那一列**：`modules/data/domain/authz.ts:142-148` 拼
   `<selectSql> WHERE <subjectColumn> = '<orgId>' [AND 过滤] [GROUP BY …] LIMIT n`；`subjectColumn`
   来自 `data.metrics.subject_column`（`metric-store.ts:45`），而 L1 行由
   `scripts/sync-data-semantics.mjs:66` 的 `L1_SUBJECT_COLUMN = 'org'` 写死。
2. **真实 mart 没有 `org` 列**：`dbt/models/common/marts/fct_retail_sale.sql:63-71` 的输出只有
   `system_book` / `bizday` / `net_amount` / `order_count`（**4 列**，我自己看过）。
   ⇒ L1 指标一旦被消费通道加载，拼出的 SQL 必然以仓库错误（502）收场。仓内已逐字承认这条：
   `scripts/sync-data-semantics.mjs:18-22` 头注「物化出来的行在**真库上目前跑不通**（已知边界，issue #176）」。
3. **契约里没有 `org`**：`contracts/common/lemeng.retail_order_line.json` 的 `columns` **18 列**，
   逐名核对**不含 `org`**（`batch_id` 与 `system_book` 已在其中：前者是采集 run id，
   后者是采集侧按账套常量注入）。
   ⇒ `org` 是 **dbt 层的注入列**，**不是契约列** ⇒ **不改 `contracts/`**。
4. **注入字面量在 staging 已有先例**：`stg_lemeng_retail_detail.sql:74` 用
   `'{{ var("account_book") }}' as system_book`（旧湖路径非 hive、账套位无键名 ⇒ 只能由 var 供值）。
5. **「契约 N 列全带」的声明散在三处、用词不同**（订正时要逐处改，别只改一处）：
   `stg_lemeng_retail_order_line.sql:56`（「契约 18 列**全带**（一对一不许丢列）」）、
   `stg_lemeng_branch.sql:17`（「16 列全带」）、`stg_lemeng_item.sql:17`（「108 列全带」）；
   另有 `staging/schema.yml:30`（「…（18 列）为准」）。
6. **两处注释已把「marts 行里的 `org` 列」当既成事实写**，与实现不符（本 spec 落地的同时改掉它们）：
   `dbt/README.md:215-217`、`dbt/macros/generate_schema_name.sql:17`。
7. **现有门禁对 marts 无话可说**：`scripts/check-tenant-isolation.mjs` 的扫描面**只有**
   `modules/<模块>/<migrations 目录>/*.sql`（`:343-375`），`dbt/` 结构性不在内；dbt 侧另一条门禁
   `scripts/check-data-models.mjs` 的**九条规则**（①–⑨）**没有一条**涉及 `org` 列。
8. **生产物化 job 不传租户 var**：`deploy/data-plane-deploy-sop.md` §F.6 记的实测口径是
   `docker run … platform-core-dbt:local build … --select stg_lemeng_retail_order_line stg_lemeng_branch
   stg_lemeng_item fct_retail_sale`，**没有 `--vars '{tenant: …}'`**；且该 job 的命令**只活在 openship 里**
   （同节末尾「遗留（已知，不阻塞）」）。
9. **`org` 的值不是枚举、也不是数据列**：它是**该部署租户的身份键** `platform.tenant.casdoor_org`
   （取值口径与取法见 `dbt/README.md` §10，**值本身不进仓、不进文档**）。账套（`system_book`）**不是**租户
   ——正典 `docs/superpowers/specs/2026-09-24-lemeng-collection-pipeline-design.md:50-53`「**账套 ≠ 租户**：
   账套是租户内的数据主体」。

---

## 2 设计

### 2.1 注入点：单定义点 macro `dbt/macros/subject_org.sql`

```jinja
{# subject_org — 数据面主体列（org）的唯一定义点。
   值 = 该部署租户的 casdoor_org，经 env 注入（不落仓、不进 argv）。
   fail-closed 两道：env_var 未定义 ⇒ dbt 自身报错；定义为空串 ⇒ 本 macro 报错。 #}
{% macro subject_org() -%}
    {%- set o = env_var('LEMENG_SUBJECT_ORG') | trim -%}
    {%- if o == '' -%}
        {{ exceptions.raise_compiler_error(
            "LEMENG_SUBJECT_ORG 为空：org 是行级授权的主体列，空串不是 NULL —— "
            ~ "它会静默写进行里，让 `where org = $1` 一行都查不到（写成功、读不到，最难查）。"
            ~ "把该部署租户的 casdoor_org 配进 env 再跑。") }}
    {%- endif -%}
    '{{ o }}'
{%- endmacro %}
```

**为什么必须有这个 macro（而不是每处写 `env_var(...)`）**：dbt 的 `env_var('X')` 在 **X 未定义**时
报错，但在 **X 已定义且为空串**时**正常返回 `''`** ⇒ 那种形态把「配了但配错」放行成静默空 `org`。
空串断言只有一处才守得住，所以收成单定义点——与 `dbt/macros/generate_schema_name.sql`
（schema 名的唯一定义点）同一风格。

**与 `var('tenant')` 的关系（刻意解耦）**：`var('tenant')` 决定**物化落点**（schema 名，见
`generate_schema_name.sql`），`LEMENG_SUBJECT_ORG` 决定**行内主体**。两者在多租户跑法下同源，
但**单租户（P1 私有化）跑法下必须分叉**——那份配置**不给** `tenant` var 是**合法形态**
（`dbt/README.md:229-230`「不给 var ⇒ 逐字回到 dbt 内置行为」），而 `org` 列**任何时候都必须有值**。
⇒ 不用 `var('tenant')` 承担 `org`，**不打破** P1 既有跑法（这是决策 2 选 env 键而非 var 的真正原因）。

### 2.2 范围：新湖三个 staging + marts；旧湖 detail 显式豁免

| 模型 | 改法 |
|---|---|
| `stg_lemeng_retail_order_line` | 加一列 `{{ subject_org() }} as org` |
| `stg_lemeng_branch` | 同上 |
| `stg_lemeng_item` | 同上（108 列 → 109） |
| `fct_retail_sale` | 加一列 `{{ subject_org() }} as org`（**注入常量，不从 staging 透传**——理由见本节末的**2026-09-26 实施订正**） |
| `stg_lemeng_retail_detail` | **豁免**——旧湖、待退役、且自身列集是暂定（该文件头注「列全集按 T6 实测样本补齐」） |

**豁免必须显式登记在门禁规则里**（文件级白名单 + 注释写明理由），不许靠「没扫到」——本仓既有先例是
`check-tenant-isolation.mjs` 的 `--global-table:` 标记与 `lint-architecture` 的白名单。

**列的位置**：**staging 里紧随 `system_book` 之后**（`stg_lemeng_item.sql` 头注即写「**3 注入列** +
89 标量列 + 16 摊平列」，注入列在前是既有排布）；**marts 里同样紧随 `system_book`**。`schema.yml`
的列清单（`staging/schema.yml` / `marts/schema.yml`）要同步登记，含 `not_null` 测试。

> **2026-09-26 实施订正（计划 Task 2 实测）**：marts **不用透传、改为注入常量**，即
> `select system_book, {{ subject_org() }} as org, bizday, …`（且 `org` **不进 GROUP BY** —— 常量不必进）。
> 两个理由：① §2.3 的判据是**单一形状** `as org`，透传形态（裸 `org,`）**守不住**它；
> ② **模型自足**：新加 marts 模型时不必先确认上游 staging 有没有那一列。
> 同一轮运行里 macro 取的是同一个 env ⇒ 与 staging 的 `org` **恒等**，不存在两份值。
> ⇒ 本条是**计划的自相矛盾**（Task 1 写透传、Task 2 的判据按注入写）在规则上线时被门禁抓出来的结果。

**语义声明与 grain 都不动**：`l1_metrics.yml` 的 `grain: [system_book, bizday]` 保持；
`authorize` 拼出的 `… from fct_retail_sale WHERE org = '<orgId>' GROUP BY system_book, bizday`
在 `org` 列存在后是**合法 SQL**（WHERE 里是常量，不参与 GROUP BY）。`L1_SUBJECT_COLUMN='org'` 保持
——本 spec 正是让那个写死值**成立**。

### 2.3 门禁：静态管形状，dbt 测试管真值

**静态（`scripts/check-data-models.mjs` 加一条规则）**——判据三条：

1. **扫描面**：`dbt/models/**/marts/*.sql`（含 `fct_*` 与将来的 `dim_*`——主数据维度表同样按租户物化）
   与 `dbt/models/**/staging/stg_*.sql`
   （沿用该文件已有的 `STAGING_RE` 形态，新增 marts 一条）。
2. **判据**：**注释掩码后**文本必须出现 `as org`（掩码口径沿用该文件实现判断①——注释里提一句
   `as org` **不算**满足，否则「写句注释就过关」）。
3. **空转自检**：扫到的文件数为 0、或豁免数 ≥ 扫描数 ⇒ **违规**（防「规则加了但没扫到」；
   形态同 `check-tenant-isolation.mjs:513-520` 的空转自检）。

**dbt 测试（真值面）**：`org` 列 `not_null`。**`accepted_values` 不适用**（值不是枚举，是租户键）。

**刻意不做**（列为后续加固，不在本 spec）：一条断言「单个 relation 内 `org` 单值」的 singular test。
理由：现有 `assert_fct_retail_sale_grain_unique`（`(system_book, bizday)` 唯一）在两个租户**共用同一账套**时
已经会红；而「两个租户各有各的账套」这种形态下它确实抓不住——**但那要等真有第二个租户的案例**
（无案例不立标准）。本 spec 把它写进「未验清单」而不是先写一条没案例的测试。

**fixtures 随门禁一起落**：`scripts/check-data-models.test.ts` 加三个用例——正例（含 `as org`）、
反例（缺列 ⇒ 红）、假绿反例（只在注释里出现 `as org` ⇒ 仍红）。

### 2.4 跟着订正的**五处**（否则文档与实现又对不上）

| # | 位置 | 订正 |
|---|---|---|
| 1 | `stg_lemeng_retail_order_line.sql:56` | 「契约 18 列**全带**」→ 补「**+ dbt 注入列 `org`**（第 19 列，非契约列）」 |
| 2 | `stg_lemeng_branch.sql:17` / `stg_lemeng_item.sql:17` | 同上（16 列 / 108 列各补一句） |
| 3 | `staging/schema.yml:30` | 同处「（18 列）为准」补注入列说明 |
| 4 | `dbt/README.md:215-217` + `dbt/macros/generate_schema_name.sql:17` | 「marts 行里的 `org` 列」由**目标形态**改成**已落地**（并指向本 spec） |
| 5 | `scripts/sync-data-semantics.mjs:18-22` | 头注「真库上目前跑不通（issue #176）」→ 收口：列已补，**真库出数的验收归 spec B**（别把这句话留成「已修」而实际没跑过） |

---

## 3 与 spec B 的接口

| | spec A（本文件） | spec B |
|---|---|---|
| 产出 | 模型 + macro + 门禁 + 订正 | 真机 `scope` 回读 + 凭据负测 + `#175` 桶策略裁决 + 凭据面接进 `reconcile` |
| 碰生产 | **不碰** | 补 job env `LEMENG_SUBJECT_ORG` + 跑一轮 + 真库出数验收 |
| 验收 | 门禁 + 守卫单测全绿（本机） | 真机可观测结论 + 裁决记录 |

**合并顺序（我建议的倒序，需你确认）**：A 合入瞬间，生产物化 job 因缺 `LEMENG_SUBJECT_ORG` 会
**响亮失败**（告警会响）。为把红窗压成 0，建议 **B 侧先补 job env（幂等、无害——补完那一刻还没人读它）→
再合 A**。若不接受这个顺序依赖，就接受一次告警：fail-closed 的代价本身就是它的价值（宁可红，
不要静默空 `org`）。

---

## 4 验收（本机可跑的逐字命令）

```bash
# 1) 门禁本体（含新规则的 fixtures 之前，先单独跑它）
pnpm exec tsx scripts/check-data-models.mjs
# 2) 守卫单测 = `vitest run --dir scripts`（package.json:12 的 test:guard）
#    —— fixtures 的正例 / 反例 / 假绿反例都在这里
pnpm run test:guard
# 3) 全量门禁 + 类型（= CI 的 gates job 口径）
pnpm typecheck
for s in check-manifests lint-architecture check-compose check-env-example \
         check-data-models check-data-plane-lock check-tenant-isolation; do
  pnpm exec tsx scripts/$s.mjs
done
```

> **`check-data-models` 的 fixtures 落在 `scripts/check-data-models.test.ts`**（已被 `test:guard`
> 收进 `--dir scripts` 的扫描面）；新增规则若不带 fixtures，CI 的 `gates` job 不会因此变红
> ——所以 fixtures 是**本 spec 的实现项**，不是可选项。

**本机跑不了、必须留档的两项**：

- `dbt parse` / `dbt build`：**本机没有 dbt**（`dbt/README.md` 多处明写）⇒ 归 **B 的 Step 0**
  （用数据面机上现成的 `platform-core-dbt:local` 容器跑一次 parse）。**A 合入前不假装它跑过。**
- `check-tenant-isolation` 需要 `DATABASE_URL`（判据是「真库里每张表都有 org 列」，缺库即 exit 1
  ——`check-tenant-isolation.mjs:504-506`）⇒ 由 CI 的 `gates` job 带 PG 跑。

---

## 5 已知边界 / 非目标（明确不做）

1. **不给 marts 加 `org` 之外的维度**（星型维度键是 ③ 的事，本 spec 只补主体列）。
2. **不改 `contracts/`**：`org` 不是契约列（见 §1 事实 3）。
3. **不改 `L1_SUBJECT_COLUMN` / `grain` / `l1_metrics.yml`**（见 §2.2）。
4. **不碰生产 job、不跑真库**（决策 3；归 B）。
5. **不动 `scope` / 桶策略 / 凭据面**（`#174` / `#175`，归 B）。
6. **`org` 列的值不进仓、不进 argv、不进文档**——只以 env 键名与取法出现（`dbt/README.md` §10 的纪律）。

## 6 未验清单（本 spec 交付时仍未验的，别读成已验）

1. **`dbt parse` 是否通过**（macro 的 Jinja 形状）——本机无 dbt，归 B 的 Step 0。
2. **`env_var` 在「已定义但空串」时返回 `''` 而非报错**这一条是**依据 dbt 行为的判断**，未在本机实测
   ——它正是本 macro 存在的原因，B 的 Step 0 顺带核一次（把 `LEMENG_SUBJECT_ORG=` 空串喂进去，须看到
   本 macro 的那句报错）。
3. **单个 relation 内 `org` 单值**没有被任何测试断言（§2.3 的刻意不做）。
4. **旧湖 `stg_lemeng_retail_detail` 的豁免**是在「待退役」判断下的临时做法——退役那笔要顺手收回豁免。
