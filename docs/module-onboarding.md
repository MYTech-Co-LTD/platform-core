# 新模块接入指南

> **本文管「怎么接入」**：目录骨架、manifest 全字段、入口契约、迁移纪律、验收清单、故障速查。
> **协议语义与边界的正典是 `docs/module-protocol.md`**——本文不复制其正文，只在需要处给指针。
> 机器契约源是 `packages/platform-sdk/src/manifest.ts`（zod schema）；本文与它漂移时以 schema 为准。
>
> **两份现成模板**：`modules/demo`（最小，后端 API + 一页 console）、
> `modules/aftersales`（全能力：访客面 / 租户存储 / 移动端 / 页内多页）。

## §0 接入前必读

1. `docs/architecture.md`——架构不变量（B1 跨 schema 三同、B9 env 契约、I-1 挂载顺序等）。
   不变量与本次接入冲突时，**先讨论架构，不要先写码**。
2. `AGENTS.md` 的「项目专属硬约束」1–11——每条都对应一次真实事故或评审结论。
3. 本文 §6 的验收清单——它是「接入完成」的定义。

## §1 目录与工程骨架

模块住 `modules/<id>/`（`<id>` 必须小写 kebab-case，见 §2）。`pnpm-workspace.yaml` 的
globs 是 `['apps/*', 'packages/*', 'modules/*', 'modules/*/*']`——`modules/<id>/` 自动被
收纳，含子 package.json 的目录（如前端子包）也自动成为 workspace 包。

从 `modules/demo` 起步（最小可跑），需要更多能力面时对着 `modules/aftersales` 抄。

| 路径 | 何时需要 | 说明 |
|---|---|---|
| `modules/<id>/manifest.yaml` | **总是** | 接入协议单一事实源（§2） |
| `modules/<id>/index.ts` | **总是** | 入口：读 yaml → `ManifestSchema.parse` → `defineModule`（§3） |
| `modules/<id>/package.json` | **总是** | `name` = 模块 id；deps 见 demo（`@platform/sdk` workspace:* + `hono` + `yaml`） |
| `modules/<id>/tsconfig.json` | **总是** | `extends "../../tsconfig.base.json"`，`noEmit: true`；`vitest` 的显式 paths 映射照 demo（成因见 demo tsconfig 的注释，issue #68） |
| `modules/<id>/vitest.config.ts` | 有测试时 | 照 demo（happy-dom 环境 + esbuild jsx automatic；不引 `@vitejs/plugin-react`） |
| `modules/<id>/migrations/` | 有表时 | SQL 迁移，目录名可改但须在 manifest 声明（§4） |
| `modules/<id>/console/` | 声明 `frontend.console`/`admin` 时 | 管理台页（§5） |
| `modules/<id>/mobile/` 等前端子包 | 声明 `frontend.userApp` 时 | 独立构建产物，`dist` 相对模块目录（§5） |
| `modules/<id>/README.md` | 有全局表时 | 声明全局表理由（§4） |

## §2 manifest 全字段参考

契约源 `packages/platform-sdk/src/manifest.ts`。表的「校验」列：
**schema** = zod 校验（装载期与 `check-manifests` 门禁**同时**覆盖）；
**门禁** = `scripts/check-manifests.mjs` 额外的文件存在性/白名单检查；
**装载** = 装载期双向核对等运行期检查。

| 字段 | 必填 | 形状 | 语义要点 | 校验 |
|---|---|---|---|---|
| `id` | 是 | `^[a-z][a-z0-9-]*$` | 模块命名空间（三同之一：模块 id = schema 名 = 权限前缀） | schema |
| `name` | 是 | string | 展示名 | schema |
| `version` | 是 | `x.y.z` | 宽松 semver，三段数字 | schema |
| `platform` | 是 | `^>=?[0-9]` | 平台版本约束（如 `>=0.1`）；**裸版本号不合法** | schema |
| `permissions[]` | 是 | `{code,name}[]` | 权限码清单；`code` 必须 `<id>:` 前缀 | schema |
| `api.internal[]` | 否 | `{method,path,scope}[]` | 模块 API 声明，**未声明 = 不可达**；path 模块内相对、禁裸 `/`；scope ∈ permissions | schema + 装载期双向核对 |
| `guest.scope` | 否 | string | 访客码，必须 ∈ permissions；宿主 wechat-oa 登录路按已启用模块发放 | schema |
| `storage.kind` | 否 | `'s3'`（枚举收窄） | 声明 = 宿主在本模块 API 子树注入 `c.get(TENANT_STORAGE)`；**声明的是能力不是租户** | schema |
| `frontend.console[]` | 否 | `{path,title,icon?,scope,entry}[]` | 管理台平铺页；path 不得占 `/console/admin/` 前缀；scope ∈ permissions | schema + 门禁（entry 文件存在） |
| `frontend.admin[]` | 否 | 同上 | 管理组子页；path **必须** `/console/admin/` 开头 | schema + 门禁（entry 文件存在） |
| `frontend.userApp` | 否 | `{mount,dist}` | 独立前端应用（C 端/移动端）；`dist` 相对模块目录 | schema |
| `migrations.dir` | 否 | string | 迁移目录，缺省 `migrations`；目录不存在静默跳过 | schema + 门禁（目录存在） |
| `bindings` | 否 | `Record<string,'required'\|'optional'>` | **预留·无消费者**：仅 `check-manifests` 查键白名单 `{postgres, novu, cube}`，**无任何运行时消费——声明了不会有任何效果** | 门禁（键白名单） |
| `notifications.dir` | 否 | string | **预留·无消费者**：schema 接受，当前无任何读取方——声明了不会有任何效果 | schema |
| `config.schema` | 否 | string | **预留·无消费者**：同上 | schema |

> 上面三个「预留·无消费者」字段是**已知债**（清理与否另议）。如实标注是为了防止接入者
> 以为声明了就有能力——`docs/module-protocol.md` 开篇记的正是「一个字段死于零文档」的教训。
>
> ⚠️ 上表「语义要点」列是**要求**，不等于「机器都查了」。照 schema 逐字段读出来的一处差异：
> `frontend.admin[].scope` 不在本模块 `permissions[].code` 内即**装载失败**（schema 拦），
> 而 `frontend.console[].scope` **没有**这道校验——它只在构建期进 console registry、运行期参与
> `registry ∩ 启用集 ∩ session scopes` 三重过滤。写成一个不存在的码**不报错**，只是那一页
> **永不出现**（静默失效）。写 console 条目时按「scope ∈ permissions」自查。

## §3 后端入口契约

模块入口 `modules/<id>/index.ts` 的姿势（照 `modules/demo/index.ts`，逐行可抄）：

1. **yaml 是单一事实源**：启动时读同目录的 `modules/<id>/manifest.yaml`，经 `ManifestSchema.parse`
   校验后交给 `defineModule`——**不在 TS 里维护第二份副本**（防漂移）。
2. **`defineModule({ manifest, createRouter })`**：`createRouter(ctx)` 的 `ctx` 是
   `ModuleContext = { pool }`——数据库连接由宿主给，**模块零连接代码**。
3. **身份由宿主注入**：路由里用 `c.get('identity')`（`Identity` 类型从 `@platform/sdk` 导出，
   含 `userId`/`orgId`/`displayName`/`scopes`/`hasScope()`）。模块内自建
   `new Hono<{ Variables: { identity: Identity } }>()` 拿到类型检查。
4. **不写 `requireScope`**：门禁由宿主按 `api.internal` 声明**强制施加**；模块再写一遍是冗余。
   漏写不会导致匿名可读——未声明的 `(method, path)` 一律 403，装载期双向核对还把
   「注册了没声明」变成装载失败。
5. **路由路径与声明逐字一致**：`createRouter` 里注册的每条 `(method, path)` 都要在
   `api.internal` 里有一条声明，反之亦然——两个方向的差集都让**装载失败（进程起不来）**。
   路径含 `:param` 时声明里也要写 `:param`。
6. **多租户写入必带 org**：读写一律按 `c.get('identity')!.orgId` 过滤（§4）。

声明写法的细则（裸 `/` 为何被拒、`*` 的子树语义、exact-ALL 的已知放松）见
`docs/module-protocol.md` 的「规则：没声明 = 不可达」与「装载期双向核对（fail-fast）」两节。

## §4 数据库与迁移

**三同纪律**：模块的表建在**本模块 schema**（= manifest `id`）。`create table` 建到别处或不
限定 schema，`scripts/check-tenant-isolation.mjs` 一律判违规（建到别处 = 门禁看不见 = 静默放行）。

**租户数据表三条纪律**（正典详解见 `docs/module-protocol.md`「租户数据隔离」节）：

1. 租户数据表必须带 `org text not null` 列，值 = `identity.orgId`；读写一律 `where org = $1`。
2. 唯一约束必须含 org：`unique(org, …)`（无业务唯一键的表不适用）。
3. 热路径索引以 org 为前缀列。

**全局表**（字典/配置类跨租户共享）可不带 org，但要在模块 README 声明理由，**并且**在建表
语句上方紧贴一行 `-- global-table: <理由>`（理由是必填、标记必须紧贴 DDL）。细节见正典同名节。

**迁移执行**：`apps/server/src/migrate.ts` 按 `platform.schema_migrations(module, version)`
主键记账——**同一批迁移重复执行是幂等的**（版本已在账本里就跳过）。因此：

- DDL 一律 `create table if not exists` / `add column if not exists` / `create index if not exists`；
- 视图一律 `drop view if exists` + `create view`（**不要** `create or replace view`，见团队 `db-migration` 规则）；
- 来自外部系统的字段一律 `text`，不用 `varchar(n)`；
- 目录不存在静默跳过——没有表的模块不需要 `migrations/`。

文件命名与版本号自愈姿势可参考 `modules/demo/migrations/`（含一条「账本幽灵记录」的处置注释）。
