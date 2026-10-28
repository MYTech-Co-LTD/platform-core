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

部署单元 A（`deploy/docker-compose.yml`）的服务：

| 服务 | 说明 |
|---|---|
| `postgres` | `postgres:16-alpine`，卷 `pgdata` |
| `server` | 由 `deploy/Dockerfile.server` 构建，**build context 必须是仓根**（Dockerfile 要 COPY `packages/` `apps/` `modules/` `scripts/`） |
| `sandbox-console` | **数据 MCP 的沙箱执行面**（`duckle-runner serve`，与单元 B 的 `lemeng-console-*` 同镜像；**不发布任何宿主端口**，只经单元 A 默认网络被 `server` 调用）。卷 `sandbox-workspace` 同时挂给 `server`。职责与口径见 **§2.8**（issue #1002） |
| `openclaw` | **问数 bot（通道 C）**：由 `deploy/Dockerfile.openclaw` 构建（**基底** `ghcr.io/openclaw/openclaw` digest 钉 v2026.9.9，spec §3；**构建期 COPY** 插件 `deploy/openclaw/data-query-plugin/`），`profiles: ['openclaw']` 本机默认不起；**仅 platform-core-shanhai 项目在 openship 服务级启用**（mytech 项目保持 disabled）。企微智能机器人 WebSocket 长连接接入。⚠️ 插件**不能**用相对 bind 挂载送进来——openship services 模式按 Docker API 建容器、不解析相对路径（`./openclaw/…` 被当卷名，400），成例与替代解法见 `deploy/data-plane-deploy-sop.md` 坑 9。设计 `docs/superpowers/specs/2026-10-10-shanhai-openclaw-wecom-design.md` |

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

### 1.5 身份与访问：三通道与平台 token（2026-10-18 拍板）

> **本节管「谁在调平台、凭什么」**。人拍板的终局：**每个账号生成 token，外部 agent 用 token + MCP
> 操作一切「AI 可自动创建」的内容；openclaw 通过对话获取用户权限走内部接口**——三者映射到平台
> **既有的三通道模型**，本节只是把它正典化 + 修掉一处错位。

**核心判断**：**token（个人 Key，通道 B）是平台级身份能力，不是任何业务模块的私产。**

**三通道（一张图）**：

| 通道 | 凭据 | 主体来源 | 谁在用 |
|---|---|---|---|
| **A 会话** | `platform_session` cookie（HS256 JWT，载荷含 org + scopes） | 登录（账密 / 企微扫码 / 访客） | 浏览器 |
| **B token** | `Bearer dkq_…`（个人 Key） | token → 账号 → **实时**向 Casdoor 取 scopes | **外部 agent**、服务调用方（如 case-engine 调 `/emit`） |
| **C 渠道** | 渠道服务凭证（`DATA_WECOM_CHANNEL_KEY`）+ `X-Wecom-Userid` | 渠道凭证 → Casdoor 反查该用户 | **openclaw**（对话取用户身份，再以该用户权限走模块接口） |

三条都只作用于 `/api/modules/*`（模块路由），且 **first-setter-wins**：会话已注入 identity 时后两条直接放行
——「系统内通道不经这里」。实现：`apps/server/src/session-middleware.ts` / `pat-auth.ts` / `wecom-channel-auth.ts`，
挂载序见 `apps/server/src/app.ts` 第 ⑥.5 段（**必须在 `runtime.mount` 之前**）。

**四条定案（2026-10-18 人拍板）**：

| # | 定案 | 内容 |
|---|------|------|
| ① | **密钥归宿主** | token 的密钥表落 **`platform.*`**（宿主 schema，B1 天然允许），生成/解析/吊销全在宿主侧；**不经模块端口**——`modules/data` 的 `resolvePat` 端口与 key-store 存储职责随之退役（它是「凭据表长在模块 schema 里、宿主绕 B1 去取」的间接层，上移后这个绕法整个消失） |
| ② | **管理面两档，不新增权限码** | **个人页**（任何已认证账号管自己的 token，免 scope——发 token 不提权，它只承载该账号自己的 scopes）；**管理页**（复用 `tenant:admin`，看/吊销全租户）。照宿主自有页先例（`/console/admin/storage`） |
| ③ | **生命周期：v1 永久至吊销** | 吊销**即时生效**（中间件每次实时解析 + scopes 实时向 Casdoor 取）；**过期/轮换记为演进项**（加过期要客户端处理续期，v1 规模不值当） |
| ④ | **通道 C 不并入** | 通道 C 是**部署级渠道凭证**（openship env isSecret，一个部署一把），与「账号的 token」不同表、不同门禁、不同生命周期（随部署走）。**两张面，不混** |

**「AI 可自动创建的内容」怎么界定**：由各模块的 `/mcp-manage` 工具面声明（`modules/forms`、`modules/data`、
`modules/notify` 各有），门禁沿用 §14.6b 刀法——**高频 × 小（可逆）AI 直写；低频 × 大（外发/不可撤回）人审**。
token 只决定「这个账号能调哪些面」，不改变分层。

**不做清单（写死）**：

| 反模式 | 为什么不做 |
|---|---|
| **造「服务令牌」通道 D** | 服务调用方（case-engine 等）= **一个账号持 token**，与外部 agent **同一条通道、同一套门禁**。另造机制 = 为 v1 规模付新基建 |
| token 过期 / 轮换（v1） | 客户端要处理续期；真需求出现再加（与 ③ 同一条取舍） |
| 把通道 C 并入账号 token 管理面 | 部署级密钥不该暴露成租户自助面（env 注入的值 UI 也改不了）——错位 |

**实施注记**：

- 立项 [issue #894](https://github.com/MYTech-Co-LTD/platform-core/issues/894)；**存量迁移**：`data.query_keys`
  的行按哈希原样搬进 `platform.*` ⇒ **已发出的 token 继续有效、用户无感**（哈希实现只有一份，见 `key-store.ts` 头注）。
- **架构先行**：本节先于代码；实施走 issue → PR，正典冲突以本节为准。

**禁用账户的失效语义（2026-10-27）**：`getUser` 暴露 Casdoor 的 `isForbidden`。PAT 与渠道 C
每次请求实时判定 ⇒ **即时 401**；平台会话在下一次 scopes 刷新（≤5 分钟）清 cookie；企微 /
公众号登录路直接拒绝。禁用不是「绑定悬空」：公众号正式态被禁用时**不降级为访客**。

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
> 问数据（⇒ **已废止**；2026-09-26 订正——原记的「未采纳（观察项）」只说了「**本轮不做**」，
> **废止的是那套实现本身**；而「**AI 洞察**」这件事**改由授权面划线**，见本节末注）。
> 被取代的 spec 条号见 §6.1「订正指针」。

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
- ⚠️ 「每租户桶/前缀」不是建议而是**硬约束**：跨租户复用桶 = 交付边界违规 + 反向泄漏面。
  完整口径（数据面归属 / 部署租户 ≡ 数据归属租户 / 主体列不进湖）见 **§2.5**。

**2. duckle（headless runner；`deploy/data-compose.yml` 的 `etl` profile；一次性执行）**
- **职责**：**管线层（源 → sink）**——按采集契约把外部数据写成 parquet 进湖。
  **并（本轮新采纳）**提供：漂移检测（`drift`）、契约校验（`node.data.schema` + `qa.contract`）、
  运行回执（runs receipt / `duckle_metrics.prom`）与新鲜度 gate（`qa.freshness`）、
  管线级血缘（`catalog build` → `.duckle/catalog.json`）。
- **输入**：`duckle/` 的管线定义（**仓内为真源**，容器里只读挂载）+ 源凭据（运行期注入）。
- **输出**：湖里的 parquet + 运行回执 / 门禁退出码 / catalog。
- **不做什么**：**不建模**（口径在 dbt）、**不做语义与权限**（在 `modules/data`）、**不常驻**。
  ⚠️ **订正（2026-09-26）**：其中「**不常驻**」一句**已被 ADR-0014 取代**——`deploy/data-compose.yml` 起
  两个**常驻** `lemeng-console-3120` / `lemeng-console-64188` 服务（`duckle-runner serve` 的调度 tick，
  只绑回环，见 `deploy/data-plane-deploy-sop.md` §F）。**「不常驻」对它不再成立**；`etl` profile 的
  一次性 runner 语义不变。归口口径见 `docs/data-platform-handbook.md` §1.1.4。
- **依赖关系**：写对象存储；`drift` / `review --data` 要凭据与网络 ⇒ **etl job 显式带 `--token` 跑**
  （**不是**放宽 `deploy/duckle/entrypoint.sh` 的闸）。引擎能力的接入口径与三条坑读
  `duckle/README.md` §7，**未验清单是 gate**。
- **沙箱试跑不走本 runner**：数据 MCP 的 `run_pipeline_sandbox` 用**单元 A 的 `sandbox-console`**，
  理由与全部口径见 **§2.8**（2026-10-23 拍板，issue #1002）。

**3. dbt（runner 镜像；`etl` profile；按需 job）**
- **职责**：**建模与物化**（staging 清洗 → marts 口径模型，物化进 pg_duckdb）；
  **L1 语义声明的事实源**（`dbt/semantics/l1_metrics.yml` + `dbt/models/<域>/marts/schema.yml`）；
  **对账/断言 tests**（`audit_*` 独立复算 + `assert_*` 结构断言）；**血缘与文档**（`dbt docs generate`）。
- **输入**：湖里的 parquet（staging 读源）；语义声明是**仓内 YAML**。
- **输出**：pg_duckdb 里的 marts 关系（**必须是 PG 可见关系**；**`view` 与表 / 物化视图同级，都是一等
  形态**——判据只有「进没进 `pg_class`」，与下面第 4 条 pg_duckdb 的输出句同口径；2026-09-26 点明）
  + tests 结论 + docs。
- **另有一层：明细直读视图**（`dbt/models/**/views/vw_*`，**`materialized='view'`**）——**不物化、直读湖**：
  视图体就是 `read_parquet` 调用 + 逐列显式 cast + 注入主体列 `org`（为什么必须逐列 cast：不 cast 时
  消费层在 `information_schema` 里看到的是 `USER-DEFINED`）。它是「AI 在授权范围内问**明细**」的着力点；
  采集已是 5 分钟 tick（2026-09-30 起，#260）⇒ 视图还是**唯一能给出近实时明细**的面（物化表日更）。
  设计与三条 gate（新鲜度 / 分区裁剪 / 读今天的竞态语义）见
  `docs/superpowers/specs/2026-09-26-detail-read-view-design.md`。
  ⚠️ **主体列门禁的扫描面必须跟着扩到 `views/`**（规则 ⑩ 原本只扫 staging + marts）——否则新层裸奔；
  列清单**不许手写第三份**——与 staging 同由契约生成（§5.1 生成器；契约一处改、生成，不手同步），
  且视图体必须带**同款封版断言**（§5.2：混代 glob 共读会整挂，读侧靠封版挡）。
- **不做什么**：**不对外服务**、**不常驻**、**不承担查询期语义编译**（那是 `modules/data` 的唯一编译点）。
- **依赖关系**：pg_duckdb（物化落点）与对象存储（读源）。

**4. pg_duckdb（官方镜像 `pgduckdb/pgduckdb:18-v1.1.1`；常驻）**
- **职责**：**湖上查询引擎**（DuckDB `read_parquet()` 直读 ZOS）+ **物化落点**。
- **输入**：湖里的 parquet（直读）+ dbt 的物化写入。
- **输出**：PG 关系（视图 / 物化视图 / `USING duckdb` 表）——**只有进了 `pg_class` 的才被看见**。
- **不做什么**：宿主端口**只回环**、**不直接对终端用户开放**。**跨 project 接线口径（2026-09-23 已裁决）**：单元 B 的服务加入单元 A 的**既有 external network `openship-platform-core-shanhai`**（目标机实测名），`pg_duckdb` 以**服务名** `pg_duckdb:5432` 对单元 A 的 `server` 可达——`DATA_WAREHOUSE_URL` 取服务名形态；**单元 A 的 compose 不动、宿主端口仍全回环、B7 不破**。详见计划 T6 Step 1 的 Gate-B 条目。
- **依赖关系**：读对象存储；被 dbt（写）与 `modules/data`（查询期）依赖。

**5. Metabase + `metabase-db`（常驻）**
- **职责**：**BI 展示与嵌入面**（数据源 = marts；签名嵌入 JWT **锁 tenant**）。
- **输入**：marts 关系 + 平台 facade 签发的嵌入 JWT。
- **输出**：嵌入页 / 报表。
- **不做什么**：**不做权限裁决**（OSS 无逐用户隔离 ⇒ 隔离**下推数据层**，spec 已**显式接受**这条）。
- **依赖关系**：pg_duckdb（数据源）；`metabase-db` 是它自己的应用库（**不可重建**，必须备份）。

**6. `modules/data`（单元 A 平台宿主内）**
- **职责**：**治理面**（**不再是 AI 洞察的唯一入口**——2026-09-26 起 AI 可直读数据面，
  见本节末注）——词表裁剪与 org 谓词（`domain/authz.ts`）、
  **唯一编译点**（`domain/semantic-compiler.ts`）、问数 API（`routes/query.ts`）、
  MCP 工具面（`routes/mcp.ts`）、报表 facade 与嵌入 URL 签发（`routes/reports.ts` + `domain/metabase.ts`）、
  L1 物化写入口（`scripts/sync-data-semantics.mjs`）、每租户 provisioning 与对账、串租户 e2e。
  ⚠️ 其中「**词表裁剪**」**是一种能力，不是闸**——它给 AI 一份**理解口径用的词表**，
  **不构成「不在词表即不可见」**。
- **输入**：读写 `data.metrics`（运行期词表）+ 会话 / 个人 Key+PAT / 企微渠道凭证。
- **输出**：问数结果、嵌入 URL、报表登记。
- **不做什么**：**不存数据**、**不建模**、不越权读 `platform.tenant` 之外的面。
- **依赖关系**：pg_duckdb（查询）、Metabase（facade 调 API）、Casdoor（身份）。

> **AI 洞察：授权内直读数据面，语义层管口径**（2026-09-26 订正，取代本注原先的「为什么 AI 通路
> 只有一条」）。**入口不再唯一**——AI **可以直读数据面**（pg_duckdb / 湖），**不再要求每次经
> `modules/data` 这个 facade**。**合规判据随之只剩两条**：① **受授权面约束**；② **入审计**。
> **原句「任何绕开 facade 的数据面直连都不合规」整句作废**（连带效果见 §2.3 的注）。
> ⚠️ 「直读」**不等于把 pg_duckdb 暴露出去**：上面第 4 条的「**宿主端口只回环**」**不变**，
> 变的只是**谁能读**（由授权面决定）与**要不要经 facade**。
>
> **三种角色各管一段、不互相兼任**：
>
> | 角色 | 管什么 | **不管**什么 |
> |---|---|---|
> | **统一身份认证 + 权限认证**（Casdoor 身份 + `modules/data/domain/authz.ts` 的 org 谓词） | **能看到哪些数据**（租户 / 主体 / **行级 / 指标级 / 列级 / 值级**）——**这条通路唯一的划线依据** | 不管口径怎么定 |
> | **dbt 语义层**（`dbt/semantics/l1_metrics.yml` + marts `schema.yml`） | **指标怎么定义**——供 AI **理解**、保**全局口径一致** | **不是查询闸**，**不限定能查什么** |
> | **AI 洞察** | 在**授权范围内任意探索**（含**明细层**，吃 DuckDB 的性能） | 不越授权、不绕审计 |
>
> ⇒ 原先「**BI/AI 只能组合已声明的指标与维度**」（分层设计 spec §7 第 5 条「**消费层不改义**」的
> 原话）**作废**：可见范围由**授权面**划，**不由「表白名单」划**；**查询形状上的约束
> （`filter allowlist` 一类）不是权限**——这正是 spec §11.3.1 那条观察（「保护不来自 filter
> allowlist」）**仍然成立**的读法，只是「保护来自什么」的落点从**每租户会话绑定**改为**授权面**。
> ⇒ **两条不放松**：**读入审计**（落 `data.query_audit`，与问数同一套 `domain/audit-store.ts`）；
> **超时 / 行数上限是工程保护**（防一次查询拖垮数据面），**不当权限讲**。
>
> **列级 / 值级是这条依据上的两个新维度，不是第二条依据**（2026-10-17 拍板；设计
> `docs/superpowers/specs/2026-10-17-column-and-value-level-security-design.md`，issue #764）。
> **执法点唯一**：`authorize()` 组装的 SQL 投影（`modules/data/domain/authz.ts`）——`/query`、MCP、
> chat、报表**四条面**全过它（报表是经 HTTP 打 `/query`，**不是**直接调 `runQuery`）。
> **前端、词表、报表渲染一律不承担安全职责**——「词表裁剪是一种能力，不是闸」（上第 6 条）在这里
> 的直接推论就是：**靠从词表里藏指标来保密，架构上不成立**；前端脱敏 = 没脱敏。
> **列级 / 值级的解析单位是「列」，不是「指标行」**（2026-10-17 裁决 R10）：一条 `mask` 声明的是
> 「**这个列**被任何人读到时都要掩」，指标 YAML 只是**记录点** ⇒ 读同一列的**其它指标**（含 L2 派生指标）
> **自动**被同一条声明覆盖，不需要各自再声明一次（**列键声明**如此；**默认档**是整值 / 指标级，
> **不覆盖 L2** —— spec §7 R12）。这条是「一条划线依据覆盖全部读法」的落点，
> 正文与实测见 spec §5.3.1。
> ⚠️ **射程**：**直读面不在内**——Metabase / AI 直读数据面**不经过 `authorize()`**，故列级/值级在
> 直读面上**未落地**（且直读通路本身按本注的缺口 A/B **尚未开通**）。别把这条读成「全平台已解决」。
>
> ⚠️ **本注是目标形态，不是现状——通路尚未开通（文档先行）**。它成立的前提是「**授权面在数据面上
> 真的施得上**」，而该前提**还没做实**，两条缺口都开着：
> **缺口 A** —— `marts` 关系**缺 org 列**（issue **#176**）⇒ **行级授权没有着力点**，一读即跨租户；
> **缺口 B** —— **数据面上的授权载体本身未验**（**#174**：`scope` 作 USER MAPPING OPTION 无上游
> 依据、reconcile 对凭据面全盲；**#175**：每租户一桶在实现里降级为共享桶 + 前缀，待裁决）。
> **入口一放开，保护面就从「facade 一处」散到了这两条上 ⇒ 它们比先前更要紧。**
> ⇒ **缺口 A / B 落地之前，不得按本注开通任何直读通路**；顺序是「**先补授权面 →
> 再把明细层开成直读视图 → 才谈探索**」。实现另开 spec / plan，**本轮只改文档**。

### 2.3 主数据所有权与跨模块消费（2026-09-23 拍板）

> **本节是售后↔数据模块主数据依赖的正典**：档案/订单数据归谁所有、跨模块怎么读、新鲜度承诺是什么。
> 协议字段的规则正文在 `docs/module-protocol.md`「跨模块只读数据依赖：`dataDependencies`」；
> 接入视角（怎么声明、怎么读、SLA 怎么收）在 `docs/module-onboarding.md` §5。
> **本节目前是文档先行**（架构先行规矩：先改文档、人已拍板、再写码）——实现落点见本节末「实施注记」。

**核心判断（先于一切细节）**：**档案/订单数据的所有权归采集契约（`contracts/`），不归任何模块。**
一个源、两个消费面——**分析面**（parquet→dbt→pg_duckdb→Metabase/语义查询）与**操作面**
（sync 引用表 job→平台库 `data.*` 只读）。模块（含 `modules/aftersales`）在这两个面上都**只是消费者**，
谁也不是这些数据的主人；主人是契约 + 写契约的采集链路。

**目标架构（一源两面的文字版图）**：

```
乐檬源 → duckle 采集（契约 contracts/）→ ZOS parquet（唯一事实源）
  ├─ 分析面：dbt staging→marts → pg_duckdb → Metabase / 语义查询
  └─ 操作面：sync 引用表 job（openship job，dbt build 后跑）
                → 平台库 data.products / data.stores / data.orders（引用表）
                → 稳定视图（data.v_order_snapshot 一类）→ 售后等模块只读
```

操作面三条**写入要点**：

- **sync job 复用 dbt staging 的已定型数据，不重复洗**：定型（cast/类型化）在 dbt 已付过一次
  （§2.2 语义链、分层 spec 第 ③ 层），操作面不付第二次——它只做「已定型数据 → 引用表」的搬运。
- **幂等 upsert**：同一周期重跑，引用表结果一致（`on conflict do update`，与仓内迁移幂等纪律同风格）。
- **org 列纪律照旧**：引用表是 `modules/data` 名下的普通租户数据表，带 org、按 org 过滤——
  租户隔离门禁扫 `modules/data` 迁移时**天然覆盖**，无特殊豁免。

**四条拍板（2026-09-23，人拍板）**：

| # | 拍板 | 内容 |
|---|---|---|
| ① | **跨模块只读进模块协议** | 消费方 manifest 声明 `dataDependencies`（列出依赖的**稳定视图**）；门禁核「**被依赖视图没被悄悄改**」——列集变更必须显式登记。这是本仓**第一个跨模块数据依赖**，先立规矩防隐式耦合。协议正文见 `docs/module-protocol.md` 同名节 |
| ② | **新鲜度分档** | 订单类管线**高频采集（小时级或 15 分钟起步，按业务定）**，档案类**日批**即可；**不为实时把批处理改流式**。采集频率即消费方的 SLA |
| ③ | **引用表放 `data` schema，数据模块拥有** | 迁移/DDL/org 纪律/租户门禁全在 `modules/data`；售后跨 schema **只读稳定视图层**（`data.v_order_snapshot` 一类）——提供方内部 DDL 演进**不破坏消费者**（**防腐层**） |
| ④ | **超采集周期兜底【已裁掉】** | 已裁（2026-09-23）：**不考虑超周期场景**。不写「订单同步中」状态、不做手动回查源系统的口子 |

**不做清单（三条反模式，写死）**：

| 反模式 | 为什么不做 |
|---|---|
| **售后直连数据面 pg_duckdb** | OLTP 打 OLAP（连接模型与资源模型都错位）；**跨部署单元**（单元 A↔单元 B，B 全内网不对平台进程开放接线）；**权限模型不合**（数据面不持有**平台身份**——Casdoor 会话与 `platform.tenant` 都在单元 A，租户身份要在数据面重新对齐） |
| **双采集** | 两个采集器各自拉同一源 ⇒ 两份数据必然漂移，对账永远追不上。**一个源只有一条采集链路**（契约+管线唯一，`contracts/` 一份契约一个源一张表） |
| **duckle 直写平台库** | 采集器与平台库耦合（采集节奏反向锁死平台 schema 演进）；且 duckle 的 **PG sink 能力未实测**——spike 只证 `snk.minio` 直写 ZOS 可行（`duckle/README.md` §1.1 的实测对照） |

> ⚠️ **上表第一条不因 §2.2 末注的 2026-09-26 订正而松动**：那条拒斥里的「入口唯一」半句已删
> （AI 洞察**另有**一条直读通路），但**余下两条与入口无关、仍然成立**（OLTP 打 OLAP、跨部署单元）。
> **AI 洞察的直读是「另一条自带约束的通路」**（受授权面约束 + 入审计），**不是模块直连的先例**。

**与既有不变量的关系**：

- **B1 跨 schema（三同）**：**读侧豁免 = 消费方 manifest 声明了的 `dataDependencies` 稳定视图**；
  未声明的跨 schema 引用仍是 B1 违规。**写侧无豁免**——引用表只有 `modules/data` 自己写。
  ⚠️ 当前守卫（`scripts/lint-architecture.mjs` 的 `allowedSchema`）**还不认这个字段**——落地时
  B1 读侧按声明集扩（判据定死在 `docs/module-protocol.md` 同名节）。
- **声明即授权**：与 `api.internal` 同哲学（声明=授权、不声明=违规），但**执行强度不同**——
  `dataDependencies` 是**文档契约 + 门禁层**，不是运行时门卫（差异与理由见协议节，勿混读）。

**实施注记**：

- **实现随采集首管线落地**：契约（`contracts/`）+ 管线（`duckle/`）+ 引用表（`modules/data`
  迁移）+ 稳定视图**同一个 PR**——§5.1 第 2 条的「三件套」纪律**扩展为四件套**（该源供操作面
  消费时）。
- ⚠️ 本节与协议节**均无代码落地**（manifest schema 未收字段、B1 守卫未扩、无引用表/视图/sync job）。
  **缺席时的门禁行为（2026-10-16 订正）**：manifest 写 `dataDependencies` **不会报错**——
  `ManifestSchema` 未加 `.strict()`，未知字段被 Zod **静默剥离**（写了等于没写、且无任何提示）；
  模块代码里任何 `data.*` 跨 schema 引用会被 B1 报红（这一条是真拦截）。schema 收 `.strict()`
  随采集首管线落地（fail-fast：能力未就绪必须是「不可用且可见」，不是「写了没反应」）。
- 与售后 spec §1.2 的关系：那条「试点期主数据放 aftersales schema、按可搬迁纪律设计、有真实
  第二消费者再决定归属」的判据**到点**——第二消费场景（数据栈操作面）出现后，拍板形态是
  **所有权归采集契约 + 数据模块引用表**，而非抽独立档案模块。售后侧存量 `store`/`product` 表的
  过渡处置**随实施另定**，本节不预设。

### 2.4 采集底座：受管数据集（表单 + 字典）（2026-10-16 拍板）

> **本节是采集底座内核的正典**：表单定义、提交、以及**表单选项（字典）**从哪来。
> 与 §2.3 的关系见本节末「边界」。调研与依据见 explore 仓 `docs/adr/0005-collection-form-layer.md`。

**核心判断**：采集底座的内核是**「受管数据集」一个抽象**，**表单**与**字典**是它的两种形态——
两者都有「定义（版本化）+ 数据（带 org）+ 访问面（稳定接口）+ 纪律（软删 / 审计 / 人审）」，
差异只在**行是什么**与**怎么消费**：

| | 行是什么 | 消费方式 |
|---|---|---|
| **表单** | 提交事件（append-only，无唯一键） | 分析 / 流程 |
| **字典** | 实体（有唯一键、有当前态） | **引用解析** |

> ⚠️ **抽象的落地口径（2026-10-16 拍板）**：**先共用纪律、不共用实现**——表单与字典**同名不同表**
> （各自建表，共享的是上表那套纪律与命名），第二次出现真实重复再抽共享实现（无案例不立标准）。

**铁律：契约里永不含值，只含引用。**
任何"把值拷进表单定义"的做法都会**漂移**——字典新增一个值，已发布表单里的拷贝不变，
且**没有机制会发现**。故表单字段只写引用（`dict:<id>` / 源标识），值由**解析适配器**在**服务端**解析。

**四种适配器（值集实现）**：

| 适配器 | 用于 | 实现 | 今天可用？ |
|---|---|---|---|
| 内联 | 小闭集且描述已给 | 直接 `enum`，**零基础设施** | ✅ |
| 全局表 | 平台标准码（省市区 / 币种） | 带 `-- global-table: <理由>` 豁免的表 | ⚠️ 机制在、零用例（`modules/` 里无人用过）；且该字典平台上**尚不存在** |
| 平台自生 | 业务维护型（产品线 / 检查项） | 受管数据集（字典形态），**org 归属随实施定**（见实施注记） | ✅（形态待定） |
| 外部权威 | 台账档案（门店 / 商品 / 客户） | ~~§2.3 操作面引用表~~ | ❌ **今天无合法通路**：操作面（引用表 / 稳定视图 / sync job）**全仓未落地**（与 §2.3 自身实施注记一致）；今天的门店/商品在 `aftersales.store` / `aftersales.product`（租户级 + `source_id`），**跨 schema 读 = B1 违规**（`dataDependencies` 未实现）。**v1 只有前三种**；第四种待操作面落地或 `dataDependencies` 可用后再议 |

> ⚠️ **外部权威适配器（未来落地时）必须接源投影**：平台已有机制——manifest 声明
> `tenantSources: true` 的模块，宿主任**每请求**注入本租户 `enabled=true` 的源集合
> （键 `platform.tenantSources`，三态 `undefined / [] / ['lemeng',…]`）。
> **字典的可见性因此有两层**：① 授权面（本节末 P4 分档的 scope 矩阵，唯一划线依据）；② **本租户接入的源集**。
> 少了第 ②，未接入某源的租户会看到该源的选项。

**绑定强度（一等设计项，不是可选项）**：**v1 只落两档**——`required`（必须在集合内）| `open`（自由文本）。
`extensible`（集合是建议，允许集合外值但需人审/落"其他"）**v1 不做**（2026-10-16 拍板砍掉，
与 explore 仓 ADR 0005 §3 订正注同步）：人审归属未定、无真实需求案例；真需求出现再随依赖登记。

> ⚠️ 一律 `required` 会**卡死业务**：用户想报一个新问题类型，系统不让填，他只能写进备注 ⇒ 数据脏。
> 参照 **FHIR 的 ValueSet / CodeSystem / binding strength** 的维度清单——**借它不漏维度，不照搬实现**。

**退役语义**：字典值**软删**——`(key, label, enabled, retired_at)`。解析必须支持
**取已退役值渲染历史**，同时在**新提交**时拒绝它。**key 不可变**（只可软删 + 新增）：
改 key 会让历史提交指向不存在的 key ⇒ 渲染空白**且不报错**。

**职责三划**：

| 谁 | 管 | 不管 |
|---|---|---|
| 解析 | **服务端**解析引用 → options，**同一结果供渲染与提交校验** | 前端不得自行解析（否则校验可绕过） |
| 可见性 | **授权面**（本节 P4 分档 scope 矩阵）+ 本租户源集 | 字典里**不塞**可见性规则 |
| AI | 产出**引用**；或**待审的值集草案** | **永不产出生效的值**（实测：让模型生成省市区，它只编了 5 个省） |

**判据：何时才配得上「受管值集」**——任一为真才建：① 被 **≥2 个**表单引用；② 会**变**；
③ 需要**软删 + 历史可解释**；④ 有**权威 owner**。**四个全假 → 内联 `enum`。**

**边界（与 §2.3）**：§2.3 管的是**外部采集来的档案/订单**，其所有权归 `contracts/`。
**平台自生字典不属于档案/订单**，故不受「所有权归采集契约」约束——它是**平台自生的运营数据**，
归承载它的模块。但该模块在**读外部档案**时，仍是 §2.3 意义的**消费者**。

**不做清单（四条反模式，写死）**：

| 反模式 | 为什么不做 |
|---|---|
| 新增"字典服务"组件 | 值集是受管数据集的第二种形态，不是独立服务 |
| **AI 生成 DDL** | 每建一个字典动一次库结构，重、难回滚；AI 产出**数据与结构声明**即可 |
| 字典直读**分析面 marts** | marts 是**分析面**（批次新鲜度、经 BI/问数面消费），字典取值需要**操作面**的实时性与 authz 投影——org 列纪律两层面都遵守，但定位不同不互通 |
| 把值拷进表单契约 | 见「铁律」：必然漂移且无机制发现 |

**实施注记**：

- **模块落点（2026-10-16 拍板）：新建 `modules/forms`**（运营面，与 `modules/data` 治理面域不同；
  且 §2.3 已定「模块只是档案/订单的消费者」）。⚠️ `manifest.id` = DB schema 名 = API 前缀
  （§5 三同纪律），**选错比放错难改**——建模块时随行核一遍三同。
- **字典的 org 归属（P4，2026-10-16 人同意定档；2026-10-27 机制订正）**：**租户私有字典为主**
  （`forms.dict_item`，编辑权 `forms:manage` = 租户管理员）；**平台全局字典单列**
  （`forms.dict_global_item`，`-- global-table` 豁免的**首个真实用例**），编辑权
  `forms:global-manage` 标记 `platformOnly: true`——装载器仍把它供给到各租户 org（平台运营要能
  在 Casdoor 后台授予），但宿主注入**租户管理员**的授权宇宙时会过滤掉它 ⇒ 租户管理员看不到、
  授不了；存量回收同样只能由平台运营在 Casdoor 完成。契约引用以
  前缀分档：`dict:<id>` = 租户私有、`gdict:<id>` = 全局。
  > 📌 订正：本节原两处「§2.2 三角色」是**悬空指针**（platform-core 的 §2.2 是数据栈组件分工，
  > 从未定义过角色清单）——授权划线以本分档的 scope 矩阵为准。
- **依赖未就绪**：跨模块只读声明 `dataDependencies` **当前不可用**（协议与现状警告见
  `docs/module-protocol.md` 同名节；实施随采集首管线「四件套」）。
- **未验证（不得据以写码，实施期实测）**：渲染样式质量、权限投影层、服务端写权限绕过测试、
  超长表单（>40 字段）分段生成。

**指派与催办：名单只存引用（2026-10-19 拍板；设计稿 `docs/superpowers/specs/2026-10-18-form-assignment-and-reminder-design.md` 已人审）**

通知层的 `form.assigned` / `form.due_reminder` 需要一个「**谁该填**」的答案，而 forms 此前**没有任何指派/催办语义**（全模块搜 `assign` / `due` / `remind` / 催办 —— 零命中）。本节定义它。

**核心判断**：**名单是「会变的运营数据」，不是「表单的语义」** ⇒ 按本节铁律「**契约里永不含值，只含引用**」，表单契约只写**对名单的引用**，名单本体由**受管数据集（字典）**承载——复用字典已有的软删 / key 不可变 / 租户 vs 全局双档纪律，**不新增概念**。

**契约形状**（表单定义 `asset_version.body` 新增两个**可选**顶层键）：

| 键 | 形状 | 语义 |
|---|---|---|
| `assignees` | `{ "dictRef": "dict:<id>" }` | 谁该填——**只存引用**；解析走与字段字典**同一套** `dictOptions`（`dict:` 租户私有 / `gdict:` 全局），**不新增解析器** |
| `due` | `{ "afterDays": N }` | 截止 = **发布时刻 + N 天**（v1 只此一种；字段驱动的截止不做） |

- 两键**都缺省** ⇒ 该表单**没有指派语义**：不派生 `form.assigned`、不派生催办规则——**向后兼容，存量表单行为完全不变**（负对照）。
- 名单条目的 **key = Casdoor 用户名**（非显示名）——与 §2.6 通知层「人」的落库键同一套（零转换层）。

**执行流（双入口，与 §2.6 的规则管道同源）**：

- **发布路径**（T9）：契约含 `assignees` ⇒ 发布时解析 `dictRef`（**只取 enabled 条目**）→ 逐人 emit `form.assigned`（`event_id` **确定性**：`form:<assetId>:<version>:assigned:<user>`）→ 声明派生催办规则（幂等）。
- **定时路径**（T11，**openship job** 跑仓内脚本）：对每个「含 `assignees` + `due`」的已发布表单：`due = published_at + afterDays`；**未提交** = 名单 − { 该版本 `submission.submitted_by` } → 逐人 emit `form.due_reminder`（`event_id` 含日期：`form:<assetId>:<version>:remind:<user>:<YYYY-MM-DD>`）。

**幂等**：两处 `event_id` 都**确定性派生** ⇒ 重复发布 / 重复调度天然去重（回执表 `unique(event_id, rule_id)` 兜底）。

> ⚠️ **定时载体 = openship job**（2026-10-19 拍板，方案对比见 `docs/superpowers/specs/2026-10-18-notify-emit-seam-and-scheduler.md`）：
> job 跑**仓内脚本**（照 `deploy/data-compose.yml` 的 dbt runner 范式：openship 打 `docker run` 一次性容器，**零常驻**），
> 脚本**直接 import `modules/notify/**`** 对 DB 操作——`scripts/` **不在** `lint-architecture.mjs` 扫描根（`apps/ packages/ modules/`）内 ⇒ **不触 B1**。
> ⇒ **in-platform 这一半既不需要 HTTP、不需要令牌、更不需要跨模块通路。**

**不做清单（v1 写死）**：

| 反模式 | 为什么不做 |
|---|---|
| 多级 / 条件指派 | 无真实案例（无案例不立标准） |
| 按角色 / 组织架构自动展开名单 | 需外部权威通路——本节「外部权威适配器」今天**无合法通路** |
| 字段驱动的截止（从提交里取日期） | v1 只做「发布后 N 天」；真需求出现再加 |
| 补填 / 代填 | 提交面只认 `submitted_by`；代填是另一套权限语义 |
| 名单变更后重发 `form.assigned` | v1 只在发布时发一次；名单变更走**催办**兜底（下次调度自然覆盖） |
| **门店作为 subject**（主体注入） | **演进项**：触发条件 = **首个真实门店巡检表单上线**（届时连带设计「`readOnly` 字段值从哪来」的**主体注入机制**）。今天唯一真实样本 `site-inspection` 的 `storeNo` 是 `readOnly`，但**全链路无服务端注入通路**（`readOnly` 今天**只拒不留**）——为假想需求先造主体注入 = 为不存在的案例付基建成本 |

**实施注记**：

- v1 名单 = **人**（`submitted_by` 与名单**直接对账，零新机制**）；门店 subject 见不做清单末条。
- **待实测**：名单 N=500 时的调度耗时与 Novu 限速（T11 验收项）。
- **`due` 重算口径**：以**当前 published 版本**的发布时间为准（表单回滚/重发是否重算，待实测确认）。

### 2.5 数据面归属与「域」维度（2026-10-17 拍板）

> **本节由真实缺陷倒逼，不是推演**：M1.4 forms 出湖（#729）实施时把 console 落在**山海**数据面，
> 而源租户是 **mytech** ⇒ 落湖行被标成 `shanhaiyiguo-org`。裁决与回迁步骤见
> `docs/superpowers/plans/2026-10-16-forms-out-lake-m1.4.md` 裁决节（本节的**实施**一律指该处 R1–R7）。

**先分清两个词**（此前混用，是这次缺陷的认知根源）：

| 词 | 指什么 | 事实源 |
|---|---|---|
| **租户**（tenant） | 业务主体；平台侧一行 `platform.tenant`，带 `casdoor_org` | `platform.tenant` |
| **域**（domain） | **一类数据的采集/建模归属**（`lemeng` 零售、`forms` 表单…） | `dbt/models/<域>/` + `contracts/` |

**三条不变量**（均属 §4.2「仅文档」档——**无门禁，靠评审与人守**）：

1. **一个数据面 = 一个租户**。数据面是**按租户交付的部署单元**，不是多租户共享的湖；
   §2.2 第 1 条「每租户桶/前缀」说的是同一件事的**存储侧**。
   **驱动因素**：今天的独占面是**私有化交付**的产物（山海独占一机），不是「多租户 SaaS 必须一面
   一租户」这条通则。**反转条件**：若将来有租户是纯 SaaS、不配独占面（成本使然），本条失效——
   那时第 3 条**必须**跟着翻转，见下。
2. **部署租户 ≡ 数据归属租户**。落进该数据面的每一行，其租户归属**必须**等于部署租户。
3. **主体列由部署面注入，永不进湖**——**第 1 条成立时的推论，不是独立通则**。`org` 是**行级授权
   主体列**（`modules/data/domain/authz.ts` 恒拼 `WHERE org = '<orgId>'`），值取部署租户的
   `subject_org()`（`dbt/macros/subject_org.sql`，空串 **fail-closed**）。
   在「一面一租户」下它是**授权谓词**，不是数据的一部分——落进湖只会多出一个「可能与部署主体
   不一致」的副本，而**没有机制**会发现两者漂移（现有 15 份契约——含 forms 本份——**无一把 org
   存进湖**；`_schema.schema.json` 与 `_template.contract.json` 不计，见
   `scripts/lib/data-contract.mjs` 的 `NON_CONTRACT`）。
   ⚠️ 第 1 条一旦反转（共享面），本条**随之翻转**——`org` **必须**回到湖里，否则租户无法区分。
   两条是**绑定**的：**别单独引用第 3 条**。

> **为什么违反第 2 条不是「标签问题」**：标 `shanhaiyiguo-org` 的 mytech 数据，
> **山海用户看得到、mytech 用户看不到**——这是**跨租户可见**，不是显示错误。

**「域」维度：一个部署只物化自己的域**

两个租户各跑一个数据面，但**共用一棵 `dbt/` 树**，而物化是**全量 build、无 `--select`**
（`scripts/lemeng/materialize.sh` 的 `mat_dbt_args()`；#679 刻意——名单曾是事实全量，按需会漏）
⇒ 不加约束时**两侧都会 build 对方的模型**，且两种失败都很响：

| 侧 | 后果 |
|---|---|
| **本方**全量 build 对方模型 | 读同一个湖 ⇒ **会成功**，把对方租户的业务数据物化进本方仓库、标成**本方** `org` ⇒ **反向泄漏**（方向与 #729 相反） |
| **对方**继续 build 本方已迁走的域 | 前缀一空 ⇒ dbt 红 ⇒ `exit 1` 发生在写 `load_log` **之前** ⇒ 水位冻结、**所有**指标的新鲜度连带退化（#752 那个 bootstrap 缺陷的复发形态） |

⇒ **域归属必须由部署面裁剪**（2026-10-17 拍板）：

- **目录即域**：`dbt/models/<域>/{staging,marts,views}/`（现 `common/` 按域拆开）。
  `scripts/check-data-models.mjs` 的 `STAGING_RE` / `MARTS_RE` 已是 `models/(?:.+\/)?staging/`
  ⇒ **判据不用改**（只有错误文案里写死的 `models/common/staging/` 要跟着改）。
- **二维格子：域是顶层轴，客户分叉嵌在域里**——
  `dbt/models/<域>/customers/<客户>/{staging,marts,schema.yml}`。`common/` **溶解**成域的默认
  （`models/lemeng/...`）：`customers/README.md` 自己定义 `common/` 是「**所有客户共用**的域
  （当前只有乐檬）」——它本来就是「乐檬域内各客户共用的部分」，**不是「全公司通用」**。
  **✅ 已落地（2026-10-17，R2）**：动手时实测 `dbt/models/customers/` 下**只有 README、没有任何
  真客户子目录**（格子是空的）⇒ 这是搬格子的最便宜窗口，已照此拆开（`common/` → `models/lemeng/`，
  `customers/README.md` → `models/README.md`，forms 建 `models/forms/`）。
  ⚠️ 代价不是「纯仓内」：`dbt/` 在 `deploy/data-plane-manifest.txt` 是**投递项** ⇒ 重命名会改
  lock ⇒ **合入后山海侧必须重新 sync 数据面工件**，不是零运维动作。
- **开关机制 = `dbt_project.yml` 按路径 `+enabled`，值由 `env_var()` 给**（2026-10-17 实测，
  见下）。合 `materialize.sh` 头注的成文处方「用该模型的 config 表达，**不要恢复 job 级名单**」。
  实测形态（dbt-core 1.9.1 + dbt-postgres 1.9.1，即 `deploy/dbt/Dockerfile` 钉的版本；scratch
  工程 `dbt parse` 后读 `target/manifest.json` 的 `config.enabled`）：

  ```yaml
  models:
    platform_data:
      lemeng:
        +enabled: "{{ 'lemeng' in env_var('DATA_PLANE_DOMAINS').split(',') }}"
      forms:
        +enabled: "{{ 'forms' in env_var('DATA_PLANE_DOMAINS').split(',') }}"
  ```

  四条实测结论（**每条都是踩点，不是推论**）：

  | 实测 | 结果 |
  |---|---|
  | `DATA_PLANE_DOMAINS=forms` | manifest **只剩 forms 的模型**（`lemeng` 的**整个不出现**，不是 `enabled:false` 挂着） |
  | `env_var('DATA_PLANE_DOMAINS')` **不带默认值**，变量未设 | **parse 报错**（`Parsing Error`）⇒ **fail-closed** ✅ |
  | 同上但带默认值 `env_var(..., '')` | 解析成空串 ⇒ **0 个模型、`dbt build` 退出 0** ⇒ **`MATERIALIZE_OK` 假绿** ❌ **默认值绝不可给** |
  | 域目录存在但 `dbt_project.yml` **没登记** | **默认 `enabled=true`** ⇒ **每个面都会 build 它** ❌ |

  ⚠️ 另：`+enabled` 里**不能引用本文件 `vars:` 块的 var**——`models:` 配置块的渲染早于工程 vars，
  报 `Required var 'x' not found in config: Vars supplied to <Configuration> = {}`（实测）。
  `--vars '{"domains":"…"}'` 可以，但那样部署身份就跑到 job 参数里了；**用 `env_var()` 更好**
  ——身份与 `LEMENG_SUBJECT_ORG` / `LEMENG_ZOS_BUCKET` 同住 env 层。

  ⇒ **必须配一条 fail-closed 门禁**（上表后两条）：枚举 `dbt/models/*/`，每个域目录**必须**在
  `dbt_project.yml` 里有显式 `+enabled` 条目（某侧拥有／显式声明休眠）。没有它，**新增域目录
  而无人登记 ⇒ 两侧都 build ⇒ 反向泄漏**；**变量漏配 ⇒ 零模型静默 `MATERIALIZE_OK`**。
  两个方向都静默，正是 #677/#679 假绿的同形。
- **两侧 materialize job 各传自己的域**。⚠️ **`materialize.sh` 必须改，不是「无需改脚本」**：
  `mat_env_args()` 是**写死的 8 键清单**（`scripts/lemeng/materialize.test.sh` 还钉了「`-e` token
  恰 8 个」并逐键枚举）⇒ 新 env 不进去，dbt 根本收不到；只有容器/网络/平台库那几个参数是已支持
  env 覆盖的。

**桶的归属**：数据面用**自己租户的桶**。跨租户复用桶 = 把本方域的数据写进**对方的桶**
（与交付边界相悖），且把上表的反向泄漏从「配错才发生」变成「隔离一失效就发生」。

**今天的状态（如实——别照不变量假设现状已合规）**：

- mytech 数据面（`proj_SU8cmQ8OLVfM971X` / server `23a1091e`）是 2026-09-24 建了却
  **从未启用**的桩：Gate-B 不通（`getent hosts pg_duckdb` 无记录）、`warehouse` 库空、
  pg_duckdb **无湖凭据**、`dbt`/`duckle` 服务行 disabled 且卷是**相对 bind**（被当卷名，已知坑）、
  无物化 job。
- 湖侧现有 4 个桶（2026-10-17 实测：`after-sales` / `bucket-5b9f` / `lemeng-datasource` /
  `shanhai-data`）——**没有 mytech 自己的湖桶** ⇒ 回迁含**开桶**这个人工前置。
- forms 当前**借跑在山海数据面** ⇒ org 错标为 `shanhaiyiguo-org`。
  🚨 **回迁完成前不得为 forms 声明 L1 指标**——org 是行级授权主体列，**第一个指标即泄漏**。

**待人拍板（机制已实测，范围未定——下列不许按「已定」实施）**：

| # | 待定 | 候选 / 理由 |
|---|---|---|
| 1 | **域开关机制** | ✅ **已实测并选定**：`+enabled` + `env_var()`（**不带默认值**），见上表。~~② 派生 `--select path:`~~ 不再需要。**仍待定的是配套的 fail-closed 域覆盖门禁怎么写** |
| 2 | **是否现在做 `common/` → `models/<域>/` 重命名** | 现在格子是空的（`customers/` 无真子目录）⇒ 最便宜；但要动 lock + 山海重 sync |
| 3 | ~~是否把「按域分次 build + 分次落账」纳入域裁剪的范围~~ | ✅ **已落地（2026-10-17）**。改动前 `data.load_log` 只在 dbt **全绿后**写 ⇒ **任一模型红，全部 relation 的 `data_as_of` 一起停** —— 同日实测**两次**（#833 与 #834 各自新增的 audit 各红一次，两次都冻结全量）。现在 `materialize.sh` **逐域**跑：红的域不落账、其余域照常落账，最后统一 `exit 1`（仍不是按需名单：命令还是 `build`、无 `--select`，域裁剪仍由 `+enabled` 表达） |
| 4 | **「源 ≠ 部署」这类缺陷怎么发现** | 三条不变量今天**无门禁**（§4.2「仅文档」档）。配置一致性检查**抓不到** #729——那次是**源**（mytech 的导出 API）与**面**（山海）不一致，两侧配置各自自洽。可用的抓手：导出响应**带 `org`**（计划稿 A2）⇒ 管线里断言「本页 `distinct(org)` ⊆ 部署主体 org」，不通过**拒写湖**。**当前不存在这条断言** |

### 2.6 通知基础设施：事件声明 + 绑定规则 + 平台投递（2026-10-27 重构）

> 本节是通知域的**正典摘要**；完整设计、数据模型与验收在
> `docs/superpowers/specs/2026-10-27-notification-infrastructure-design.md`，
> 实施计划 `docs/superpowers/plans/2026-10-27-notification-infrastructure-p1.md`。
> **2026-10-27 重开 2026-10-18 的「不自研投递」取舍**：目标从「只补绑定层」变成
> 「事件目录 + 模板 + 通道 + 预览发布 + 收件箱」，原取舍前提不成立。

#### 四层职责

| 层 | 负责 | 落点 |
|---|---|---|
| 事件声明/目录 | 模块声明「我能发什么」；宿主校验并登记 | manifest `notifications.events`；`platform.event_catalog` |
| 绑定规则 | 事件 × 作用域 × 收件人 × 模板 × 通道（+节流） | `notify.rule` |
| 模板 | 草稿/版本/预览/发布；租户管理员审批 | `notify.template` / `notify.template_revision` |
| 投递 | outbox → worker → provider；重试/退避/限流/回执 | `notify.event` / `notify.delivery` / `notify.delivery_attempt` |

#### 接入协议

模块在 manifest 声明事件（key/scope/payload/recipients/defaults），宿主装载期：

1. 建内存注册表 + `platform.event_catalog` 快照（只对本次已加载模块标 inactive）；
2. 注入 `ctx.notify.emit(identity, event)`（任意模块可用；`ctx.events` 只读目录给管理面）；
3. 模块只发事件、不直接调 notify/Novu；契约违规**拒绝入队但不阻塞业务**。

事件 key = `<module>.<entity>.<event>`，前缀 = manifest.id；payload 只增不改，改语义 = 新 key。

#### 规则与收件人

- 规则五元组：`event_key × scope × recipient_key × template_key × channels`；`manual > derived`，
  精确 scope 优先于 `*`。**不做条件/延迟/摘要**。
- 收件人：`field`（payload 的 user/user_list）、`scope_holders`（本 org 持有权限码）、`literal`
  （人工名单）。平台解析到 Casdoor 用户，再按通道解析地址（企微 userid 走
  `platform.identity_link`；映射不到 = `failed`，**不假装成功**）。
- 派生：事件声明的 `defaults` 幂等派生默认规则（零配置就通）；`scripts/notify-seed-builtin.mjs`
  在开通/升级时 seed 模板、默认通道与默认规则。

#### 模板与发布

- 模板正典在 DB（`origin=builtin` 由 repo seed；租户可 fork 成 `origin=tenant` 草稿）。
- **预览与投递共用同一渲染函数**；发布 = 租户管理员（`notify:publish`）动作；AI 只能提草稿。
- 版本不可变；回滚 = 发布旧 revision。

#### 通道与投递

- 内置 provider：`wecom_chat`（公司 bridge 直发）、`in_app`（自建 `notify.inbox`）、`webhook`（P3）。
  **不做运行时插件/外部沙箱**；租户只能启用/配置平台预备的通道实例。
- 通道密钥：DB 只存 env 键名（`secret_refs`），值只在 openship env（isSecret）。
- 投递：`notify.event` 入队 → `notify-worker`（独立进程，租约 + `SKIP LOCKED`）→ provider；
  至少一次、指数退避、企微 45009 退避；`notify.delivery` 是唯一回执事实源。
- **fail-open**：通知失败不阻塞业务；`dead`/积压由 `scripts/notify-health.mjs` job 报警。

#### 与 Novu 的关系（2026-10-27 变更）

- **Novu 退出 platform-core 关键路径**；企微 bridge 保留（它不是 Novu）。
- 旧 `modules/notify/novu/**`、`NOVU_*` env、`notify-reconcile` 的 Novu resolver 已退役。
- 公司其他项目仍可用 Novu；本条只约束本仓。

#### 权限与边界

- `notify:view` / `manage` / `publish` / `channel` / `emit`；`emit` 只给服务/PAT。
- 所有业务表 `org text not null` 首列；org 只来自 identity。
- 明确不做：邮件 / 短信 / digest / 条件规则 / 多级路由 / 偏好中心 / 消息队列。

#### 产品面（P2，2026-10-27 交付）

- console `/console/notify` 六区：事件目录 / 规则 / 模板 / 通道 / 投递 / 收件箱。
- 模板：草稿 → 预览（**与投递同一渲染函数**）→ 发布/回滚；发布需 `notify:publish`。
- 通道：启停 / 非敏感配置 / 健康检查；密钥只显示 env 键名，**不回显值**。
- 测试发送：收件人强制 = 当前登录人；不提供「发给别人」的 UI/工具。
- MCP：12 个工具（发现 / 规则 / 草稿 / 预览 / 回执 / 自测），**无 publish/channel 工具**；
  写操作落 `notify.audit`。

#### 收口（P3，2026-10-28 交付）

- **`webhook` 通道**：只允许 https；拒绝私网/回环/链路本地/元数据地址（字面量 + DNS 解析后双重校验）；
  **不跟随重定向**；超时 5s；body ≤ 32KB；带 `X-Notify-Signature`（HMAC-SHA256 over `ts.body`）与
  `X-Notify-Timestamp`。目标 URL 与密钥只在 env（`NOTIFY_WEBHOOK_URL__<ORG>__<CHANNEL>` /
  `NOTIFY_WEBHOOK_KEY__<ORG>__<CHANNEL>`）。
- **每通道限流**：`notify.channel.config.rate_limit_per_min` 真正执行（窗口内 `sent` 计数）；
  命中即顺延一个窗口，回执记 `channel_rate_limited`。缺省 0 = 不限。
- **健康面**：`notify-health` 除 dead/积压/心跳外，还报 `oldestPendingSeconds` / `failedLastHour` /
  `channelErrors`（近 1 小时失败 > 50 判红）。
- **保留期**：`notify-retention` job（每日）清 `inbox` 90 天 / `delivery_attempt` 180 天 /
  `delivery` 365 天，**只删终态**。两个 job 的口径见 `deploy/notify-jobs.md`。
- **收件箱**：`POST /inbox/read-all` 批量已读（只作用于调用者本人）。

#### 可送达性（D2，2026-10-28 交付）

> 设计：`docs/superpowers/specs/2026-10-28-notify-deliverability-design.md`。
> 触发案例：`aftersales:manage` 在 mytech 无持有者 ⇒ 事件零投递，而事件标 `matched`、
> health 全绿——**失败没有被建模成状态，所以不可观测**。

**收件人解析只有一个实现**：`modules/notify/domain/deliverability.ts` 的
`resolveDeliverability()`。worker 调它；D3/D4 的 HTTP 预检与 MCP `check_rule` 会调同一个函数
（防止「预检说能发、实际发不出」）。

**`notify.event.status` 完整取值**（多规则聚合：**有产出一条 delivery 即 `matched`**，
否则取最严重者，严重度 `invalid > no_channel > no_recipients`）：

| 状态 | 含义 |
|---|---|
| `new` | 待处理 |
| `matched` | 至少产出了一条投递（真的要发） |
| `no_rules` | 无规则命中 |
| `no_recipients` | 有规则但解析出 0 人 |
| `no_channel` | 有人但通道全停用/缺失 |
| `invalid` | 事件声明或模板缺失 |

**判红口径**（`notify-health`）：`eventsNoRecipients > 0` 或 `eventsNoChannel > 0` **直接红**
——这是**配置错误**，不是流量波动，不给阈值；`eventsInvalid > 5` 才红（模板轮换期会短暂出现）。

#### 实施注记

- 竖切：aftersales 员工审批（`aftersales.employee_approval.pending`）；五条负对照见 spec §13.3。
- 待实测：bridge `to=` 映射、Casdoor scope 持有者枚举、N=500 限流；未见证前不得声称可用。

### 2.7 湖的存储格式：保持纯 Parquet，不引入 lakehouse 表格式（2026-10-20 拍板）

> **本节是决定本身**；证据、被否决的收益、反转条件与全部实测数据在
> `docs/superpowers/specs/2026-10-20-lake-format-decision.md`（决策记录）。

**决定**：湖继续是 **hive 分区的纯 Parquet**（`snk.minio` 写、`read_parquet` 读）。
**不引入 DuckLake**，也不引入 Iceberg / Delta。

**技术上是可行的**——2026-10-20 实测：duckle 有**全套原生件**（`src.ducklake` / `snk.ducklake` /
`src.ducklake.maintain` / `src.ducklake.changes` / `src.ducklake.diff`，按采集正典 §1.1 属**档①**），
pg_duckdb 1.1.0 **能装能载** `ducklake` 扩展，catalog 可以是 `postgres:` DSN。
⇒ **否决是取舍，不是不可行。**

**否决的三条理由**（都与工作量无关）：

1. **「系统记录」会被反转**。今天**对象存储就是真相**——桶里是自描述的 Parquet，任何有 S3 凭据的
   引擎/人**都能读**，`_SCHEMA/v<N>.parquet` 是**人能直接看懂**的标记，「裸读湖」这条**取证生命线**
   只依赖 S3 凭据。换成表格式后 **catalog 数据库成为真相**：备份/恢复变成「桶 + catalog 且必须一致」
   两个系统；catalog 挂 = **全湖不可读**；取证也要 catalog 在线。**这三条长尾都是永久的。**
2. **格式锁定单一引擎家族**。Parquet 是通用交换格式（Metabase / psql / DuckDB / Spark / Trino /
   Polars / pandas…）；DuckLake 目前基本只有 DuckDB 家族能读，且**退出成本高**
   （没有 catalog 就是「一袋无语义的文件」）⇒ **留在纯 Parquet 是选项最多的位置；换表格式是关选项，不是开选项。**
3. **本栈读写两端的 DuckDB 版本永远不同步**（实测：duckle 0.7.4 → **v1.5.5**，pg_duckdb 1.1.0 →
   **v1.4.3**；ducklake 扩展**按 DuckDB 版本分目录**）。duckle 按正典「永远用最新版」、
   pg_duckdb 的内嵌版本由 **pg_duckdb 的发版**决定 ⇒ **两条线独立演进，duckle 永远在前**。
   这条**无法靠一次升级解决**。

**而它换掉的那些手搓件**（封版标记 / 契约生成器 / 重述窗口 / 回填=重放）**今天都有更小的解法且已在跑**；
DuckLake 真正**不可替代**的能力（行级改 / 时间旅行 / 多写方并发）我们**用不满**——源是外部 API 拉取、
append-only，修数偶发而非常态。

**反转条件**（出现任一即重新评估；**不是「永不」**）：多写方并发写湖 / 行级修数常态化 /
出现多源 upsert / 布局改造后小文件仍解不掉 / 出现 DuckDB 之外的计算引擎需求（那时该选 **Iceberg**）。

**两件「无悔动作」**（无论走哪条路都该做；⚠️ **本节不授权实施**）：
① 明细 `partitionBy` **小时 → 天**（它是全湖**唯一**的小时分区资产，也是唯一慢的）——动湖布局，
走 §5.1 / §5.2 的流程；
② **把「读湖」抽象成一层**（现在 `read_parquet(...) r` 散在 18 个 staging 模型里）——
**这才是真正「保留选项」的动作**：将来换任何格式，改的是这一层而不是全仓。

⚠️ **要不要把本节升格成 §4 的不变量，是另一个决定**：本仓规矩「无案例不立标准」，
现在只有这一次决策案例 ⇒ 先落本节，**不升格**。

### 2.8 数据 MCP 的沙箱执行面（2026-10-23 拍板，issue #1002）

> **本节是「沙箱在哪跑」的边界与口径**（D-W3-4 由「待沉淀」转为已定）。代码落在
> `modules/data/domain/pipelines/`；本节不写实现细节，只定**落点、隔离、凭据与失败语义**。

**决定**：沙箱执行面 = **单元 A 新增一个常驻 `sandbox-console` 服务**（`duckle-runner serve`，
与 `lemeng-console-*` **同镜像同 API**），**不发布任何宿主端口**，只经单元 A 默认网络被 `server`
调用；草案与回执走**两服务共享的命名卷** `sandbox-workspace`，不跨项目、不动宿主网络。

**为什么不是另外三种**（各一条，均已实测）：

| 方案 | 否决理由 |
|---|---|
| 装进 `server` 镜像、进程内跑 | 草案里一旦有执行任意代码的节点（`code.*`，见下），它就在**持有 Casdoor 管理员口令 / `DATABASE_URL` / LLM key 的容器里**执行。沙箱校验当前**只挡 sink**（`sandboxViolations` 实测不拦 `code.shell`）⇒ 校验一被绕过就是平台被拿，不是「试跑失败」 |
| 放进单元 B（`data-compose.yml`） | 单元 A 与单元 B 是**两张 docker 网**（2026-10-23 实测：`server` 在 `172.18.0.3`，数据面 console 侧在 `172.19.x`；`lemeng-console-3120` 从 `server` 容器内**不可达**，而 `pg_duckdb` 因被双挂才可达）。要接线只能建 external network（**宿主级手工操作，不经 compose**）或把 console 发布到私网 IP——后者**直接违反 §1.3 的回环规矩** |
| 文件队列 + 自研 watcher | 要造一个**非引擎自带**的执行器；异步链路多一段自造机制要验证。没有案例支撑，不立这条 |

**已验证的引擎面**（2026-10-23，`lemeng-console-3120` 容器内实测；供实现照抄，**别重新发明**）：

| 面 | 事实 |
|---|---|
| CLI | `duckle --pipeline <file> --workspace <dir> --duckdb <path>`；可选 `--memory-limit / --threads / --temp-dir / --max-temp-size / --target / --param / --name`。`duckle validate --json` **不需要凭据、不需要 DuckDB 网络面**（引擎帮助原文） |
| HTTP | `POST /api/run`（**同步等整条跑完**）、`POST /api/run/async`，body `{"file":"<工作区相对路径>","params":{…}}`；`GET /api/runs`（含 `status/durationMs/rows/error/trigger`）、`GET /api/pipelines`（含 `running/lastStatus`）、`GET /api/schedules`；认证 `Authorization: Bearer $DUCKLE_TOKEN`（实测：不带凭据一律 401，`/healthz` 除外） |
| 组件面 | `duckle components schema --json` 返回 **417** 个组件（`xf` 144 / `src` 133 / `snk` 81 / `qa` 30 / `ctl` 22 / **`code` 7**）。7 个 `code.*` = `code.shell / code.python / code.javascript / code.rust / code.wasm / code.sql / code.sqltemplate` |

**已销账（2026-10-23，读 duckle 引擎源码定案）**：

1. `/api/pipeline`（单数）**只有读**：`GET /api/pipeline?file=<工作区相对路径>` 返回一份管线文件
   （`duckle-runner/src/serve.rs` 的路由表）。**没有任何「保存草案」的写接口** ⇒ 平台侧写草案
   只能**直接写共享卷**（现状即如此，不是权宜之计）。
2. `serve` **不接受** `--memory-limit / --threads`：`ServeArgs` 只认
   `--host / --port / --workspace / --duckdb / --token / --tick-interval`，传别的直接报 unknown argument。
   引擎取的是**进程环境变量** `DUCKLE_MEMORY_LIMIT` / `DUCKLE_THREADS` / `DUCKLE_TEMP_DIR` /
   `DUCKLE_MAX_TEMP_DIR_SIZE`（`duckdb-engine/src/lib.rs`）；`serve` 启动时只会用工作区
   `.duckle/settings.json` 的 `memory_limit_mb` 兜底设置内存上限（环境里已有值时不覆盖）。
   ⇒ 容器化部署的资源上限 = **compose 服务行 env**（写 `DUCKLE_*`）；容器级 `mem_limit`/`cpus`
   是硬上限（超了 OOM），`DUCKLE_MEMORY_LIMIT` 决定 DuckDB **何时落盘**——两者不是一回事，都要设。

**已销账（2026-10-23 生产 `sandbox-console` 实测）**：

- 草案放 `<workspace>/sandbox/<runId>.json` **可以**（`/api/run` 收 `pipelines/` 之外的相对路径），
  `GET /api/pipelines` 会把 `sandbox/*.json` 一并列出（带 `running/lastStatus`）。
- **`POST /api/run`（同步）返回体带逐节点结果**：`nodes:[{id,status,rows,durationMs,error}]`；
  回执 `runs/receipts/<引擎 runId>.json` 同样是逐节点 `nodes:{<id>:{status,kind,rows,durationMs}}`。
  `/api/runs` 列表只带汇总（`id/name/file/at/status/durationMs/rows/nodeCount/trigger/error`），**没有唯一 runId**。
- ⚠️ **解析失败的草案在异步路径上是黑洞**：`POST /api/run/async` 照回 `202 {status:"queued"}`，
  但不进 `/api/runs`、不产回执、`/api/pipelines` 里 `running:false` 且 `lastStatus` 留 `null`
  ⇒ 执行面只能轮询到超时后回 `running`（「还在跑」），其实**根本没跑**。同步 `/api/run` 对同一
  草案直接回 `400 {"error":"parse …: missing field \`label\`"}`。
  引擎必填而**校验器一度没查**的两个字段：节点 `position:{x,y}`（数值）、`data.label`（字符串，可为空串）。
  已在校验器补上（见 `validate.ts`）。**引擎侧的异步黑洞本身没修**（异步接口行为不变），
  本工具改为**不再走它**，见下「交换协议」。
- **同步 `/api/run` 对长跑没有服务端时长上限**（2026-10-23 生产 `sandbox-console` 测量）：
  1.7s / 14.7s / 36.9s / 71.0s / 71.4s / 72.2s 六次全部 `200` 返回完整逐节点结果，
  `time_total` 与引擎 `durationMs` 对得上（如 72.160s ↔ 72160ms）。处理器是阻塞直调，
  源码里连接上只有 **30s 的单次读/写停顿**保护（`serve.rs` 的 `READ_TIMEOUT`），不是总时长上限。
  ⇒ 此前一次「sync 长跑 120s 不回」的观测是**量具造成的假象**（curl 挂在 openship exec 的 120s 上限里被截断），
  不是引擎截断。判长跑行为时先把观测挪到不受调用方上限约束的位置（后台跑 + 落文件 + 事后读）。
- **客户端断开不取消运行**：`curl -m 10` 在第 10 秒断开，该 run 仍在服务端跑到 71.4s、`status: ok`，
  回执正常落盘。⇒ 平台侧等待预算耗尽只表示「我们不等了」，**不是「运行被杀了」**。
- 同步响应体**带唯一 `runId`**（`run-manual-<pipeline>-<毫秒>`）⇒ 认领一次运行不再需要靠回执猜。
- 同步路径**不取** per-pipeline runlock（异步路径的 `claim_for_run` 才取）⇒ 同名管线的排他完全
  依赖本工具的进程内单飞。
- 一次未复现的孤例（2026-10-23 10:14:20）：一条 run 记录为 `interrupted / durationMs 0 / nodes {}`，
  回执无 `finishedAt`；同规模另三次均 `ok`。源码里 `interrupted` 的语义是「所属进程已死的运行被回收」。
  **不据此改语义**，仅留档待再见。

**服务形态**：
- `sandbox-console`：`build: { context: .., dockerfile: deploy/duckle/Dockerfile }`，
  `duckle serve --host 0.0.0.0 --port 18090 --workspace /workspace --duckdb /usr/local/bin/duckdb`。
  **无 `ports`**（宿主不可达；`--host 0.0.0.0` 只是容器内网卡，不构成对外暴露）。
- `DUCKLE_TOKEN` 必配（openship env，isSecret；空 token 由 `entrypoint.sh` 拒跑）。同网络内能到它的
  只有本项目的 `server` / `postgres` / `openclaw`——都是我们自己的容器。
- 卷 `sandbox-workspace` **同一命名卷挂两次**：console 侧 `/workspace`，server 侧 `/run/duckle-sandbox`
  （**同 project 命名卷，不写绝对宿主路径**；与 #1001 那两条跨项目绝对路径挂载不同，别照抄错）。
- 资源：容器 `mem_limit` + `cpus` 是**硬上限**；run 级预算参数见上「未验 2」。
- ⚠️ 它会出现在**每个**用本 compose 的项目（同 `lemeng-console-*` 的教训）：不需要的项目在 openship
  服务行 `enabled: false`，**别忘**。

**交换协议（server 侧，实现照此）**：
1. 写草案到 `<共享卷>/sandbox/<runId>.json`（该路径已实测可跑，见上「已销账」）；
   ⚠️ 共享卷根目录归 `root`，而 `server` 是 uid 1000 ⇒ `sandbox/` 必须由 console 侧预建并交权
   （`entrypoint.sh` 的 `DUCKLE_SHARE_DIR`），否则第一步 `mkdir` 就 EACCES；
2. **一次同步调用** `POST /api/run {"file":"sandbox/<runId>.json"}`，挂到跑完为止；
   等待预算由 `DATA_SANDBOX_TIMEOUT_MS` 给（语义 = **平台愿意持有的时长**，不是轮询上限），
   客户端超时只断开我们这一侧，运行仍在引擎里继续（已实测）；
3. 响应分三种，**不存在「不知道跑没跑却报 running」的第四种**：
   - `200` ⇒ 用响应体的 `runId` / `status` / `nodes[]`（逐节点 `status/rows/durationMs/error`）出结论；
   - `400` ⇒ 草案解析不过，body 是引擎原话 ⇒ `refused / engine_parse_error`，**不进执行面统计**；
   - 预算耗尽 ⇒ `unknown / sandbox_run_timeout` + 我们的草案 `runId`，并**再查一次**新回执
     （开始前快照 + mtime 认领）以捡回刚好在边界跑完的结果；捡不到就如实说「仍在跑、结论未知」；
4. 审计照旧落 `data.query_audit`。

**两条硬约束（比「跑起来」更重要）**：

1. **组件白名单（默认拒绝）**。沙箱 v1 的规则是**族级 allowlist**：只放行 `xf` / `src` / `snk` / `qa` / `ctl`
   五个内置族；**`code.*` 七个全部拒绝**（执行任意代码/脚本）；**`ctl.foreach` 也拒绝**（它把执行委托给
   子管线文件，而子管线不在本工具的校验范围里）；**不在五个族里的组件一律拒绝**。
   ⚠️ 逐条 417 项评审**尚未做**（标「待沉淀」）——在那之前，族级 allowlist 是**有意收窄**的边界，
   **不是「全放行」**。名单与理由落在 `validate.ts` 注释里（唯一事实源；本文件不复制）。
   ⚠️ 这条不是优化项：执行面接上以后，它的缺口是**可直接执行**的，不是理论风险。
2. **凭据两档，默认无凭据**：
   - **默认档（本轮落地）**：`sandbox-console` **不带任何生产凭据**。能跑 `validate`、无鉴权源、
     本地 CSV/构造数据；需鉴权的源会在源节点失败 ⇒ 工具**如实回** `status: failed` + 引擎错误原文，
     **绝不**把「源 401」读成「草案没问题」。
   - **opt-in 档（有真实案例再落；标「待沉淀」）**：按账套给**只读**凭据。**一个账套一个 sandbox 服务**
     （同 ADR-0014 的理由：运行面继承 console 的 env，一套 env 只能对应一个账套）⇒ 凭据只存在沙箱服务
     自己的 env 里，**永不进 `server`**。另外 `src.rest` 的 `method` 在 opt-in 档要**限 GET**（否则草案
     可借源凭据对外 POST）；`__sandbox/` 前缀能否再由 ZOS 侧 key 策略兜底**待核实**。

**失败语义（工具面；与 `verdictOf` 对齐，别让「空」变「拒」）**：

| 情形 | `status` / `reason` | `isError` | 审计 verdict |
|---|---|---|---|
| `DATA_SANDBOX_URL` 未配 | `not_executed / sandbox_runner_unconfigured` | false | ok（未知 ≠ 失败） |
| console 不可达 / 401 | `unknown / sandbox_unreachable` | true | ok（不是草案的错） |
| 结构校验不过 | `refused / invalid_draft` | true | denied |
| **引擎解析不过（同步 `400`）** | **`refused / engine_parse_error` + 引擎原话** | true | denied |
| 写入面违规 | `denied / sandbox_prefix_violation` | true | denied |
| 组件不在白名单 | `denied / component_not_allowed` | true | denied |
| 跑完失败 | `failed / pipeline_failed` + 引擎错误 | true | **ok**（工具完成了工作；失败是草案的结论） |
| 跑成功 | `ok` + 节点明细 | false | ok |
| **等待预算耗尽（跑没跑完未知）** | **`unknown / sandbox_run_timeout` + `runId`** | true | ok |
| 本实例已有沙箱 run 在跑 | `denied / sandbox_busy` | true | denied |

**并发与清理**：进程内单飞（同实例同时只允许一条沙箱 run）。草案清理已落（2026-10-24，issue #1029）：
每次试跑结束后**尽力而为**清一次——只碰符合 runId 模式的 `<runId>.json`（别的文件一律不动），
按 mtime 保留最近 `DATA_SANDBOX_KEEP_DRAFTS`（默认 20）份；`<1` = 不清理；**清理失败不影响本次结果**。
超时路径的草案是最新一份，必在保留集内 ⇒「用草案继续追」的口径不破坏。**不许无限增长**仍是对齐线。

**反转条件**（出现任一即重议本节）：需要并发多条沙箱 run / 沙箱必须访问单元 B 的私有服务 /
引擎提供一次性容器执行面（那时隔离与配额模型不同）。

### 2.9 提案应用通路（2026-10-24 拍板，issue #1003）

**决定**：`propose_*` 保持零写入不变；应用走**独立工具 `apply_pipeline_proposal`**——
agent 把 propose 回包**原样回传**，服务端无状态。WYSIWYG：PR 内容 = 人 review 过的草案，
不依赖「重新生成是确定的」。

**闸门 = 写总闸 + PAT 存在性**：`DATA_MCP_ALLOW_MUTATING=true`（否则 `denied / mutating_disabled`）
且 `DATA_MCP_GITHUB_TOKEN` 已配（否则 `not_executed / proposal_apply_unconfigured`，与沙箱 seam 同构）。
生产**默认不配 PAT ⇒ 默认不生效**。

**机制 = GitHub REST（容器内 fetch，无 git）**：基线 head → 逐 piece contents 预检
（内容不同 ⇒ `refused / proposal_conflict` + 当前内容 sha256 前 16 位，**不自动合并**；一致 ⇒ 幂等跳过）
→ 建提案分支（建议名撞车 ⇒ 加 `-<6hex>` 后缀，不是拒绝路径）→ 逐文件 PUT（每文件一个 commit）
→ **draft PR**（dbt staging 第三件不机械生成 ⇒ draft + downstream 清单 = 诚实的半成品）。

**安全不变式**：piece 路径白名单 = `contracts/` 或 `deploy/duckle/console/pipelines/` 前缀、
`.json` 结尾、禁 `..`——PR 会触发分支 CI，放任任意路径等于允许改 `.github/workflows`（提权通道）。
PAT 最小权限（单仓 contents:write + pull_requests:write），只在 server 行 env。
审计：`params: args` 整包入库，与 `propose_*` 现状同口径。

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
| **B10** 数据契约注册 | 湖的列集**只有一个事实源**：`contracts/*.json`。管线 `flatten` 的投影列集与对应 staging 模型的投影列集（去掉 dbt 注入的 `org`）必须与它**逐列一致**——漏改任一处 ⇒ 红。**2026-10-06 起（#460）③④ 已由 `scripts/gen-data-projection.mjs` 生成 ⇒ B10 从"事后查两处一致"降级为保险丝**（真正把关的是 `gen-data-projection --check`：生成物 == committed）；**改列集现在 = 改契约一处 + 跑生成器**。这条正是 §5.2 ① 的机检面 | `scripts/check-data-contract.mjs` + `scripts/gen-data-projection.mjs --check` | `gates` |
| **B11** 口径单一定义 | 业务口径（指标公式）**只许在 `dbt/` 实现一次**。复算（内部一致性）只允许**贴着模型、在同一工具链里**再有一份（独立**读路径**，见 `audit_*`）；**对账 / 脚本 / 问数 / BI 一律是消费者**——读物化结果，不自带等价算式。违反 = 同一业务规则出现两个并列实现、靠人手同步 ⇒ **静默漂移**（#813 容差地板、#917 退货侧判别式，两次都是这个形态）。机检：口径原子（两侧赠品判别式 / 折半形态）只许出现在 `dbt/` 的三份副本（构件 + 两个复算）；**对账链路**（`scripts/lemeng/recon-preagg.sh` 与 recon 子管线的 `code.sql`）出现即红。⚠️ 边界：本门禁判「**在场/不在场**」，不判两份 dbt 副本的语义等价 | `scripts/check-recon-caliber.mjs`（反向断言） | `gates` |
| **B12** 公开仓边界 | **公开仓不得依赖私有件**——禁止：`.gitmodules` 拉私有仓；`package.json` 指向私有 registry 或私有包；源码 `import` 私有包；构建期需要私有凭据。为什么：**公开仓必须能被外部独立构建与运行（开源仓更不必说）**；一旦依赖私有件，外部 clone 即构建失败，本不变量不成立。⚠️ **许可只决定别人能否合法使用 / 分发，不决定别人能否 clone 下来构建** ⇒ 本不变量在「**开放仓库**」阶段即已生效，**与是否授出开源许可无关**（2026-10-20 人决策：**先开放仓库，开源许可暂缓**） | `scripts/check-no-private-deps.mjs` | `gates` |
| 测试 / 冒烟 | 挂真 PG 的全量测试 / 双形态**真进程**装载冒烟 | `.github/workflows/ci.yml` | `unit` / `smoke` |

> B1 的 schema 侧由门禁守；`id` → API 前缀由 `moduleApiBasePath(id)`（`apps/server/src/loader.ts:102`）
> 从 `id` **派生**，属构造上一致，不靠人记。

> **B1 没有豁免出口**（`allowedSchema()` 把 `modules/<id>/` 之外一律硬钉成 `platform`，
> 无 marker、无 allowlist）。所以当宿主**必须在 mount 前**用到模块 schema 里的数据时（典型：
> PAT 凭证解析要在模块路由之前注入 `identity`），**不能**让宿主自带一份 SQL——正确解法是
> **模块端口**：模块用 `createPorts(ctx)` 声明能力，宿主用 `runtime.port(id, name)` 取用。
> 契约见 `docs/module-protocol.md`「模块端口」。（2026-09-21 拍板：该冲突实测会让 `gates` 报
> B1 违规，见该节。）

> **B12 与 case-engine 的边界（2026-10-20 人已决策）**：platform-core = **公开仓**（GitHub
> visibility=public；**开源许可暂缓**——同日人决策「先开放仓库，后面再说开源的事」，本仓当前**不挂
> 许可**）；case-engine = **私有仓**（闭源）。两者走「**分仓 + 契约/扩展点**」：**平台侧只放薄模块
> 与契约，引擎实现留在私有仓**——公开仓提供的是接入契约（`docs/module-protocol.md` 的 manifest 协议 /
> 模块端口 / `@platform/sdk`），私有引擎按契约接入，中间只有**公开的契约面**。方案裁决与取舍见
> explore 仓 ADR 0007（拟）。
>
> ⚠️ **名单式，非自动判定**：B12 的判据源是脚本里的常量 `PRIVATE_PACKAGE_PATTERNS`——**新增私有件
> 必须往那里加名字**，否则门禁认不出它。同理，registry 的「公开」白名单（`PUBLIC_REGISTRY_HOSTS`）
> 也是显式的：一个陌生主机名到底公开不公开，机械判不出来，宁可让人来加。

### 4.2 第二档：仅文档（无门禁，靠评审与人守）

| 不变量 | 是什么 / 违反了会怎样 | 出处 |
|---|---|---|
| **声明即授权** | 模块 API 必须在 `manifest.api.internal[]` 逐条声明；**未声明 = 不可达**（fail-closed）。漏声明 ⇒ 该路由**恒 403 且无人知晓** | `packages/platform-sdk/src/module.ts:113`、`apps/server/src/loader.ts:129,180` |
| **装载期双向核对** | 注册的路由集合与声明集合**任一方向有差集** ⇒ **装载失败**（绝不半挂）。让「声明与代码漂移」不可能悄悄存在 | `apps/server/src/loader.ts:113,137-171` |
| **`routePath` 基准** | 门卫的比对基准是 `c.req.routePath`。包裹层被宿主 mount 到前缀下后它是**绝对路径**，故 `declared[].path` 必须与之同基准；相对/绝对混用 ⇒ 门卫**恒 403** | `packages/platform-sdk/src/module.ts:106-108`、`apps/server/src/loader.ts:176-177` |
| **HEAD 归一 GET** | Hono 把 HEAD 按 GET 派发，但 `c.req.method` 仍是 `'HEAD'`；不归一 ⇒ 已声明的 GET 端点在 HEAD 下**恒 403**。**只归一 HEAD→GET**，未声明的路径照旧 fail-closed（不是"放行一切 HEAD"） | `packages/platform-sdk/src/module.ts:121-125` |
| **`enabledFor` 只能请求期门控** | `enabledFor(tenantId)` 是**按租户**的（`apps/server/src/loader.ts:52`），而 `mount()` 全仓只调一次（`apps/server/src/app.ts:231`）⇒ 停用模块只能在**请求期**过滤；闸门每请求查一次库、**刻意不做缓存**（`apps/server/src/loader.ts:350,369`）。装成「装载期过滤」会连带把启用租户也挡掉 | `apps/server/src/loader.ts:45,350,369` |
| **I-1 挂载顺序** | 租户→会话必须先于 `runtime.mount`（见 §3） | `apps/server/src/app.ts:3-9` |
| **JIT 建号三条件** | 企微自动建号（issue #32）必须同时满足：① **企微直连 code**（qr-corp/silent；Casdoor OIDC code 路**永不** JIT——那条路的账号来源是 Casdoor 自己的注册/管理面）② 租户旗标 `wecom_auto_signup`（**默认 false**，seed 收敛关；放宽 = 企微成员自动获得平台账号，必须租户级显式决定）③ 建号 + 重读成功（**不挂任何码**；自动建号 ≠ 自动授权）。任一不满足 ⇒ fail-closed（NO_ACCOUNT / CASDOOR_UNAVAILABLE）。建号失败**绝不静默放行**（audit `login.fail reason=jit-create-failed`） | `apps/server/src/routes/auth-wecom.ts:324`、`packages/auth-core/src/casdoor-client.ts:236,268`、`apps/server/src/migrations/004_tenant_wecom_auto_signup.sql` |
| **跨模块数据消费走契约** | 业务模块消费其他域的数据（如采集产出的维表）**只许两种形状**：① owner 的同步查询 API（交互类，执法在读时）或 ② owner 发布的带版本快照（批量类，执法在发布时）；**禁止直连**他模块的生产表/生产库（staging/湖不对业务模块暴露；不给业务模块发 `DATA_WAREHOUSE_URL`）。违反 = 跨 schema/租户耦合藏进存储层（lint 看不见），schema 一变运行时静默炸。判定三问与形状选择见决策正典 | `docs/superpowers/specs/2026-10-07-cross-module-data-consumption.md`（人裁 2026-10-07） |
| **血缘单调**（列级/值级授权） | `policy(指标) ⊇ ∪ policy(该指标读到的源列)`——给源列加限制而读它的指标**未同步收窄** ⇒ 泄漏：藏了 `item_cost_price`，但「毛利率」照旧算得出。⚠️ **门禁尚未落仓**：随 spec §4.3 的 P1 落 `gates`，**缺席期间不拦**（本档按现状如实登记）。⚠️ 只查**申报**的单调性；完整性需 contract→marts 的列级血缘，**仓内不存在**（无 dbt manifest）⇒ **拦不住漏申报**，如实标注 | spec `2026-10-17-column-and-value-level-security-design.md` §4.3 |
| **掩码先于聚合**（列级/值级授权） | `sum(round(x,-1000))`，**不是** `round(sum(x),-1000)`——后者可被差分攻击（换过滤/换窗取差）逼近精确值。由**运行期定点替换**保证：`selectSql` 存原值，掩码就在**列引用**处就地替换 ⇒ 换掉的正是聚合函数**里面**那个列引用，顺序不可能写错（运行期不做 SQL 解析，也就没有把顺序重排的余地）。⚠️ **解析单位是「列」不是「指标行」**（R10，2026-10-17 裁决）：`掩码集 = ⋃{声明 d : d.column 逐字出现在本次 selectSql 里}`，声明取自**全部**指标行 ⇒ 读同一列的 L2 与别的指标**自动**被覆盖（旧文按行解析 ⇒ L2 行 `mask_spec` 恒 null ⇒ 恒不掩，是个 fail-open 洞）。⚠️ **列键声明如此；默认档**（整值 / 指标级）**不覆盖 L2** —— spec §7 R12。⚠️ **门禁尚未落仓**：随 P2 落护栏测试，**缺席期间不拦** | 同上 §5.3、§5.3.1 |
| **数据面归属**（一个数据面 = 一个租户） | 数据面是**按租户交付的部署单元**；落进它的每一行，其租户归属**必须**等于部署租户。违反 ⇒ **跨租户可见**（`org` 是授权谓词，不是标签）：标了别家 org 的数据，**别家看得到、本家看不到**。**驱动是私有化交付**（非通则），**反转条件与连带翻转见 §2.5**。**无门禁**（要判它得先有跨租户的真库对账，本仓不存在） | §2.5；`dbt/macros/subject_org.sql`（空串 fail-closed） |
| **主体列不进湖**（**仅在「一面一租户」成立时**） | `org` 由**部署面**注入（`subject_org()` 取部署租户常量），**不落进湖**。落进去就多一个可能与部署主体漂移的副本，而**无机制**发现漂移。⚠️ 共享面上本条**翻转**（org 必须进湖）——**别单独引用** | §2.5；`contracts/*/*.json`（15 份契约无一存 org） |
| **域裁剪**（一个部署只物化自己的域） | 共享 `dbt/` 树 + 全量 build（无 `--select`，`mat_dbt_args()`）⇒ 不裁剪时**两侧互 build 对方模型**：本方侧**反向泄漏**（把对方租户数据标成本方 org），对方侧 **dbt 红**（前缀空）⇒ `exit 1` 早于写 `load_log` ⇒ 水位冻结、**所有**指标新鲜度连带退化。**无门禁** | §2.5；`scripts/lemeng/materialize.sh`；#729 R2 |
| **duckle 原生优先** | 做**任何数据面工件**（采集 / 判定 / 对账 / 管线节点）前必须**先问引擎**：`list_components` + `get_component_schema` 看真实能力，并**横向试遍同类组件**；答案落采集正典 §1.1 的**三档之一**（①引擎有⇒首选 ②有但本环境未验⇒挂 gate ③结构性没有⇒归我方），**禁止把 ② 写成 ①、把 ③ 写成 ②**；手搓必须给**结构性理由**并登记缺口。违反 = 与引擎重复造一份且必然漂移（#917：对账子管线手搓口径，而 `src.postgres` / `qa.reconcile` / `routines` 本就存在）。⚠️ **无 CI 门禁**——「有没有先查引擎」是过程判断，做不成真闸；执法靠 skill | 采集正典 §1.1（三档）/ §1.1.1（E3 证成方法学）/ §1.1.7（下沉给引擎）；`duckle/README.md` §7；执法器 `.claude/skills/duckle-native-first` |

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
   用那个 guest 码），**不另开一套门禁**。访客身份是**两态**（2026-10-10 订正，依据
   `docs/superpowers/specs/2026-10-10-aftersales-account-unification-design.md` §0.2/§3——
   原表述「访客身份不落 Casdoor（外部用户不进内部 IdP）」只对**中间态**成立）：**中间态**
   （openid 未绑/绑定 pending）不落 Casdoor（保留，访客 session 语义不变）；**正式态**
   （openid 有 active 绑定）落 Casdoor——门店员工建 Casdoor user（租户 org 下），绑定关系
   落本地 `platform.identity_link`，session 换发内部同构的正式态载荷（两态发放同一批码）。
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
   改完由 `scripts/check-data-models.mjs`（T4 起）机检。**对账 / 脚本 / 问数 / BI 一律是消费者**
   （读物化结果，不自带等价算式）——这条由 §4.1 的 **B11** 机检（`scripts/check-recon-caliber.mjs` 反向断言）。
2. **新增一个数据源**：`contracts/`（采集契约）+ `duckle/`（管线）+ `dbt/` staging **三件套同一个
   PR**——少一件即半接：契约没有 = 没人知道该源的结构；管线的 launcher 建在**镜像 ENTRYPOINT**里，
   不走模块路由。该纪律是流程约束，**当前无静态门禁**（见 §2）。
   该源**还要供操作面消费**（模块只读档案/订单，见 §2.3）时，三件套扩为**四件套**：
   加上 `modules/data` 里的**引用表迁移与稳定视图**，仍同一个 PR。
   ⚠️ **三件套的分工在 2026-09-23 收窄过一次**：`contracts/` 降级为**人写的意图源**（讲清该源该长
   什么样），**机器面改用 duckle 自己的声明与门禁**（`node.data.schema` + `qa.contract` + `drift`）。
   两者**不是二选一**——契约仍是接入的起点与评审依据，「落盘即定型」的**执行点**移到管线。
   理由、三条坑与未验清单见 `duckle/README.md` §7；契约侧的相应说明见 `contracts/README.md` §10。
3. **动部署形态**（并入单元 A 还是拆成独立 project）：只改 `composePath` 与服务裁剪开关，**不新建
   第三份 compose**——B7 白名单只有两份（见 §1.2「部署单元 B」）。接线模型读
   `deploy/customer-onboarding.md` §5。
   ⚠️ 但**数据面 project 的租户归属不是纯部署选择**——一个数据面只服务一个租户，且模型要按
   **域**裁剪，见 **§2.5**。

### 5.2 湖的 schema 演进（加列 / 改列 / 改名）——**四件套 + 展开→迁移**

> 触发案例：`order_total_money` 补采（#430/#432）暴露的 flag day。设计稿与真机验证见
> `docs/superpowers/specs/2026-10-05-lake-schema-registration.md`。

**先看病灶。** 湖的分区**不可变**、读者用**一条 glob 读整湖** ⇒ 「生产者写新列」与「消费者读新列」
之间必须有一次跨全湖切换。危险的不是切换本身，是**切换半途且无人知道**：真机实测（spec §2）
**半写的湖会被读者静默读成"完整"**（392 行 / 完整 796 行，rc=0）。

**所以「加一列」不是改 5 个地方，而是四件套 + 一个顺序：**

| # | 件 | 守什么 |
|---|---|---|
| ① | **契约注册**：`contracts/*.json` 的 `schemaVersion` + 列集是**单一事实源** | 管线 `flatten` 投影与 staging 投影必须与它一致（门禁 B10，§4.1） |
| ② | **表级封版标记** `…/_SCHEMA/v<N>.parquet`（**表根**；内容含 `schema_version` / `column_fingerprint` / `partitions` / `rows_expected` / `sealed_at`） | 「**这套文件是齐的**」的唯一凭据（同 `.data-plane-revision` 的思想：**标记在 = 齐**） |
| ③ | **读侧 fail-closed 断言**：读者路径不变，但**必须**同 FROM 带 `read_parquet('…/_SCHEMA/v<N>.parquet')` | 未封版 ⇒ 标记 404 ⇒ **带名字地失败**（真机验过：CLI 与 pg_duckdb 两条路径都响亮），而不是静默算错 |
| ④ | **注册表驱动回填** + **展开→迁移顺序** | 顺序不变量（glob 首文件列集必须是最小子集）从"注释里的纪律"升为**前置闸** |

> **2026-10-06（#460）起，管线 `flatten` 投影与 staging 投影是生成物**：`scripts/gen-data-projection.mjs`
> 按 `contracts/*.json` 重写二者的列区（**只重写列区，`FROM` 及其后逐字保留**），CI `gates` 跑
> `--check` 兜「生成物 == committed」。⇒ 上表 ① 的「单一事实源」从**人手同步多处**变成
> **改契约一处 + 跑生成器**。（契约未回填 `columns[].expr` 时生成器**跳过**该契约；存量回填用 `--seed`。）

```
展开(expand)  ：只上生产者 → 回填历史 → 湖齐版 → 落封版标记        ← 旧读者全程不受影响（实测）
迁移(migrate) ：再上消费者（引用新列 + 断言封版）
```

**契约里两个版本号不是一回事**（都在契约里，别合并）：

- `schemaVersion` = **湖上这套文件**的列集代数（封版标记与读侧断言引用它）；
- `consumerVersion` = **消费者（staging/marts）已采纳到**的版本。

展开期的**合法中间态**就是 `consumerVersion < schemaVersion`——门禁 B10 据此区分「**还没迁移**」
（打印提示、**不红**）与「迁移没做完就改了版本号」（**红**）。
没有这个字段，机械门禁就只能二选一：要么强迫两者同时改（回到 flag day），要么完全不查消费者（永久落后而无人知）。

**新列一律追加在末尾。** 消费者侧的投影因此永远是契约列的**同序前缀**——这正是 B10 能机械检查的形状。
中间插列必然红；要"插"就走「加新列 → 回填 → 翻读者 → 停用旧列」（硬约束 3）。

**三条硬约束（每条都有实测支撑，别绕）：**

1. 🔴 **封版标记绝不能落在任何读湖 glob 的射程内。** 实测：标记若与数据同目录，
   `…/**/*.parquet` 会把它当数据文件读进来，**结构体被解析成标记的列**
   （`Could not find key "sale_money" … Candidate Entries: "sealed_at"…`）。
   放**表根**（`<prefix>/_SCHEMA/…`）而读者 glob 是 `<prefix>/system_book=*/**/*.parquet` ⇒ 不在射程内（实测 `glob()` 命中 0）。
2. **不采用「版本化前缀」**（`…/v<N>/…`）：它唯一多买到的是「消费者可任意插队迁移」，
   而本项目**两侧投递都由我们控制、可排期**（展开期零窗口，已实测）⇒ 为这点自由度改路径布局、
   并永久背一条遗留路径，不划算。将来若出现**无法排期的消费者**（多团队并发/24-7），
   或需要**原地改名/改类型且不留旧列**，再升级到它——② ③ 可直接复用。
3. **改列/改名/改类型 = 展开→迁移的再组合**（加新列 → 回填 → 翻读者 → 停用旧列），
   **不要**指望"原地换"。

**读湖的唯一合法姿势**（第三方/临时查询同样适用）：`<prefix>/system_book=*/**/*.parquet`
**并且**同 FROM 带上 `<prefix>/_SCHEMA/v<N>.parquet`。**绕过封版断言直接读湖 = 读到半写的湖而不自知。**
（⚠️ **2026-10-20 起这条有修订**——混合布局下还可有「两条 glob + 排除」形态，见 **§5.3**。）

### 5.3 湖的分区布局演进（小时 → 天；热/冷混合）——**2026-10-20 拍板**

> 触发案例：零售明细是全湖**唯一**按小时分区的资产（其余 17 份契约都是天/快照分区），也是唯一慢的。
> 读侧实测 **≈ 8 ms × 文件数**（与行数无关、与线程数无关：`threads_for_postgres_scan` 2→16 无改善）
> ⇒ 1,344 个文件 = 全史冷读 **11.14 s**，而 4 天查询（192 文件）2.09 s。
> 设计稿与全部实测见 `docs/superpowers/specs/2026-10-20-retail-daily-partition-design.md`。

**病灶一句话**：文件数 = 账套 × **24 小时** × 天数 ⇒ 小时分区把成本钉死在「天数 × 48」上，
而每个文件只有 ~30 KB。

**布局（热/冷混合）**

| 层 | 路径 | 谁写 | 何时 |
|---|---|---|---|
| 热 | `<prefix>/system_book=<B>/bizday=<Y>/hour=<HH>/all.parquet` | tick（每 5 分钟） | **只有今天** |
| 冷 | `<prefix>/_DAY_DATA/system_book=<B>/bizday=<Y>/all.parquet` | **整天重采** | 关闭日，每账套每天 1 个 |
| 标记 | `<prefix>/_DAILY/system_book=<B>/bizday=<Y>.parquet` | 同上 | 与冷文件同批（封版） |

> **为什么冷侧在 `_DAY_DATA/` 而不是 `system_book=<B>/` 下**（2026-10-20 部署后订正）：
> 审计层有 **7 个 `audit_lemeng__retail__*` 用单 glob `<prefix>/system_book=*/**/*.parquet`** 读湖。
> 天文件若与小时文件同处一个 `system_book=` 下，那些读者会**同时命中两份 ⇒ 双算**
> （部署后实测：`audit_lemeng__retail__recon_gift_hit` FAIL 67、`assert_stg_..._key_unique` FAIL 19678）。
> 挪到 `_DAY_DATA/` 之后**单 glob 天然匹配不到天文件** ⇒ 既有读者一行不改，且**不再依赖删除时序**；
> 「删小时文件」回到**纯性能**的定位（这是本节的原始判断，上一版曾因审计层被误判成「必须」，现订正）。

**四条硬约束**（每条都有实测支撑，别绕）：

1. **两层的 glob 天然不重叠**：天文件只在关闭日、小时文件只在「今天 + 尚未重采的昨天」。
   但读侧**必须带「排除已封版日子的小时行」**（`not exists` 对 `_DAILY/`）——否则「写天文件」与
   「删小时目录」之间那段**并存窗口**会**双算**。带上排除之后，删除失败只是**变慢**，不会错数
   ⇒ **正确性与删除时机解耦**。
2. 🔴 **`_DAILY/` 必须放表根**——与 §5.2 约束 1 同一个理由：落进 `system_book=*/**/*.parquet`
   的射程就会被当成数据文件读进来。`_SCHEMA/` 已因此放根上。
3. **整天重采不依赖小时文件存在**（它重新调网关）⇒ ① 可无限次重跑；② 删小时与重采互不影响；
   ③ 重述 / heal 复用同一条管线。**这是本布局相对「事后合并」方案的关键优点：删除是可恢复的**
   （合并方案一旦删了源文件，那天就再也合不出来了）。
4. 🔴 **分页必须有容量哨兵**：网关**越界页返回 `code:0` + 空数组**（**不带错**），`page_size` 硬顶 200、
   信封**没有 `total`** ⇒ 只能「扇出到固定的最大页数 + **断言见到不满一页**」。**不设哨兵 = 静默截断。**
   两条同批实测：`src.rest` 的原生 `paginationType: page` 对本网关**不可用**（页码必须进 **JSON body**，
   而它放 query string）；**空页在管线里是硬错**（`no schema is declared to type an empty result`）
   ⇒ 取数节点**必须申报 `node.data.schema`**。

**读湖姿势（2026-10-20 起修订）**：两种形态**都合法**，但各带条件——

| 形态 | 条件 | 何时用 |
|---|---|---|
| **单 glob** `<prefix>/system_book=*/**/*.parquet`（§5.2 原文） | 已封版日子的小时目录**确实被删掉了**才正确（否则双算） | 删除可靠时；第三方/临时查询 |
| **两条 glob + `not exists` 排除** | 无条件正确（不依赖删除） | 生产读者（dbt staging / 视图） |

**两种都要求同 FROM 带上 `_SCHEMA/v<N>.parquet`。**

**演进顺序（下次改布局照这个来）**：契约 `partitionBy` → 写侧管线 + sink key 模板
（⚠️ **分区路径写死在 `snk.minio` 的 `key` 里，不是从契约推导的**，两处都要改）→ 读侧能同时吃
两种布局 → 逐段重采 → 最后才删旧布局。**删是唯一不可逆步，永远放最后。**

## 6. 文档地图

| 文档 | 何时读 |
|---|---|
| `docs/module-protocol.md` | 改模块 API / 门卫 / `api.internal[]` 声明前**必读** |
| `docs/superpowers/specs/` | 单特性设计（历史档）；新设计也落这里 |
| `docs/superpowers/plans/` | 实现计划（历史档） |
| `deploy/openship-adopt.md` | 部署接入 |
| `docs/data-platform-handbook.md` | 接采集任务 / 改采集链路 / 改调度前**必读**（采集正典 + 数据源台账） |
| `deploy/branch-protection-runbook.md` | 提交纪律的四层软机制与「七条局限」 |
| `docs/m0-smoke-checklist.md` | 验收 / 手工冒烟清单 |
| `README.md` | 布局 / 常用命令 / 提交纪律 |
| `CHANGELOG.md` | 行为变化（脚本独占维护，**禁手写**） |

### 6.1 订正指针（被本轮取代的 spec 条号）

`docs/superpowers/specs/**` 是**历史快照，正文一律不改**（本仓既有纪律；处置同计划「第六轮 #3」）。
下列条号的结论**已被 2026-09-23 / 2026-09-26 / 2026-10-20 三轮订正取代**，一律以**本文（尤其 §2.2 及其末注）**与
`docs/superpowers/plans/2026-09-22-data-stack.md` 的「**本轮订正（2026-09-23）**」节为准：

| 被取代的 spec 条 | 旧口径 | 现口径 |
|---|---|---|
| `specs/2026-09-20-data-stack-module-design.md` §11.2 #3 | pg_duckdb 走**自建镜像**、钉 DuckDB **v1.5.5**（理由是 ossie 只发到 v1.5.5） | **官方镜像** `pgduckdb/pgduckdb:18-v1.1.1`（上游自陈配对 = DuckDB v1.4.3）；自建降为**未启用备件**——实测该配对（pg_duckdb v1.1.1 × DuckDB v1.5.5）**编译失败：8 处 API 断裂** |
| 同上 §11.2 #4 | L1 语义声明 = **Ossie JSON** | L1 事实源 = **dbt YAML**（`dbt/semantics/l1_metrics.yml` + `dbt/models/<域>/marts/schema.yml`）——**存储格式不是 Ossie** |
| 同上 §11.3 | AI 走 **duckdb-ossie MCP** 问数据（两条 AI 通路） | **已废止**（2026-09-26 订正）——废止的是 `duckdb-ossie` **那套实现**；**入口不再唯一**：AI **可直读数据面**（不再要求经 facade），合规判据只剩「**受授权面约束 + 入审计**」；`modules/data` 降为**治理面**。理由与两条前置缺口见 §2.2 末注 |
| 同上 §11.3.1 | 「**保护来自每租户会话绑定**」⇒ 任何绕开 facade 的数据面直连（含 **Metabase 官方 MCP**）不合规 | **（2026-09-26）「任何绕开 facade 的数据面直连都不合规」整句作废**——直连改由**授权面 + 审计**约束；§11.3.1 那条观察（**保护不来自 `filter allowlist`**）**仍成立**，只是「保护来自什么」的落点从**每租户会话绑定**改为**授权面**。⚠️ 「**Metabase 官方 MCP**」一项的判据随之改写（从「是否经 facade」→「是否受授权面约束 + 是否入审计」）——**本轮未重新裁决** |
| 同上 §11.9 #3/#4 | 「Ossie 观察信号」「自建镜像的构建频率」两个开放项 | **两项均已消解**：ossie 出局 ⇒ 观察信号无对象；自建镜像未启用 ⇒ 构建频率无对象（备件将来启用时另议） |
| `specs/2026-09-21-data-platform-layered-design.md` §2 / §3（**七层**） | dbt 侧只有两层：③ `staging/`（**表**）、④ `marts/`（**表**） | **（2026-09-26）dbt 侧多一层**：明细直读视图 `views/vw_*`（**view**、**直读湖**、逐列显式 cast）——它属 ⑦ 消费的材料、但由 dbt 生成 ⇒ **层数以本文 §2.2 为准，别再按那份 spec 数层**。设计与三条 gate 见 `specs/2026-09-26-detail-read-view-design.md` |
| `specs/2026-09-26-detail-read-view-design.md` §5 gate 2「分区裁剪」 | 「3 天数据下单日过滤 207 ms vs 全量 249 ms，**分不出差别** ⇒ 未定论」（落笔时湖只有 3 天） | **（2026-10-20）已定论：裁剪成立。** 湖有 28 天后实测 **11.14 s → 0.53 s**；可用形态是 `CREATE VIEW … SELECT r['列']::type AS 列 FROM read_parquet(…) r`（**不是** `duckdb.query() + SELECT *`——那形态只得到一列不透明 `duckdb."row"`）。证据与全部实测见 `specs/2026-10-20-lake-format-decision.md` §8。⚠️ 该 spec 的 gate 1（新鲜度）/ gate 3（读今天的竞态）**仍待** |

---

**本文会漂移。** 唯一的自约是「**引用即路径，路径必须真实存在**」——发现路径失效、或本文与代码
不符，**直接改本文**（走 PR）。没有同步门禁是有意的（YAGNI）：在出现真实漂移案例之前不为它建门禁。

**例外只有一种，且必须随句标注**：引用**尚未落仓**的路径时，须在同一句或紧邻引注里写明
**由哪个任务落仓**（如「随 P1 的 T3 落仓」）与**缺席时的门禁行为**（如「白名单已开、缺席不违规」）。
**没标注的目标形态引用 = 自约违反**——它与引用一条失效路径同样处理。
