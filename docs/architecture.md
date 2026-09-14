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

两个服务，全仓**唯一** compose 文件 `deploy/docker-compose.yml`（B7 守）：

| 服务 | 说明 |
|---|---|
| `postgres` | `postgres:16-alpine`，卷 `pgdata` |
| `server` | 由 `deploy/Dockerfile.server` 构建，**build context 必须是仓根**（Dockerfile 要 COPY `packages/` `apps/` `modules/` `scripts/`） |

`server` 以 `service_healthy` 依赖 `postgres`——迁移在**启动期**跑，PG 未就绪即失败。

### 1.3 生产通道，与「为什么绑回环不是可选项」

生产只经 openship edge 访问：edge 在**宿主**上反代 `127.0.0.1:<port>`。因此把端口绑 `0.0.0.0`
等于让任何能访问宿主该端口的人**绕过 edge**（丢掉证书、限速与访问控制）。

生产**照搬同一份 compose**（差异项见 `deploy/openship-adopt.md`），所以两条端口映射
（`postgres`、`server`）都是生产入口面的一部分，**都绑 `127.0.0.1`**，B7 守着文件里所有
`ports` 条目。

### 1.4 租户模式

`TENANT_MODE ∈ {multi, single}`（`apps/server/src/config.ts:9,52`）；`single` 时 `PLATFORM_ORG`
必填（`apps/server/src/config.ts:70`）。租户解析是「请求 Host → 租户」，实现见 `apps/server/src/tenant.ts`。
租户行上还有**安全旗标**列（如 `wecom_auto_signup`，企微直连 JIT 建号，默认关——见 §4.2）。

> 部署接入：`deploy/openship-adopt.md`；部署后必验：`deploy/README.md`

## 2. 组件与职责边界

依赖边**读自各 `package.json`**，不是推测。

| 组件 | 做什么 | 依赖 | 谁依赖它 |
|---|---|---|---|
| `apps/server`（`@platform/server`） | 宿主：装配、租户解析、会话、平台路由、登录三路、模块挂载、静态托管 | `@platform/auth-core`、`@platform/sdk`、hono、pg、zod | 无人（可部署端） |
| `apps/web`（`@platform/web`） | 前端 console（SPA）；模块 console 条目由 registry 聚合 | `@platform/sdk/web`（`platformFetch`）、antd、react | 无人 |
| `packages/auth-core` | **认证内核**：Casdoor 客户端、会话签名、scope 计算、企微 | jose、hono、zod（**无仓内依赖**） | **只有 `apps/server`** |
| `packages/platform-sdk` | **模块契约**：`defineModule` / manifest schema / 门卫 / 前端 fetch | hono、pg、yaml、zod（**无仓内依赖**） | `apps/server`、`apps/web`、每个 `modules/<id>` |
| `modules/<id>` | 业务模块（现为 `demo` 占位） | `@platform/sdk`（+ 前端库） | 无人；由宿主装载 |
| `scripts/` | 门禁与工具 | — | CI |
| `deploy/` | 部署面：compose / Dockerfile / runbook | — | 生产接入 |

两条**不可越过的边界**：

1. **认证代码只许在 `packages/auth-core`**，且 `@platform/auth-core` **只许 `apps/server` 引**。
   `apps/web` 与 `packages/platform-sdk` 连 `import type` 都不许。（B2 守）
2. **平台代码与模块代码不许互相跨 schema。**（B1 守）

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
| **B7** 部署面 | 全仓唯一 compose；文件里**所有** `ports` 条目必须 `127.0.0.1:` 起头 | `scripts/check-compose.mjs` | `gates` |
| **B8** 无硬编码 | 禁 `hookflow.cn`；禁公网 IP 字面量（`127.0.0.1` 白名单） | `scripts/lint-architecture.mjs` | `gates` |
| **B9** env 契约 | `.env.example` 键齐全 | `scripts/check-env-example.mjs` | `gates` |
| 装置完好 | `.githooks/pre-push` 带执行位 + 根 `prepare` 接线未被改掉（本地防线被改掉时**不会有任何报错**，只会"从此刻起拦不住"） | `.github/workflows/ci.yml` 的 gates | `gates` |
| typecheck | 聚合 `tsc --noEmit`，**含 `scripts/`**（只跑包内会漏 `scripts/*.mjs` 的类型错误） | `.github/workflows/ci.yml` | `gates` |
| 测试 / 冒烟 | 挂真 PG 的全量测试 / 双形态**真进程**装载冒烟 | `.github/workflows/ci.yml` | `unit` / `smoke` |

> B1 的 schema 侧由门禁守；`id` → API 前缀由 `moduleApiBasePath(id)`（`apps/server/src/loader.ts:102`）
> 从 `id` **派生**，属构造上一致，不靠人记。

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

## 5. 扩展点：加一个模块要动什么

1. 建 `modules/<id>/`：`modules/<id>/manifest.yaml` + `modules/<id>/index.ts`（`defineModule`）+ `modules/<id>/migrations/`（可选）+ `modules/<id>/console/`（可选）
2. **三同纪律**：`manifest.id` = DB schema 名 = API 前缀，三处必须一致（B1 守 schema 侧，前缀由 `id` 派生）
3. 在 `manifest.api.internal[]` 里**逐条声明**每条路由的 method / path / scope——**没声明就是不可达**
4. 权限码写进 `manifest.permissions[]`；供给由装载器按各租户 org 逐个 upsert，**模块不手写 `requireScope`**
5. **租户数据表必须带 `org` 列**（值 = `identity.orgId`），读写按 org 过滤——约定正文读
   `docs/module-protocol.md`「租户数据隔离」
6. console 条目写进 `manifest.frontend.console[]`；前端 registry 由 `scripts/gen-console-registry.mjs` 生成
7. 部署**一般不用动**（模块随宿主构建进镜像）

→ 逐条契约与已踩过的坑读 `docs/module-protocol.md`（**改模块 API / 门卫 / 声明前必读**）

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

---

**本文会漂移。** 唯一的自约是「**引用即路径，路径必须真实存在**」——发现路径失效、或本文与代码
不符，**直接改本文**（走 PR）。没有同步门禁是有意的（YAGNI）：在出现真实漂移案例之前不为它建门禁。
