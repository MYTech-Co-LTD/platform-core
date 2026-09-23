# platform-core 架构

> **本文是常设架构文档**：动手前先在这里确认「架构支不支持这次改动」。架构不支持 → 先讨论架构、
> 先改本文档，再写码（公司规则 `architecture-first`：先经人同意 → 更新架构文档 → 再写代码）。
>
> **本文只写代码与门禁里读不出来的东西**：为什么是这个装配顺序、不变量为什么存在、边界在哪、
> 加一个模块要动哪些点。能从代码直接读出的（函数签名、实现细节、逐行逻辑）**只给指针，不复制**
> ——两份事实源必然漂移。
>
> 与 `README.md` 的分工：README 讲「布局 / 常用命令 / 提交纪律」，本文讲「边界与不变量」。

## 1. 系统上下文与部署拓扑

### 1.1 这个仓是什么

通用平台底座 monorepo：**一个宿主 + 一套模块接入协议 + 一个认证内核**。业务模块（工单系统）
未来迁入 `modules/`。平台代码与模块代码之间是**硬边界**，由 B1 门禁守着（见 §4.1）。

### 1.2 单机拓扑

部署单元 A（`deploy/docker-compose.yml`）的两个服务：

| 服务 | 说明 |
|---|---|
| `postgres` | `postgres:16-alpine`，卷 `pgdata` |
| `server` | 由 `deploy/Dockerfile.server` 构建，**build context 必须是仓根**（Dockerfile 要 COPY `packages/` `apps/` `modules/` `scripts/`） |

`server` 以 `service_healthy` 依赖 `postgres`——迁移在**启动期**跑，PG 未就绪即失败。

**部署单元 B（数据面）**：仓内 compose **只两份**（B7 守）——上面这份主 compose，加
`deploy/data-compose.yml`；**第三份 compose 文件（含 compose 片段）一律违规**。单元 B 是数据栈的
编排面：`pg_duckdb`（**官方镜像** `pgduckdb/pgduckdb:18-v1.1.1`；`deploy/pg-duckdb/` 的**自建路径
本轮未启用（备件）**）、Metabase、`metabase-db`，以及 `duckle` / `dbt` 的**一次性 runner**。
它**全内网**：不进 openship edge、不绑公网、不签平台外证书；
端口一律回环（B7 规则二对**两份**都生效）。部署形态上是**独立的 openship project**，与单元 A
「一机不够时沿缝拆」——**拆缝是可选选项**，不拆时数据面服务并入单元 A 的 project（旋钮②服务裁剪）。
目标形态与接线模型见 `deploy/customer-onboarding.md` §0/§1。**六组件的分工见 §2.2。**

> 两份 compose 与单元 B 的服务**均已落仓**（`deploy/data-compose.yml` 随 P1 的 T3 落仓），B7 白名单
> 亦已放行该路径。**「缺席不违规」仍成立**——拆缝是可选形态，白名单是「放行」而不是「必须存在」。
>
> **三条显式接受**（spec 已点名/记录，不默默使用；**逐条各带自己的理由**——接受 ≠ 无风险）：
> ① Metabase **locked parameters 锁租户**是官方**明确不建议**用于敏感数据的用法——**接受**：租户
> 隔离的主力在数据层（凭据 + schema），locked parameter 只是嵌入路径上的执行点；
> ② 嵌入页带「Powered by Metabase」**水印**——**接受**：**去掉水印要 Pro/EE**（成本），而本形态
> 不打算为此升版；抹白标不可配置是本条的实际代价；
> ③ 嵌入页**不能禁 CSV 导出**（官方：只有 Pro/EE 能关数据下载）——**接受**：导出的是租户自己那份
> 数据，**不构成跨租户外带面**；**但残余风险要写明**：这意味着**我们无法阻止租户把数据导出到平台
> 之外**——这是显式接受的风险，不是「没有风险」。

### 1.3 生产通道，与「为什么绑回环不是可选项」

生产只经 openship edge 访问：edge 在**宿主**上反代 `127.0.0.1:<port>`。因此把端口绑 `0.0.0.0`
等于让任何能访问宿主该端口的人**绕过 edge**（丢掉证书、限速与访问控制）。

生产**照搬同一份 compose**（差异项见 `deploy/openship-adopt.md`），所以两条端口映射
（`postgres`、`server`）都是生产入口面的一部分，**都绑 `127.0.0.1`**，B7 守着白名单**两份**文件里
所有 `ports` 条目（单元 B 不进 edge，其端口同样必须回环）。

### 1.4 租户模式

`TENANT_MODE ∈ {multi, single}`（`apps/server/src/config.ts:9,52`）；`single` 时 `PLATFORM_ORG`
必填（`apps/server/src/config.ts:70`）。租户解析是「请求 Host → 租户」，实现见 `apps/server/src/tenant.ts`。
租户行上还有**安全旗标**列（如 `wecom_auto_signup`，企微直连 JIT 建号，默认关——见 §4.2）。

> 部署接入：`deploy/openship-adopt.md`；部署后必验：`deploy/README.md`

## 2. 组件与职责边界

依赖边**读自各 `package.json`**，不是推测。

| 组件 | 做什么 | 依赖 | 谁依赖它 |
|---|---|---|---|
| `apps/server`（`@platform/server`） | 宿主：装配、租户解析、会话、平台路由、登录三路、模块挂载、静态托管 | `@platform/auth-core`、`@platform/sdk`、hono、pg、zod、**`@aws-sdk/client-s3`**（M3c 起：管理端「保存时探测 / 测试连接」，见下方「依赖边新增」） | 无人（可部署端） |
| `apps/web`（`@platform/web`） | 前端 console（SPA）；模块 console 条目由 registry 聚合 | `@platform/sdk/web`（`platformFetch`）、antd、react | 无人 |
| `packages/auth-core` | **认证内核**：Casdoor 客户端、会话签名、scope 计算、企微 | jose、hono、zod（**无仓内依赖**） | **只有 `apps/server`** |
| `packages/platform-sdk` | **模块契约**：`defineModule` / manifest schema / 门卫 / 前端 fetch | hono、pg、yaml、zod（**无仓内依赖**） | `apps/server`、`apps/web`、每个 `modules/<id>` |
| `modules/<id>` | 业务模块。现为 `demo`（占位）、`aftersales`（**第一个真业务模块**：售后域。M2a 只有域 API + 建表 + ZOS 预签名，console/mobile 归 M3）与 `data`（**数据问数域**：三条消费通道共用一个授权核心——会话 / 个人 Key+PAT / 企微渠道凭证；见 `docs/superpowers/specs/2026-09-21-data-query-channels-design.md`） | `@platform/sdk`（+ 前端库；`aftersales` 另有 `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` 做天翼 ZOS 预签名；`data` 另有模块内 LLM 编排，**无** S3 依赖） | 无人；由宿主装载 |
| `scripts/` | 门禁与工具 | — | CI |
| `deploy/` | 部署面：compose / Dockerfile / runbook | — | 生产接入 |
| `deploy/data-compose.yml` + `deploy/pg-duckdb/` | **数据面（部署单元 B，已落仓）**：`pg_duckdb` 用**官方镜像** `pgduckdb/pgduckdb:18-v1.1.1`（PG 内嵌 DuckDB 执行面）——数据栈引入的**新组件**；单元 B 的编排里另有 Metabase / `metabase-db` / `duckle`·`dbt` 一次性 runner。⚠️ `deploy/pg-duckdb/` 的**自建镜像路径本轮未启用（备件）**（本轮改用官方镜像；自建保留供将来走 ossie 通路时按实测重验配对） | `deploy/data-compose.yml` → `pgduckdb/pgduckdb:18-v1.1.1`（Docker Hub，上游构建）；**备件**路径 `deploy/pg-duckdb/Dockerfile` → `ghcr.io/mytech-co-ltd/platform-core-pg-duckdb`（tag 见该 README） | 无人（可独立部署）；拆缝时作独立 openship project，接线见 `deploy/customer-onboarding.md` §5 |
| `dbt/` `contracts/` `duckle/` | **数据工件（已落仓）**：dbt staging / 语义声明、采集契约、管线。**均非 Node workspace 包**，因此落在 B1（跨 schema）与 B9（env 键齐全）的扫描根之外。**但别读成「它们被守住了」**：`scripts/check-data-models.mjs`（T4 起）按计划只做 **dbt 工件的静态门禁**（staging 模式 / 语义声明必填 / 同名唯一 / 对账测试存在），**不覆盖 env 键**；而 `duckle/`（T5）与 `contracts/` **不在 B1/B8/B9 任何扫描面内** ⇒ 它们的 env 键等约束**当前没有任何静态门禁**（需要时由 T4 按其职责扩面，或在评审里守） | — | 单元 B 的 runner 服务读它们 |

两条**不可越过的边界**：

1. **认证代码只许在 `packages/auth-core`**，且 `@platform/auth-core` **只许 `apps/server` 引**。
   `apps/web` 与 `packages/platform-sdk` 连 `import type` 都不许。（B2 守）
2. **平台代码与模块代码不许互相跨 schema。**（B1 守）

### 2.1 依赖边新增：`apps/server` → `@aws-sdk/client-s3`（M3c，2026-09-17 拍板）

- **是什么**：宿主侧一条新的外部依赖边，为**尚未落地**的探测模块而引——`apps/server/src/storage-probe.ts`
  的 HeadBucket 探测（该文件由 `docs/superpowers/plans/2026-09-17-m3c-tenant-storage.md` 的 T7 新建），
  服务管理端的「保存时探测」与「测试连接」。
- **为什么是宿主**：这两处都得**真发一次网络请求**——预签名（SigV4）是纯本地计算，宿主在请求路径上
  **永远**发现不了「配置存在但连不上」。而探测要在保存前拦住写、并把失败**分类**成不含凭据的形状回给
  前端 ⇒ 落点必须同时满足「读得到租户行」与「不受模块边界约束」，只有宿主。放进模块等于让每个
  声明 `storage` 的模块各造一套探测。
- **为什么是「宿主自己的依赖」而不是「复用它自己抽出来的公共包」**：宿主这次引的是一条**独立**的依赖边
  ——宿主只做探测（HeadBucket），`modules/aftersales` 只做预签名（`ZosStorage`）。两者**同一主版本**
  （`^3.700.0`，与模块现有依赖一致），避免两套 AWS SDK 在重试 / 错误形状上分叉
  （那类问题的表现是「探测说 OK、真传失败」，极难查）。

> **⚠️「存储客户端抽公共包」的判据到点了，但本次并没有抽 —— 两件事分开记。**
> spec §2.3（`docs/superpowers/specs/2026-09-15-aftersales-module-design.md`）与 M3c spec §9
> （`docs/superpowers/specs/2026-09-16-m3c-tenant-storage-protocol-design.md`）记的是
> 「`storage.ts` 模块内自持，**第二个消费者出现再抽公共包**」。上面这条依赖边**让那个判据到点**
> （`modules/aftersales/storage.ts` 是第一个消费者，**宿主是第二个**）。
> **但「判据到点」不等于「已经抽了」**：本次裁定的是「**宿主自己的探测用宿主自己的依赖**」——
> `ZosStorage` 仍留在 `modules/aftersales/storage.ts`，宿主侧只有那个**新建的探测模块**（T7），
> 它只调 HeadBucket、不做预签名。
> 抽取公共包是**下一个、尚未决策**的动作，它现在才**有了依据**（不再缺案例）。
> 别把本节读成「公共包已存在」，也别读成「判据还没到」。

### 2.2 数据栈组件分工（六组件，2026-09-23 订正）

> **本节是数据栈职责边界的正典**（此前散在 spec / 计划 / 各 README，本轮方案整理收成一处）。
> 随本节一并**作废三条旧口径**：① pg_duckdb 走**自建镜像**（⇒ 改用官方镜像，自建降为「未启用备件」）；
> ② 语义声明的事实源是 **Ossie 格式 JSON**（⇒ 实际存储是 **dbt YAML**）；③ AI 走 **duckdb-ossie MCP**
> 问数据（⇒ **未采纳（观察项）**，理由见下）。被取代的 spec 条号见 §6.1「订正指针」。

**横切一条（语义链——六组件靠它串起来，单独记因为跨全部六者）**：
**dbt YAML（事实源）→ `scripts/sync-data-semantics.mjs` 物化 → PG 表 `data.metrics`（运行期词表）
→ 查询期 `semantic-compiler` + `authz` → SQL**。
**⚠️ 存储格式是 dbt YAML，不是 Ossie 格式**——读旧 spec 的「L1 = Ossie JSON」会走错。

**1. 对象存储（天翼 ZOS，S3 兼容）**
- **职责**：唯一数据底座——parquet **落湖**，**每租户桶/前缀**。
- **输入**：duckle 按采集契约写出的 parquet。
- **输出**：可被 DuckDB httpfs / `read_parquet()` 直读的对象。
- **不做什么**：**不承载计算**、**不对外服务**（不进 edge、不作查询入口）。
- **依赖关系**：**被 duckle（写）与 pg_duckdb（读）依赖**；本仓对它的访问一律经凭据收口
  （每租户 `TENANT_STORAGE` 五元组 / pg_duckdb 侧 USER MAPPING 的 `SCOPE` 前缀）。

**2. duckle（headless runner；`deploy/data-compose.yml` 的 `etl` profile；一次性执行）**
- **职责**：**管线层（源 → sink）**——按采集契约把外部数据写成 parquet 进湖。
  **并（本轮新采纳）**提供：漂移检测（`drift`）、契约校验（`node.data.schema` + `qa.contract`）、
  运行回执（runs receipt / `duckle_metrics.prom`）与新鲜度 gate（`qa.freshness`）、
  管线级血缘（`catalog build` → `.duckle/catalog.json`）。
- **输入**：`duckle/` 的管线定义（**仓内为真源**，容器里只读挂载）+ 源凭据（运行期注入）。
- **输出**：湖里的 parquet + 运行回执 / 门禁退出码 / catalog。
- **不做什么**：**不建模**（口径在 dbt）、**不做语义与权限**（在 `modules/data`）、**不常驻**。
- **依赖关系**：写对象存储；`drift` / `review --data` 要凭据与网络 ⇒ **etl job 显式带 `--token` 跑**
  （**不是**放宽 `deploy/duckle/entrypoint.sh` 的闸）。引擎能力的接入口径与三条坑读
  `duckle/README.md` §7，**未验清单是 gate**。

**3. dbt（runner 镜像；`etl` profile；按需 job）**
- **职责**：**建模与物化**（staging 清洗 → marts 口径模型，物化进 pg_duckdb）；
  **L1 语义声明的事实源**（`dbt/semantics/l1_metrics.yml` + `dbt/models/common/marts/schema.yml`）；
  **对账/断言 tests**（`audit_*` 独立复算 + `assert_*` 结构断言）；**血缘与文档**（`dbt docs generate`）。
- **输入**：湖里的 parquet（staging 读源）；语义声明是**仓内 YAML**。
- **输出**：pg_duckdb 里的 marts 关系（**必须是 PG 可见关系**）+ tests 结论 + docs。
- **不做什么**：**不对外服务**、**不常驻**、**不承担查询期语义编译**（那是 `modules/data` 的唯一编译点）。
- **依赖关系**：pg_duckdb（物化落点）与对象存储（读源）。

**4. pg_duckdb（官方镜像 `pgduckdb/pgduckdb:18-v1.1.1`；常驻）**
- **职责**：**湖上查询引擎**（DuckDB `read_parquet()` 直读 ZOS）+ **物化落点**。
- **输入**：湖里的 parquet（直读）+ dbt 的物化写入。
- **输出**：PG 关系（视图 / 物化视图 / `USING duckdb` 表）——**只有进了 `pg_class` 的才被看见**。
- **不做什么**：宿主端口**只回环**、**不直接对终端用户开放**（跨 project 接线 = 计划 T6 的 Gate-B）。
- **依赖关系**：读对象存储；被 dbt（写）与 `modules/data`（查询期）依赖。

**5. Metabase + `metabase-db`（常驻）**
- **职责**：**BI 展示与嵌入面**（数据源 = marts；签名嵌入 JWT **锁 tenant**）。
- **输入**：marts 关系 + 平台 facade 签发的嵌入 JWT。
- **输出**：嵌入页 / 报表。
- **不做什么**：**不做权限裁决**（OSS 无逐用户隔离 ⇒ 隔离**下推数据层**，spec 已**显式接受**这条）。
- **依赖关系**：pg_duckdb（数据源）；`metabase-db` 是它自己的应用库（**不可重建**，必须备份）。

**6. `modules/data`（单元 A 平台宿主内）**
- **职责**：**唯一对外门 + 治理面**——词表裁剪与 org 谓词（`domain/authz.ts`）、
  **唯一编译点**（`domain/semantic-compiler.ts`）、问数 API（`routes/query.ts`）、
  MCP 工具面（`routes/mcp.ts`）、报表 facade 与嵌入 URL 签发（`routes/reports.ts` + `domain/metabase.ts`）、
  L1 物化写入口（`scripts/sync-data-semantics.mjs`）、每租户 provisioning 与对账、串租户 e2e。
- **输入**：读写 `data.metrics`（运行期词表）+ 会话 / 个人 Key+PAT / 企微渠道凭证。
- **输出**：问数结果、嵌入 URL、报表登记。
- **不做什么**：**不存数据**、**不建模**、不越权读 `platform.tenant` 之外的面。
- **依赖关系**：pg_duckdb（查询）、Metabase（facade 调 API）、Casdoor（身份）。

> **为什么 AI 通路只有一条**：spec §11.3 记的「AI 走 duckdb-ossie MCP 问数据」**本轮未采纳**
> （观察项）。理由：两条 AI 通路 = **两套词表、两套权限**，是治理反模式 ⇒ 保留**单一受管入口**
> （`modules/data` 的 MCP 工具面）。同一条理由也是「任何绕开 facade 的数据面直连都不合规」的
> 出处（spec §11.3.1）。

## 3. 宿主装配链与 I-1 顺序契约

`apps/server/src/app.ts` 里带标号的 **11 段（①–⑪）**，外加一个未编号的 **④.5 请求体上限**
（`bodyLimit`，挂在 ④ 与 ⑤ 之间）。顺序不是风格，是**契约**——下面三条是硬约束，顺序改错会**静默**坏掉：

| 约束 | 为什么 | 出处 |
|---|---|---|
| **④.5 `bodyLimit` 必须早于所有 `/api/*` 路由注册** | Hono 中间件**只对其后注册的路由**生效；挂到路由之后再 `use` 会永不执行 | `apps/server/src/app.ts:153` |
| **⑥ 租户→会话 必须先于 ⑨ `runtime.mount`** | 模块门卫读 `c.get('identity')`；会话层少一道即模块 API **全线 401**（未登录）/ 漏身份（已登录） | `apps/server/src/app.ts:3-9`（I-1 硬契约） |
| **② `seed` 必须先于 ③ 模块装载** | 权限码供给按 `platform.tenant` 取各租户 org；全新库上租户还不存在 ⇒ 一个码都建不出来 | `apps/server/src/app.ts:121-125` |

完整十一段与逐段说明读 `apps/server/src/app.ts` 顶部注释——**本文不复制**（两份会漂）。

> **改装配 / 路由 / Host 语义时，`pnpm smoke` 是唯一证据面。** 它跑**真进程**（双形态 multi +
> single）；进程内直调 `app.request()` 看不到启动期装配、Host 语义、静态托管这三层。

## 4. 不变量清单

**先看清是哪一档。** 第一档违反 = CI 红；第二档违反 = 门禁不拦，靠评审与人。

### 4.1 第一档：门禁固化（在 CI 真跑，且会红）

判据严格取「**在 CI job 里跑**」而非「脚本存在」——脚本存在但没接进 CI 的不算固化。

| 规则 | 守什么 | 固化处 | 跑在 |
|---|---|---|---|
| **B1** 跨 schema | **三同纪律**：`id` = DB schema = API 前缀。平台代码只许 `platform.*`；`modules/<id>/` 只许自身 id | `scripts/lint-architecture.mjs` | `gates` |
| **B2** 认证唯一 | 认证代码只许 `packages/auth-core/**`；`@platform/auth-core` 只许 `apps/server` 引 | 同上 | `gates` |
| **B4 / B5** manifest | manifest 合法性 + 双向核对 | `scripts/check-manifests.mjs` | `gates` |
| **B7** 部署面 | 全仓**只两份** compose：`deploy/docker-compose.yml`（部署单元 A）+ `deploy/data-compose.yml`（部署单元 B，数据面，P1 起放行）；两份文件里**所有** `ports` 条目必须 `127.0.0.1:` 起头。（受管服务缺 ports 即报只对单元 A 的 `postgres`/`server` 生效——单元 B 的服务整份可裁剪） | `scripts/check-compose.mjs` | `gates` |
| **B8** 无硬编码 | 禁 `hookflow.cn`；禁公网 IP 字面量（`127.0.0.1` 白名单） | `scripts/lint-architecture.mjs` | `gates` |
| **B9** env 契约 | `.env.example` 键齐全 | `scripts/check-env-example.mjs` | `gates` |
| **租户隔离** | 模块迁移建表必须有 `org`。判据是**真库对账**（跑一遍模块 migrations 再查 `information_schema`），且按**累积终态**判、不按文件判——按文件判会误报 `modules/demo`（它的 org 在 `003` 才补），而 demo 正是新模块照抄的模板。契约与豁免出口见 `docs/module-protocol.md`「租户隔离 CI 门禁」 | `scripts/check-tenant-isolation.mjs` | `gates` |
| 装置完好 | `.githooks/pre-push` 带执行位 + 根 `prepare` 接线未被改掉（本地防线被改掉时**不会有任何报错**，只会"从此刻起拦不住"） | `.github/workflows/ci.yml` 的 gates | `gates` |
| typecheck | 聚合 `tsc --noEmit`，**含 `scripts/`**（只跑包内会漏 `scripts/*.mjs` 的类型错误） | `.github/workflows/ci.yml` | `gates` |
| 测试 / 冒烟 | 挂真 PG 的全量测试 / 双形态**真进程**装载冒烟 | `.github/workflows/ci.yml` | `unit` / `smoke` |

> B1 的 schema 侧由门禁守；`id` → API 前缀由 `moduleApiBasePath(id)`（`apps/server/src/loader.ts:102`）
> 从 `id` **派生**，属构造上一致，不靠人记。

> **B1 没有豁免出口**（`allowedSchema()` 把 `modules/<id>/` 之外一律硬钉成 `platform`，
> 无 marker、无 allowlist）。所以当宿主**必须在 mount 前**用到模块 schema 里的数据时（典型：
> PAT 凭证解析要在模块路由之前注入 `identity`），**不能**让宿主自带一份 SQL——正确解法是
> **模块端口**：模块用 `createPorts(ctx)` 声明能力，宿主用 `runtime.port(id, name)` 取用。
> 契约见 `docs/module-protocol.md`「模块端口」。（2026-09-21 拍板：该冲突实测会让 `gates` 报
> B1 违规，见该节。）

### 4.2 第二档：仅文档（无门禁，靠评审与人守）

| 不变量 | 是什么 / 违反了会怎样 | 出处 |
|---|---|---|
| **声明即授权** | 模块 API 必须在 `manifest.api.internal[]` 逐条声明；**未声明 = 不可达**（fail-closed）。漏声明 ⇒ 该路由**恒 403 且无人知晓** | `packages/platform-sdk/src/module.ts:113`、`apps/server/src/loader.ts:129,180` |
| **装载期双向核对** | 注册的路由集合与声明集合**任一方向有差集** ⇒ **装载失败**（绝不半挂）。让「声明与代码漂移」不可能悄悄存在 | `apps/server/src/loader.ts:113,137-171` |
| **`routePath` 基准** | 门卫的比对基准是 `c.req.routePath`。包裹层被宿主 mount 到前缀下后它是**绝对路径**，故 `declared[].path` 必须与之同基准；相对/绝对混用 ⇒ 门卫**恒 403** | `packages/platform-sdk/src/module.ts:106-108`、`apps/server/src/loader.ts:176-177` |
| **HEAD 归一 GET** | Hono 把 HEAD 按 GET 派发，但 `c.req.method` 仍是 `'HEAD'`；不归一 ⇒ 已声明的 GET 端点在 HEAD 下**恒 403**。**只归一 HEAD→GET**，未声明的路径照旧 fail-closed（不是"放行一切 HEAD"） | `packages/platform-sdk/src/module.ts:121-125` |
| **`enabledFor` 只能请求期门控** | `enabledFor(tenantId)` 是**按租户**的（`apps/server/src/loader.ts:52`），而 `mount()` 全仓只调一次（`apps/server/src/app.ts:231`）⇒ 停用模块只能在**请求期**过滤；闸门每请求查一次库、**刻意不做缓存**（`apps/server/src/loader.ts:350,369`）。装成「装载期过滤」会连带把启用租户也挡掉 | `apps/server/src/loader.ts:45,350,369` |
| **I-1 挂载顺序** | 租户→会话必须先于 `runtime.mount`（见 §3） | `apps/server/src/app.ts:3-9` |
| **JIT 建号三条件** | 企微自动建号（issue #32）必须同时满足：① **企微直连 code**（qr-corp/silent；Casdoor OIDC code 路**永不** JIT——那条路的账号来源是 Casdoor 自己的注册/管理面）② 租户旗标 `wecom_auto_signup`（**默认 false**，seed 收敛关；放宽 = 企微成员自动获得平台账号，必须租户级显式决定）③ 建号 + 挂全量码后重读成功。任一不满足 ⇒ fail-closed（NO_ACCOUNT / CASDOOR_UNAVAILABLE）。建号失败**绝不静默放行**（audit `login.fail reason=jit-create-failed`） | `apps/server/src/routes/auth-wecom.ts:324`、`packages/auth-core/src/casdoor-client.ts:236,268`、`apps/server/src/migrations/004_tenant_wecom_auto_signup.sql` |

> **「仅文档」不等于「不重要」**，而是「目前没有自动化的守门人」。把某一条升级成门禁是**另一个决定**，
> 需要单独的真实案例支撑（本仓规矩：无案例不立标准）。

### 4.3 机制：按请求向模块注入租户级配置（M3c，2026-09-16 拍板）

> 本节记的是**机制**，不是不变量——列在这里是因为它必须逐条对照 §4 的不变量才敢落地。
> **规则正文**（manifest 字段形状、context 键名与类型、注入位置、兜底语义、安全性质）在
> `docs/module-protocol.md`「租户级配置注入」——本仓规矩是正文不复制，两份事实源必然漂移。

**是什么**：声明了 `storage` 的模块，宿主在**请求期**把**本次请求所属租户**的存储配置投影进该请求的
模块上下文（模块 `c.get(TENANT_STORAGE)`）；`ModuleContext` 一字不改，新能力只有「manifest 可选字段 +
context 键」两处**加**。

**为什么必须请求期**：`createRouter` **装载期只调一次**（`apps/server/src/loader.ts:294`），那一刻
**没有租户**可读——租户是按请求由 Host 解析出来的（`apps/server/src/tenant.ts`）。而配置若只来自进程
env，多租户同进程部署就只能共用一份 ⇒ 无 BYO、单密钥爆炸半径 = 全租户、成本不可按租户归集。
这是「配置从哪来」的**结构缺口**，不是隔离漏洞（三道隔离完好，见 `docs/module-protocol.md`）。**注入的
是配置材料，不是授权**：这条中间件不做鉴权、不返回 403，与门卫是两件事。

**逐条对照既有不变量**：

| 不变量 | 是否触犯 | 说明 |
|---|---|---|
| **B1 跨 schema（三同）** | **不触犯** | 模块**不读** `platform.tenant`——投影由**宿主**做（这正是「模块自己去查租户行」「宿主给模块一个按 org 取配置的解析器/缓存」两条被排除的原因：那等于把「模块可以指定 org」写进协议）。⚠️ 引出一条**新约束**：注入的必须是**投影后的纯值**，**不得**把 `TenantRow` 整个塞进来——它坐着 `wecom_secret`/`wechat_oa_secret`/`casdoor_org` ⇒ 每个声明模块都能读到该租户的企微/公众号密钥，且模块被引到 platform 语义上 |
| **B2 认证唯一** | 不触犯 | 不碰认证代码 |
| **B4/B5 manifest** | 不触犯，**但要改 schema** | 新增可选字段；`packages/platform-sdk/src/manifest.ts` 的编译期双向断言强制接口与 zod 同步（漏改一边 typecheck 红）。`scripts/check-manifests.mjs` 要不要认这个新字段是**落地时的一步**——门禁升级是单独的决定 |
| **B7 部署面 / B8 无硬编码** | 不触犯 | 不新增端口/compose；端点仍由配置提供，不写死 |
| **B9 env 契约** | 不触犯 | env 五键**保留**（`.env.example` 不变），语义从「唯一来源」降为「**平台默认**」；`platformStorageFromEnv`（SDK）的「缺任一键 ⇒ `null`」正好承接「没有平台默认」这个状态 |
| **声明即授权（fail-closed）** | **强化，不触犯** | 新能力同样走 manifest 声明；未声明 = **拿不到**（`undefined`），与「未声明路径 = 不可达」同构 |
| **装载期双向核对** | 不触犯 | 它核对的是**路由集合**与 `api.internal` 的差集；本机制**不动任何路由** |
| **模块不写门禁** | **不触犯，且要显式划清** | 注入中间件**不是门卫**：不做鉴权、不返回 403，只做投影。「宿主施加门禁」与「宿主注入材料」是两件事——混为一谈会让后人以为注入中间件也有安全职责 |
| **`enabledFor` 只能请求期门控** | **同构且不冲突** | 同样是请求期解析；装载期只拿 manifest 的**声明**（不含任何租户数据）。顺序上启用闸门在前 |
| **I-1 挂载顺序** | **不触犯，且天然满足** | 投影中间件挂在 `runtime.mount()` 内部（⑨），而租户→会话（⑥）在它之前（`apps/server/src/app.ts`）⇒ 中间件一定读得到 `c.get('tenant')` |
| typecheck / 测试 / 冒烟 | 不触犯 | 落地时按 §4.1 现有档位补装载器与投影纯函数用例；`pnpm smoke` 是装配层的唯一证据面 |

## 5. 扩展点：加一个模块要动什么

1. 建 `modules/<id>/`：`modules/<id>/manifest.yaml` + `modules/<id>/index.ts`（`defineModule`）+ `modules/<id>/migrations/`（可选）+ `modules/<id>/console/`（可选）
2. **三同纪律**：`manifest.id` = DB schema 名 = API 前缀，三处必须一致（B1 守 schema 侧，前缀由 `id` 派生）
3. 在 `manifest.api.internal[]` 里**逐条声明**每条路由的 method / path / scope——**没声明就是不可达**
4. 权限码写进 `manifest.permissions[]`；供给由装载器按各租户 org 逐个 upsert，**模块不手写 `requireScope`**
5. **租户数据表必须带 `org` 列**（值 = `identity.orgId`），读写按 org 过滤——约定正文读
   `docs/module-protocol.md`「租户数据隔离」
6. console 条目写进 `manifest.frontend.console[]`；前端 registry 由 `scripts/gen-console-registry.mjs` 生成
7. 部署**一般不用动**（模块随宿主构建进镜像）
8. 有**外部访客面**（移动端/公众号客户）的模块：manifest 增声明 `guest: { scope }`
   （`scope` 必须 ∈ 本模块 `permissions[].code`，schema 拒绝越界），宿主 `wechat-oa` 访客登录路
   按**该租户已启用模块**发放这些码；访客面的端点照常在 `api.internal[]` 里**逐条声明**（scope
   用那个 guest 码），**不另开一套门禁**。访客身份不落 Casdoor（外部用户不进内部 IdP）。
   路径必须与管理端**分面**（如 `/guest/*`）——同 `(method, path)` 只能声明一次。
   → 例：`modules/aftersales`（首个使用者）；协议细节读 `docs/module-protocol.md`
9. 需要**本租户的**存储配置（BYO 桶 / 按租户归集成本）的模块：manifest 增声明
   `storage: { kind: s3 }`（可选，缺省 = 不声明），宿主在**模块 API 子树**上按请求注入
   `c.get(TENANT_STORAGE)`；**不声明就不 set**。⚠️ 声明的是**能力**，不是**租户**——模块没有任何
   途径指定 org，注入的也只是投影后的存储五元组。协议细节与兜底语义读 `docs/module-protocol.md`
   「租户级配置注入」；机制与不变量的对照见 §4.3。宿主侧的连通性探测（管理端「保存时探测 /
   测试连接」）用**宿主自己的** `@aws-sdk/client-s3`——**不是**抽出来的公共包；
   「第二个消费者出现再抽公共包」这条判据的现状见 §2.1

→ 逐条契约与已踩过的坑读 `docs/module-protocol.md`（**改模块 API / 门卫 / 声明前必读**）

### 5.1 数据面工件怎么演进（`dbt/` `contracts/` `duckle/`）

数据面不在模块协议内（它们不是 Node workspace 包、不进 `modules/`），所以**加一个模块**那套不适用；
演进走这三条：

1. **改 dbt 模型 / 语义声明**：走 PR——口径只能有**单一定义**（同一指标不许两处各写一份 SQL），
   改完由 `scripts/check-data-models.mjs`（T4 起）机检。
2. **新增一个数据源**：`contracts/`（采集契约）+ `duckle/`（管线）+ `dbt/` staging **三件套同一个
   PR**——少一件即半接：契约没有 = 没人知道该源的结构；管线的 launcher 建在**镜像 ENTRYPOINT**里，
   不走模块路由。该纪律是流程约束，**当前无静态门禁**（见 §2）。
   ⚠️ **三件套的分工在 2026-09-23 收窄过一次**：`contracts/` 降级为**人写的意图源**（讲清该源该长
   什么样），**机器面改用 duckle 自己的声明与门禁**（`node.data.schema` + `qa.contract` + `drift`）。
   两者**不是二选一**——契约仍是接入的起点与评审依据，「落盘即定型」的**执行点**移到管线。
   理由、三条坑与未验清单见 `duckle/README.md` §7；契约侧的相应说明见 `contracts/README.md` §10。
3. **动部署形态**（并入单元 A 还是拆成独立 project）：只改 `composePath` 与服务裁剪开关，**不新建
   第三份 compose**——B7 白名单只有两份（见 §1.2「部署单元 B」）。接线模型读
   `deploy/customer-onboarding.md` §5。

## 6. 文档地图

| 文档 | 何时读 |
|---|---|
| `docs/module-protocol.md` | 改模块 API / 门卫 / `api.internal[]` 声明前**必读** |
| `docs/superpowers/specs/` | 单特性设计（历史档）；新设计也落这里 |
| `docs/superpowers/plans/` | 实现计划（历史档） |
| `deploy/openship-adopt.md` | 部署接入 |
| `deploy/branch-protection-runbook.md` | 提交纪律的四层软机制与「七条局限」 |
| `docs/m0-smoke-checklist.md` | 验收 / 手工冒烟清单 |
| `README.md` | 布局 / 常用命令 / 提交纪律 |
| `CHANGELOG.md` | 行为变化（脚本独占维护，**禁手写**） |

### 6.1 订正指针（被本轮取代的 spec 条号）

`docs/superpowers/specs/**` 是**历史快照，正文一律不改**（本仓既有纪律；处置同计划「第六轮 #3」）。
下列条号的结论**已被 2026-09-23 的订正取代**，一律以**本文（尤其 §2.2）**与
`docs/superpowers/plans/2026-09-22-data-stack.md` 的「**本轮订正（2026-09-23）**」节为准：

| 被取代的 spec 条 | 旧口径 | 现口径 |
|---|---|---|
| `specs/2026-09-20-data-stack-module-design.md` §11.2 #3 | pg_duckdb 走**自建镜像**、钉 DuckDB **v1.5.5**（理由是 ossie 只发到 v1.5.5） | **官方镜像** `pgduckdb/pgduckdb:18-v1.1.1`（上游自陈配对 = DuckDB v1.4.3）；自建降为**未启用备件**——实测该配对（pg_duckdb v1.1.1 × DuckDB v1.5.5）**编译失败：8 处 API 断裂** |
| 同上 §11.2 #4 | L1 语义声明 = **Ossie JSON** | L1 事实源 = **dbt YAML**（`dbt/semantics/l1_metrics.yml` + `dbt/models/common/marts/schema.yml`）——**存储格式不是 Ossie** |
| 同上 §11.3 | AI 走 **duckdb-ossie MCP** 问数据（两条 AI 通路） | **未采纳（观察项）**——保留单一受管入口，理由见 §2.2 末注 |
| 同上 §11.9 #3/#4 | 「Ossie 观察信号」「自建镜像的构建频率」两个开放项 | **两项均已消解**：ossie 出局 ⇒ 观察信号无对象；自建镜像未启用 ⇒ 构建频率无对象（备件将来启用时另议） |

---

**本文会漂移。** 唯一的自约是「**引用即路径，路径必须真实存在**」——发现路径失效、或本文与代码
不符，**直接改本文**（走 PR）。没有同步门禁是有意的（YAGNI）：在出现真实漂移案例之前不为它建门禁。

**例外只有一种，且必须随句标注**：引用**尚未落仓**的路径时，须在同一句或紧邻引注里写明
**由哪个任务落仓**（如「随 P1 的 T3 落仓」）与**缺席时的门禁行为**（如「白名单已开、缺席不违规」）。
**没标注的目标形态引用 = 自约违反**——它与引用一条失效路径同样处理。
