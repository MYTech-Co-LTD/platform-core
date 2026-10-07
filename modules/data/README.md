# modules/data — 数据问数域

三条消费通道、一个授权核心。设计见
`docs/superpowers/specs/2026-09-21-data-query-channels-design.md`，
实施见 `docs/superpowers/plans/2026-09-21-data-query-channels.md`。

- 授权核心：`domain/authz.ts`（纯函数，三通道共用，**不得**在别处再判一次权限）
- 通道差别只在鉴权中间件层：会话（宿主既有）/ PAT（`apps/server/src/pat-auth.ts`）/
  企微（`apps/server/src/wecom-channel-auth.ts`）
- env 键见根 `.env.example`（真值只在 openship env，本仓不写明文）
- 租户隔离键 = `org text not null`（值 = `identity.orgId`），三张表一律如此；机器判据见
  `scripts/check-tenant-isolation.mjs`（正典 `docs/module-protocol.md`「租户数据隔离」）

## 三通道怎么验（e2e 回归锁在哪）

三通道「一个授权核心」的端到端验证在 `apps/server/src/data-query.e2e.test.ts`
（真装配：buildApp + MockCasdoor + 双租户 + 真 pg 仓库；需 `DATABASE_URL`）：

| 用例 | 锁的不变量 |
|---|---|
| 1 | PAT 往返契约：模块路由（`POST /keys`）建的 key，宿主中间件**经模块端口**认下来——端口装配端到端 |
| 2/3/4 | 三通道（会话/PAT/企微）同一指标同一数据：subject 钉死 acme、行集**逐行一致**——任何通道拿到不同结果 = 授权核心被绕过 |
| 4 后半 | 企微未关联用户 → 401 `WECOM_USER_NOT_LINKED`（fail-closed 可解释拒绝） |
| 5 | 主体钉死：三通道在 `args` 里塞 `org` → 403 `subject_pinned_by_platform`，回包无 beta 数据 |
| 6 | 词表裁剪：`data:finance` 指标在 GET /metrics（A/C）与 tools/list（B）都不出现 |
| 7 | 审计三通道统一：ok 记录共写一张表、org 全为 acme——参数里的 beta 从未变成审计主体 |
| 8 | 宿主声明门卫仍然生效（`/metrics/all` 要 `data:manage`，403 带 `need`；差分 200） |
| 9 | 空身份打 `/query` 与 `/mcp` tools/call → fail-closed 401 可解释拒绝 |

改授权核心、三通道中间件、manifest 声明或宿主装载器门卫时，这份文件是回归底线；
其中用例 8 同时锁着 issue #145（param 门卫误伤静态兄弟路径）的修复。

## L1 / L2 两层语义（#150 T8）：谁定义、谁能改

| | **L1 平台语义** | **L2 租户语义** |
|---|---|---|
| 谁定义 | 我方（产品能力） | 租户管理员（`data:manage`） |
| 事实源 | `dbt/semantics/l1_metrics.yml`（进仓库，走 PR） | `data.metrics` 里的 `source='l2'` 行（**永不进 git**） |
| 落库 org | `platform`（固定桶名，不是 env 的 `PLATFORM_ORG`） | 该租户的 `identity.orgId` |
| 改它的唯一途径 | 改 dbt 声明 → 重跑 `scripts/sync-data-semantics.mjs` | 管理 API（`POST`/`PUT /metrics`） |
| 表达力 | 口径本体（expression / grain / tier / owner / definition） | **只能**裁剪/别名/过滤（不能改口径、不能写 SQL） |

- **写入口是分开的两个函数**（不是一个带 `source` 形参的函数）：`upsertMetric`（租户路径，写死
  `l2`）与 `upsertL1Metric`（物化路径专用，写死 `l1`）。⇒ `grep upsertL1Metric` 就能穷举
  「谁在写平台词表」，也不存在「漏传来源 ⇒ 静默标错」这个失败态。
- **唯一编译点**：`domain/semantic-compiler.ts`。L2 的入参是租户数据，任何第二处「顺手拼 SQL」
  都是注入面 ⇒ 全仓只有它把声明变成 SQL。产物形状见该文件头的「形状契约」节
  （`select <表达式> as value[, <维度>] from <关系>`，`domain/authz.ts` 直接在其后续 `WHERE`）。
- 管理 API 的 body **`.strict()`**：带 `selectSql` / `subjectColumn` / `groupBy` / `params` /
  `source` 一律 **400**（不是忽略——静默忽略会让调用方以为自己的 SQL 生效了）。
- catalog 加载 = **L1（platform）∪ L2（本 org）**；同 id 撞上时 **L1 赢**（写侧另有一道 409
  `ID_RESERVED_BY_L1` 闸）。
  - 这句话对**四条消费面全部成立**（T8 评审 C1 的整改点）：`POST /query`、MCP `tools/list`、
    chat、`GET /metrics` 共用**同一个**加载器 `loadMergedCatalog`——四条各自加载就会漂
    （C1 的实况：3/4 条用了只回本 org 的 `loadOrgCatalog`，于是同一个 metricId 在
    console 上显示平台口径、在 `/query` 上跑租户那条 SQL，且无任何可观测信号）。
    机器判据：`modules/data/catalog-consumers.test.ts`（四通道一致性 + 来源守卫）。
  - ⚠️ **可见 ≠ 查得通**：~~marts 还没有 `org` 列 ⇒ L1 指标在真库上会以仓库错误（502）收场，
    见下面「L2 的已知边界」第 4 条与 issue #176。~~
    **2026-09-28 订正：这一条已闭合**——`macros/subject_org.sql` 已给 staging/marts 注入 `org` 列，
    真机上 L1 指标**查得通**（`POST /query lemeng:retail:net_sales` → 200 / 8 行 / `subject=shanhaiyiguo-org`）。
    ⚠️ 但**必须有另外两步接线**才查得通，两者失败都静默：① Gate-B 网络（SOP P7）；
    ② 仓库连接的 `search_path`（SOP P8b）——不设则报 `relation "fct_retail_sale" does not exist`。

### 源维度（spec §3⑧ / 计划 5）：裁剪 + 写入闸，两道缺一不可

L1 **不是跨源通用语义**，是**逐源**的标准口径 ⇒ 词表行的第二维是**源**（库列 `source_system`；
`MetricRow.sourceSystem`）：**L1 行** = 声明的 `source`（如 `lemeng`），**L2 行 = `null`**（本租户
自己写的，没有源维度）。「某租户接了哪些源」这条事实由宿主投影（`platform.tenant_source` 里
`enabled=true` 的集合 → context 键 `TENANT_SOURCES`；模块 manifest 声明 `tenantSources: true`）。
投影的契约（含「模块靠自身中间件授权会读到 `undefined`」那条边界）在 `docs/module-protocol.md`
的「租户级源投影」节，**本文不复述**。

**三个都叫「source」的东西，别混**（认错一个就静默错位）：

| 名字 | 在哪 | 含义 | 必填 / 门禁 |
|---|---|---|---|
| `source` | `dbt/semantics/l1_metrics.yml`（**逐 metric、单值**） | **源系统**（如 `lemeng`）——这条口径的数据来自哪个源 | **必填**、静态门禁校验、**落库**、参与裁剪与写入闸 |
| `sources` | 同上（**逐 metric、列表**） | 该指标背后**实际读的对象存储路径** | **选填**、**人读**、不落库、**无门禁** |
| `source` | **`data.metrics` 的列** | `'l1'` / `'l2'`（这行是平台物化还是租户派生） | DB 列，与上面两个**不是一回事** |

⇒ 源维度的库列名是 **`source_system`**——**不叫** `source`，那个名字已被 `l1`/`l2` 占用。

**命名 `<源>:<业务域>:<指标>`**（三段式，如 `lemeng:retail:net_sales`）：`(org, id)` 主键下，
**带源段**才能让**第二个源**用同一个业务概念名声明而不撞键（spec §3⑧ 实测：`retail:net_sales`
在第二源上直接 `duplicate key`）。三段都小写蛇形；正则的**唯一事实源**是
`scripts/check-data-models.mjs` 的 `METRIC_NAME_RE`（`scripts/sync-data-semantics.mjs` 另有一份
逐字相同的兜底），对账文件名由 `metricToAuditFileName()` 的 `:`→`__` 映射派生。

- **源登记 ↔ 契约 `domain` 只约定「同名」**：登记值（`platform.tenant_source.source`）与被引用契约
  的 `domain`（如 `domain: lemeng`）要求**逐字同名**，但**本计划不做自动映射/校验**——契约 `domain`
  与指标命名空间的**业务域段**（`retail`）**本来就不是一回事、全仓无映射**（spec §7 待办 6 实测）。
- **改名的数据侧影响**（Task 4 实测口径）：**既有 L2 行的 SQL 不动**——L2 落库的是**编译后的**
  `select_sql`，`data.metrics` **没有 `base_metric` 列** ⇒ 旧 L2 照跑；**只有** `description`
  文本里的「L2 派生自 <旧 id>」会陈旧（描述性文字，无功能面）。而 **MCP 工具名 = 指标 id**
  （`routes/mcp.ts`）⇒ 改名**对外可见**，属**预期**（agent 通路尚未上线，正是待办 7 的时机）。

- **裁剪**收口在**唯一**一处：`domain/authz.ts` 的 `visibleMetrics(catalog, requester, adoptedSources)`
  （第三参必填）。规则：`sourceSystem === null || adoptedSources.has(sourceSystem)` 与 scope 判定**同时**成立才可见
  ⇒ **L2 行恒可见**，未接入源的 L1 行**看不见**（不是报错）。四个消费方（`GET /metrics`、MCP
  `tools/list`、chat 的 `list_metrics`、`query_metric` 的解析路径）**都**经它；`tenantSources`
  的投影由**路由层**读（域层没有 Hono context，经 deps 穿下去）。
  机器判据：`catalog-consumers.test.ts`（四条面的行为断言 + 来源守卫）。
- ⚠️ **管理面例外**：`GET /metrics/all`（`data:manage`）**绕开裁剪**（直用 `loadMergedCatalog`，
  **不调** `visibleMetrics`）⇒ 持 manage 者会看到**未接入源**的 L1 行。这是**有意**的（管理面
  要能看全；写入闸 403 的回包也把 `its_source` 给了 manage 者）——别把「四消费方都经
  `visibleMetrics`」误读成「所有读面都被裁」。
- **写入闸**在 `routes/metrics.ts` 的 `writeL2`（`resolveL1Base` 之后）：用未接入源的 L1 当
  `baseMetric` ⇒ **403** `{ error: 'METRIC_SOURCE_NOT_ADOPTED', its_source, your_sources }`
  （`its_source` = 那条 L1 的源；`your_sources` = 本租户已接入的源）。只裁剪不装闸，则
  那条 L2 会**写入时看着成功、读取时被裁掉**——一次「成功的空操作」。
- **「未接入源」与「scope 不够」在通道上不区分**（人裁 2026-09-30）：`POST /query`（及 MCP
  `tools/call`、agent 通路）两种**都回 `metric_not_declared`**，理由 = **不泄漏存在性**——
  给出两种 reason 就把回包变成一条「这个指标存在、但你看不到」的探针。⇒ **别**从 `/query` 的
  reason 反推是哪一种。`authorize` 自身的 `metric_not_authorized` 分支仍在（`authz.test.ts`
  的 C2 钉着），但四条消费面都在它**之前**先按「scope + 源」裁掉 ⇒ **够不着**它。
- ⚠️ **无身份的 `GET /metrics` 是宿主门卫给的 401**（`declaredScopeGate` 的
  `UNAUTHENTICATED`，`packages/platform-sdk`），**不是模块判的**——本模块没有鉴权代码。
  模块内「空词表」那条分支只有 `identity.orgId === ''`（门卫放行之后）才够得着。
  这是 spec §3⑧ 记的那条 fail-open 的修法：**无身份 ≠ 没接入任何源**，前者必须 401。

### agent 接入面（#486 已落地）

两条通道，对 agent 与人**同形**（同一个 scope、同一份判定）：

| 通道 | 端点 | 门（由宿主按清单施加） |
|---|---|---|
| HTTP | `POST/PUT/DELETE /metrics` | `data:manage` |
| MCP 读面 | `POST /mcp`（工具名 = 指标 id，问数） | `data:query` |
| MCP 写面 | `POST /mcp-manage`（口径三工具 `list_metrics` / `customize_metric` / `delete_custom_metric` ＋ 报表三工具，见下节） | `data:manage` |

写面**单独一个端点**而不是把写工具塞进 `/mcp`：让「写所需的能力」继续出现在
`manifest.yaml` 里——清单是「声明即授权」的单一事实源。设计见
`docs/superpowers/specs/2026-10-07-mcp-write-face-design.md`。

「agent 只需产出可机检的声明、不必也不该生成 SQL」这条不变：`customize_metric` 的入参
与 HTTP 面同源（结构化声明），**`op` 由工具面固定为 `refine`**（工具面比 HTTP 面窄，是有意的）。

**两条已知边界**（别当漏检）：

1. **工具名与租户可自取的指标 id 理论上可能撞名**：写面工具叫 `list_metrics` 等，而 L2 的 id
   由租户取（≤64 字、无保留前缀约束）⇒ 某个租户起名成 `list_metrics` 时，**同一个 MCP 客户端**
   会看到两个同名不同义的工具。MCP 客户端按 server 命名空间隔离，故后果是「可能用错那一个」，
   不是安全面。本设计选择「把名字取成人话」而不是「保留前缀」（2026-10-07 人裁）。
2. ~~**写路径无审计**：创建/删除本租户口径**不落审计行**（查询有）~~
   → ✅ **已兑现（#489）**：见下面「语义追溯」一节。

### 语义追溯：操作人 / 版本 / 变更审计（#489）

| 面 | 载体 |
|---|---|
| **快查两列** | `data.metrics.updated_by` / `version`（每次经 API 写 `version` +1；`GET /metrics/all` 带出来） |
| **变更史** | `data.metric_audit`：每次建/改/删一行，含 `row_before` / `row_after` **行快照**（建无前态、删无后态 ⇒ 「从什么到什么」与「删了什么」都答得出） |
| **写入口** | **只有** `domain/metric-write.ts`——两条入口（HTTP 与 MCP 写面）都经它，审计与变更**同事务** |
| **读入口** | `GET /metrics/:id/audit`（门 = `data:manage`）；页面：指标页「最后操作人 / 版本」两列 + 「变更历史」抽屉 |

**顺带的结构约束**：写路径**无身份即拒**（`403 UNAUTHENTICATED`）——审计要记人，写一条「无主」的
审计等于没记。这条由 `MetricWriteDeps.requester` **必填**在编译期兜底。

**为什么审计另立一张表、不并进 `query_audit`**：那张表的列是**查询语义**（`row_count` / `verdict` /
`reason`），硬塞写行会让三列全部变 nullable ——「没有 row_count」将同时表示「这是写行」与
「这次查询没出数」，语义立刻模糊。「同一张审计面」的精神是**一个查询入口**，不是物理同表。
⚠️ `domain/audit-store.ts` 保持**只写不读**（它的读侧＝平台运营面的全局视图，不在本模块）；
新增的读侧是**租户对自己单条口径的历史**，写与读都在 `domain/metric-audit-store.ts`。

**三条边界**（都不静默，只是明确不做）：

1. **审计表随时间增长**——本设计不清理（无案例）。量级只随**写**增长（低频，不是问数那种高频路径）；
   若将来成问题，另立「审计保留」议题。
2. **L1 无追溯**：平台口径由 `scripts/sync-data-semantics.mjs` 物化，它的变更史在 **git**
   （仓内 dbt 声明 + PR）。页面上以「平台物化（追溯走 git）」显式说明，而不是留空白
   （空白会被读成「这里缺数据」）。
3. **无回滚**：本机制只做**可追溯**，不做撤销/回滚。

### 报表工具面：能提、不能发（#496 已落地）

写面端点上追加的**报表三工具**（与口径三工具同端点同门，`/mcp-manage`）：

| 工具 | 干什么 | 结构约束 |
|---|---|---|
| `list_reports` | 管理清单（标题/渲染器/**页门**/版本/面板数）——提议前查重用 | —— |
| `propose_report` | 建一张平台自绘报表（`renderer='platform'`） | **不收 `requiredScope` 入参**，平台强制写 `data:manage` ⇒ agent 造不出「已发布」；走**原子 create-only**，撞名即拒 `TITLE_TAKEN`（不会改写既有行） |
| `revise_report_spec` | 改**未发布**报表的规格，带 `expectedVersion` | **先读页门，已发布 ⇒ 拒 `PUBLISHED_REPORT`**；与 HTTP 面同 key 对象锁 |

「能提、不能发」的三条结构落点（设计稿 `docs/superpowers/specs/2026-10-07-report-agent-toolface-design.md` §3.3）：
①建报无页门入参 ⇒ 造不出已发布；②已发布报表的规格改动不经 agent；③**发布/回收在工具集里根本不存在**——
不靠提示词，靠结构。

**为什么 create-only 是必须的**：`POST /reports` 的冲突键是 `(org, title)` do update——同名「新建」会**改写既有行**
（含页门重置）。若那张已发布，它会静默从员工视野消失。`upsertReport` 的 `'create-only'` 模式就是为堵这个洞。
代价：agent 不能用同一个 title 迭代同一张报表（改名或走 `revise_report_spec`）——有意取舍。

**边界与约定**：

1. **`data:manage` 作为「未发布」页门值是约定，不是新机制**：借用既有「页门 = 一个 scope」语义
   （只有持 `data:manage` 的人能在观看面看到）。发布 = 人在 console 清空页门。
2. **工具面不含发布 / 回收 / 删除**：删除另有缺口（`DELETE /reports` 的 Metabase 配置检查先于 id 解析，
   自绘行在没配 Metabase 的环境删不掉）——见 issue **#494**，未排期。
3. **未验**：真实 MCP 客户端在本端点工具数涨到 **6**（口径三 + 报表三）后的表现（分页/工具上限）——没拿真客户端连过。

### L2 的已知边界（本轮**未**做，别当成漏检）

1. **`target`（目标值）无存储面**：`data.metrics` 没有对应列（003 只加了 `source`），
   故管理 API 对入参里的 `target` 返回 400 `TARGET_NOT_SUPPORTED`——**显式拒绝，不静默丢弃**。
   补它需要一次迁移（加列）或把它归入 dbt 声明。
2. **平台超管那一半没有门可落**：拍板 #5 说「租户管理员 **+ 平台超管**均可定义」，
   并要求「沿用平台既有信号、勿新造第二套超管判定」。核对结果：仓内**唯一的**平台内置码是
   `tenant:admin`（`apps/server/src/loader.ts:137`），而它是**租户级**的——按
   `tenant.casdoor_org` 分桶、`apps/server/src/routes/admin.ts:55` 的 `requireScope('tenant:admin')`、
   console 管理区 `/console/admin/*` 也都是租户管理域。⇒ 本轮**只**实现租户 `data:manage`
   管本 org 的 L2；`org='platform'` 的 l2 行（全租户可见的平台级派生）**暂不开口**（fail-closed）。
   ⚠️ **不许**拿 `tenant:admin` 兼作平台门：那会给租户引入跨租户写能力。
3. **`tier` / `owner` / `sources` 不落库**：`data.metrics` 没有对应列。它们仍是治理面的事实源
   （在 dbt YAML 里），只是不在这张表上体现。⚠️ 三者的门禁强度**不同**：`tier` / `owner` 被静态
   门禁规则 ⑤ **强制必填**（`REQUIRED_METRIC_FIELDS`），而 **`sources` 是选填**（人读的对象存储
   路径，无门禁，见上「三个都叫 source 的东西」表）。⚠️ 与源维度**落库**的那个 `source`（单值，
   → 列 `source_system`）不是一回事。
4. ~~**L1 物化的行在真库上还跑不通**：`dbt/models/**` 当前**没有 `org` 列**，而 `authz.authorize`
   恒拼 `WHERE <主体列> = '<org>'` ⇒ 这些 L1 指标的查询要等 marts 补上 org 列
   （`dbt/README.md` §10 与 `macros/generate_schema_name.sql` 头注把「marts 行里的 org 列」
   写成了**目标形态**，尚未落地）。**物化行先落、真跑等后续**——这是计划 Task 8 的既定取舍。~~
   **✅ 2026-09-28 实测闭合**：`macros/subject_org.sql` 已注入 `org` 列，物化行带
   `org = shanhaiyiguo-org`，`POST /query` 真库出数（`lemeng:retail:net_sales` 200 / 8 行、
   `lemeng:retail:order_count` 200 / 8 行，数值与直连仓库逐字一致，回包带 `subject`）。
   ⚠️ **但它依赖两条部署侧接线，两者失败都静默**：Gate-B 网络（SOP P7）与仓库连接的
   `search_path`（SOP P8b）——少了任一条都会以「仓库错误」收场。见 **#297**。

## 报表面（Metabase 嵌入；issue #150 / T7）：`tenant` 参数约定

报表本体在 Metabase、登记在平台（双写面）⇒ 平台是**唯一的鉴权与定租户点**
（AI 侧的语义层自身不带权限，spec §11.3.1）。嵌入走的 signed embedding，权限**双门分开**：

| 门 | 管什么 | 落在哪 |
|---|---|---|
| 页门 | 「谁**能看**」 | 本模块的 platform scope（宿主按 manifest 施加）：制作/登记/对账 `data:manage`，观看面 `data:query` |
| 数据门 | 「看**哪个租户的数据**」 | 嵌入 JWT 里 `locked` 的参数值，由 `GET /reports/:id/embed-url` **现签** |

### 管理面（改页门 / 发布 / 回收）：动作都在平台，**没有独立的 published 状态**

「未发布」不是一种状态位，而是**页门未放行在观看面的表现**（`data.reports` **没有** `published`
列，也不打算加）：

| 动作 | 怎么做 | 端点 |
|---|---|---|
| 发布（所有人可见） | 把页门清空 | `PUT /reports/:id` body `{"requiredScope": null}` |
| 改页门（换成新 scope） | 换一个 scope 串 | `PUT /reports/:id` body `{"requiredScope":"sales:read"}` |
| 回收 | 归档 dashboard（`renderer='platform'` 的行**跳过归档**，只删登记行——它没有 Metabase dashboard） + 删登记行 | `DELETE /reports/:id`（既有） |

- **管理清单 `GET /reports/manage`**（`data:manage`）与观看清单 `GET /reports`（`data:query`）
  的分野是**行裁剪**：观看面按行 `required_scope` 过滤（`visibleTo`），管理面**不裁**——
  页门未放行的行对管理员必须可见、可改，否则没人能把未发布的报表发出来。
- 跨租户 / 不存在的 id 一律 **404**（不给存在性探针）；`PUT` body 用 `.strict()`（多余键 400）。
- ⚠️ **写保护（陈旧版本写 409）已落地** —— 见下方「写保护：两条版本通路 + 每对象一把锁」小节（spec §8 步骤 2）。
- ⚠️ **入口可见性**：本模块 console 入口声明是单值 `data:query`（`manifest.yaml` 的
  `frontend.console`）⇒ 只持 `data:manage` 的人**看不到本模块入口**。这是模块入口的既有口径，
  非管理面引入；要改成「任一持有即可进」得先改宿主 `frontend.console` 的 scope 语义（架构先行）。
- ⚠️ **重登记会重置页门**：`POST /reports` body 的 `requiredScope` 缺省是 `null`（= 发布）⇒ 幂等重跑
  登记（部署注记里那条预期运维动作）会把**手工设好的页门静默清成「所有人可见」**。走过那条路径之后
  必须回管理面确认页门，或重登记时显式带上原 scope。（把「缺省」与「显式置 null」区分开是写路径的
  契约变更，见下方「写保护」小节的边界条（`dash:`/`row:` 键空间不相交）。）

### 写保护：两条版本通路 + 每对象一把锁（spec §3③）

| 写什么 | 比对物 | 谁提供 | 哪里读 |
|---|---|---|---|
| Metabase 报表**内容**（布局/参数/卡片/锁参） | **内容指纹**（现算 24 hex） | 平台算（`readDashboardContent`） | `POST /reports` 的 201 响应 `fingerprint` |
| **登记行**（页门/发布/回收） | **登记表版本号**（整数，每次写 +1） | 平台算（`data.reports.version`） | `GET /reports/manage` 每行 `version` |

- **调用方义务（fail-closed）**：**更新既有对象必须回带版本**。两条通路的**缺失语义不同**（别混）：
  - **登记侧**（`PUT`/`DELETE`）：`expectedVersion` 是 **zod 必填** ⇒ 缺/非法 ⇒ **`400 INVALID_BODY`**；不符 ⇒ **`409 STALE_WRITE`**（带 `currentVersion`）。
  - **内容侧**（`POST /reports` 更新既有 dashboard）：`expectedFingerprint` 缺 ⇒ **`409 VERSION_REQUIRED`**（带 `currentFingerprint`，因为"缺"本身是**语义**判断：只有命中同名才知道该不该要）；不符 ⇒ **`409 STALE_WRITE`**。
  ⇒ 两种情况都读最新的再重试。首次创建无需版本（没有可覆盖的东西）。
- ⚠️ **重跑登记（`POST /reports`）现在也需要指纹**：它是"更新既有 dashboard"这条路 ⇒ 先读一次再写。
- **每对象一把锁**：进程内（同键串行）。⚠️ **单实例成立**；多副本部署时退化为"只有版本比对生效"（不静默，只是并发窗口变宽）。
- **`DELETE` 的版本载体是 query 串**（`?expectedVersion=N`），**不是请求体** —— DELETE 体可能被中间层（edge 是 OpenResty）剥掉，故走 query。

**已知边界（Task 2/3/4 登记项；都不静默，只是并发窗口变宽）**：

- **`putDashboardMerged` 的 GET→PUT 之间仍有丢失更新窗口**：人侧在 Metabase UI 里编辑同一张 dashboard 时，进程内那把锁覆盖不到（锁只在平台侧同键请求之间串行）。
- **`DELETE` 是「JS 比较版本 + 无条件删行」**（不像 `PUT` 走条件 `UPDATE ... WHERE version = ?`）⇒ 并发窗口由进程内锁收窄，**跨进程仍存在**。
- **`dash:`（`POST`）与 `row:`（`PUT`/`DELETE`）键空间不相交** ⇒ 同一既有报表上 `POST` 与 `PUT`/`DELETE` **不互斥**（与既有的「重登记会重置页门」是同一条口径）。
- ⚠️ **待真机验（尚未实测，别当已验）**：合并 `PUT` 现在带 `embedding_params`（回写读到的值）但**不带** `enable_embedding`/`embedding_type` —— 该组合的真机接受度**未实测**（若被拒会响亮报错，不静默）。

### Metabase 侧的名称 = `<org>/<title>`（**命名空间**，跨租户串味的结构性防线）

平台的 Metabase 是**单实例多租户共用**的，dashboard 在那边只有 `name` 这一个身份。
两个租户用**同一个 title** 建报表时，若名字不带 org，`GET /api/search` 会按名命中**同一张**
dashboard ⇒ B 的 `setEmbedding` 覆盖 A 的 `embedding_params`、B 的 `DELETE` **归档 A 的报表**
（跨租户**破坏性**操作，实测复现）。故平台的规范名是 **`<org>/<title>`**：

- **只体现在 Metabase 侧的名字上**：`data.reports.title` 恒为用户可见的原标题，
  `unique (org, title)` 语义不变（⇒ 本约定**不需要迁移**）。
- 查找（`GET /api/search`）、创建（`POST /api/dashboard`）、发布（`setEmbedding`）、
  归档（`DELETE` 路径上的 `archiveDashboard`）**四处口径必须一致**——后两处按 id 走，
  id 就是创建时那次规范名 upsert 的返回值。少一处就留一条串味路径。
- **运维 / AI 去 Metabase 里找报表时**：按 `<org>/<title>` 搜，或按 org 前缀认归属。
- 部署注记：本约定之前建的 dashboard **没有**前缀 ⇒ 首次重跑 `POST /reports` 会新建一张带
  前缀的；老那张会出现在对账的 `unregistered.needsHuman` 里（需人归档）。

**★ 建 Metabase dashboard 的人必须遵守的约定**：把租户过滤写成**名为 `tenant`**的
参数（仪表盘过滤器或原生查询变量皆可）。

- 平台在 `POST /reports` 时会把 `tenant` 与报表自己声明的 `lockedParams` 一并写进 Metabase 的
  `embedding_params`（值恒为 `"locked"`）；
- 签名时 `tenant` 的值恒 = **调用者身份里的 org**（`requester.orgId`），
  **入参一律不可覆盖**（`POST /reports` 的 `lockedParams` 里带 `tenant` ⇒ 400 `TENANT_PARAM_RESERVED`）；
- ⇒ 若 dashboard 的租户参数不叫 `tenant`，JWT 里的锁定值**绑不到任何东西**，页面会显示未经
  租户过滤的数据。
- ⚠️ **机械防线在 `reconcile`，不在本文**：`POST /reports/reconcile` 会回读
  `GET /api/dashboard/{id}` 并断言 `embedding_params.tenant === "locked"`，不满足的行落进
  响应的 `tenantUnlocked`（并 `ok:false` + 落 warn 日志）。**上面这条人侧约定只是给 T10 真机
  核对的备忘，别把它当唯一防线**——靠人记得的约定失效时是静默的（页面照常显示未过滤数据）。

env 三键（`DATA_METABASE_URL` / `_API_KEY` / `_SECRET_KEY`）见根 `.env.example`；
`SECRET_KEY` 决定「看哪个租户数据」那一半权限，泄露 = 能签任意租户的嵌入凭证。

### `POST /reports/reconcile` 的五个差集（spec §7 双写面对账）

响应体 + `console.warn` 双通道（**显式可见**，不静默——M3c 教训）：

| 字段 | 判据 | 作用域 |
|---|---|---|
| `missingInMetabase` | 登记行的 `metabase_id` 不在可嵌入集里 | **本 org** |
| `tenantUnlocked` | 回读 `embedding_params.tenant !== "locked"` | **本 org** |
| `unregistered.recoverable` | 可嵌入集里**不属于任何 org 的任何一行 `metabase_id`**，且名字能解出 `<org>/<title>`（归属确定 ⇒ 重跑 `POST /reports` 按全等命中接管） | 登记侧取**全部租户**并集 |
| `unregistered.needsHuman` | 同上但名字解不出归属（人在 Metabase 侧直接建的 / 本约定之前的遗留）⇒ 必须人判 | 同上 |
| `contentUnreadable` | 回读 `GET /api/dashboard/{id}` 抛 `MetabaseError`（上游对**这一张**说不行） | **本 org**（逐行降级：不再整单 502） |

`contentUnreadable` 非空 ⇒ `ok:false`；回读按**行**降级——一个 dashboard 回读失败只把那一行报出来，
不让整租户的对账整单 502（对账的意义就是把「哪里坏了」显式报出来）。
⚠️ 只对 `MetabaseError` 降级（上游明确对**这一张**说不行，含读卡片 `GET /api/card/{id}` 失败）；
连接层/代码缺陷类异常仍然**整单失败**（不把缺陷伪装成业务状态）。

`unregistered` **不能**按 `title` 求差：那样同名孤儿（幂等窗口/并发造出的重复 dashboard）看不见，
且多租户下会把别人的 dashboard 恒报成本租户未登记——两种都是**假绿**。跨 org 读是**平台级
对账动作**的一部分（spec §7），只用于这里的并集判据。
报表删除走「**先归档、再删行**」：只删登记行会让该报表恒留在未登记差集里（消不掉的噪声）；
先归档、删行失败则报成 `missingInMetabase`（可恢复、显式可见）。

### 平台自绘：声明式规格 + 代码常量白名单（spec §3⑥/§5）

- **规格存 `data.reports.spec`（jsonb）**，只对 `renderer='platform'` 的行非空（跨列 check 兜着）；
  **规格写保护复用登记表版本守卫**（`PUT /reports/:id/spec` 必带 `expectedVersion`，不符 ⇒ 409 `STALE_WRITE`）。
- **严格白名单是机检落点**：规格每层 `.strict()`，白名单外的键一律 400——**不是** strip
  （spec §3⑥ 实测：没有白名单时，规格里多塞一个可执行字段会被**照单接受**）。
- **图型白名单是代码常量**（`domain/report-spec.ts` 的 `CHART_TYPES`）：**加图型 = 改常量 + 加渲染分支 + 测试，走 PR**；
  **不做** env/DB 可配（那会让「渲染器能力」与「平台代码」脱钩 ⇒ 库里加了图型而渲染器不认 = 静默空白）。
- **「判据同源」证到什么程度（Task 5 评审转办，别写成更强的结论）**：Task 5 的断言证的是
  「**同一行语义声明 ⇒ 同一 SQL 骨架**」（同一 `metricId`、A/B 两租户各自注入自己的主体值、主体值抹平后两条 SQL 全等）。
  **不含**「自绘路与 Metabase 嵌入路**跨路径**同源」的断言（那要另立用例）。写文档时**别把它说成后者**。
- **`panel.dims` 的语义（Task 4 评审裁决，必须写清）**：dims 是**渲染层的透视轴**——`dims[0]` 为 x 轴、
  其余为系列维度；**不进 `/query`**（`QueryBody` 只有 `{metricId, args}`）。**分组跟随指标自身的 grain**
  （L1 grain / L2 visibleDims，`GROUP BY ${metric.groupBy}`）；`args` 只做等值过滤。**别把 dims 写成"控制分组"**——
  它控制的是图表怎么摆，不是数据怎么聚。
- **数据通路 = 既有 `POST /query`，一个面板一次**：语义裁剪、授权、**按调用者身份注入主体值**、逐查询落
  `data.query_audit`，全部复用 ⇒ 自绘**不依赖 Metabase 锁定参数**，与 Metabase 那条路**判据同源**。
  别为了省往返造「整报表数据」端点——那会把 N 次授权/审计合并成一次。
- **两条实测渲染坑（spec §5）**：多系列要**透视数据集**（否则多出来的点会被连成一条线）；画布要收 `overflow`
  （否则溢出到隔壁格子）。**渲染器质量归我们**，这两条是渲染层的活、不是数据问题。
- ⚠️ **部署 007 前查既有行**：目标库若有无规格的 `renderer='platform'` 行（跨列 check 会拒），
  先清理再迁移：`select org,id,title from data.reports where renderer='platform' and spec is null;`
  ——有结果就先删行（或补规格），再上 007。
