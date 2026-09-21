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
| `modules/<id>/package.json` | **总是** | `name` = 模块 id；deps 见 demo（`@platform/sdk` workspace:* + `hono` + `yaml`）（+ 有 `console/` 页时 antd / react / react-dom / react-router-dom） |
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
语句上方紧贴一行 `-- global-table: <理由>`（理由是必填、标记必须紧贴 DDL）。细节见
`docs/module-protocol.md`「租户数据隔离」节与「租户隔离 CI 门禁」节。

**迁移执行**：`apps/server/src/migrate.ts` 按 `platform.schema_migrations(module, version)`
主键记账——**同一批迁移重复执行是幂等的**（版本已在账本里就跳过）。因此：

- DDL 一律 `create table if not exists` / `add column if not exists` / `create index if not exists`；
- 视图一律 `drop view if exists` + `create view`（**不要** `create or replace view`，见团队规则 `~/.claude/rules/common/db-migration.md`）；
- 来自外部系统的字段一律 `text`，不用 `varchar(n)`；
- 目录不存在静默跳过——没有表的模块不需要 `migrations/`。

文件命名与版本号自愈姿势可参考 `modules/demo/migrations/`（含一条「账本幽灵记录」的处置注释）。

## §5 能力面按需接入

### 心智模型：一个壳，模块交付「页」

**管理后台是单一壳**（`apps/web`，React + ProLayout），模块交付的是**页**：构建期由
`scripts/gen-console-registry.mjs` 聚合成 `apps/web/src/console-registry.gen.ts`，运行时壳做
**三重过滤**（config 启用集 ∩ registry 已挂载 ∩ session scope）出菜单，命中后 lazy load 模块
entry 的 default 导出、渲染进壳的 `Outlet`，共享壳的布局/主题/会话（`ConsoleOutletContext`）。

**没有「进入应用 → 独立菜单体系」这回事。** 要独立 UI 的是 C 端场景，走 `frontend.userApp`
（真独立构建，挂 `/app/<id>`，如 aftersales 的 Vue 移动端）。

**行业参照**：本平台 = Stripe / Grafana 系（统一壳 + 页聚合 + 页内自绘导航），
不是 Odoo / Salesforce 系（app 切换器 + 每 app 独立菜单）——后者是 40+ app 重套件的形态，
本平台模块数量级不需要。

```
┌────────────────────────────────────────────────────────────────┐
│  ConsoleShell（apps/web，唯一的壳：React + ProLayout）            │
│  壳管：布局 / 主题 / 暗色切换 / 会话 / 登出                        │
│ ┌──────────────┬─────────────────────────────────────────────┐ │
│ │  侧栏菜单      │              页面区 <Outlet/>                │ │
│ │  （只有这一套） │                                             │ │
│ │              │   ┌─────────────────────────────────────┐   │ │
│ │  概览          │   │ 点「售后管理」⇒ 懒加载 aftersales 的   │   │ │
│ │  演示     ─────┼──▶│ console/index.tsx，渲染在这个框里      │   │ │
│ │  售后管理   ───┼──▶│                                     │   │ │
│ │              │   │ aftersales 页内想多页？自己写子路由：    │   │ │
│ │ ▾ 管理         │   │ /console/aftersales/tickets          │   │ │
│ │   用户管理      │   │ /console/aftersales/rules           │   │ │
│ │   角色与授权    │   │ （页内导航，侧栏菜单不跟着变）           │   │ │
│ │   我的订阅      │   └─────────────────────────────────────┘   │ │
│ │   存储配置*     │                                             │ │
│ │   模块admin页*  │   （点菜单其他项 ⇒ Outlet 里换成别的模块页）    │ │
│ └──────────────┴─────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
 * 存储配置/模块admin页：只有 tenant:admin 且模块声明了才出现
```

声明怎么变成菜单：

```
modules/<A>/manifest.yaml              modules/<B>/manifest.yaml
  frontend.console/admin 条目               frontend.console 条目
        │                                        │
        └───────────────┬────────────────────────┘
                        ▼  构建期（pnpm build 前置脚本）
        scripts/gen-console-registry.mjs 聚合
                        │
                        ▼
        apps/web/src/console-registry.gen.ts（生成文件）
                        │
                        ▼  运行时，壳里做三重过滤
        config 启用集        registry 挂载        session scope
        （租户启用了          （构建期已           （用户有
          这个模块吗）          挂载了吗）           这个权限码吗）
             └──────── 三项全过 ────────┘
                        │
                        ▼
        菜单出现该条目 + 点进去懒加载模块页
        （任何一项不过 ⇒ 菜单不出、直敲 URL 也进不去——
          #127 起路由与菜单同一判定，直敲出「模块可能未启用」Result）
```

**两级菜单**：壳侧栏一条（**协议管**：扁平数组、不支持嵌套、显隐三重过滤）+ 页内导航
**模块自绘**（**协议不管**）：

```
┌──────────────────────────────────────────────────────────────────┐
│ ConsoleShell（壳）                                                │
│ ┌────────────┬─────────────────────────────────────────────────┐ │
│ │ 壳的侧栏菜单 │  aftersales 的页面区（模块自己的地盘）              │ │
│ │            │ ┌─────────────────────────────────────────────┐ │ │
│ │ 概览         │ │ ⌗工单 ⌗规则 ⌗员工 ⌗商品 ⌗门店 ⌗申请审批      │ │ │
│ │ 演示         │ ├─────────────────────────────────────────────┤ │ │
│ │ 售后管理 ────┼─▶│ （选中页签的内容区）                          │ │ │
│ │            │ │                                             │ │ │
│ │ ▾ 管理      │ └─────────────────────────────────────────────┘ │ │
│ │   …         │   ↑ 这排页签是 aftersales 自己用 antd <Menu>     │ │
│ └────────────┴──── 画的，URL 驱动：/console/aftersales/tickets   │ │
└──────────────────────────────────────────────────────────────────┘
```

### 声明了会发生什么（先看这张表建立预期）

| 你声明了… | 管理台上发生什么 |
|---|---|
| `frontend.console[]` 条目 | 菜单**平铺**一条 = 一页（协议不支持嵌套；多页面收一个条目、页内真子路由分区——`modules/aftersales/console/index.tsx` 是现成姿势）；显隐 = registry ∩ config 启用集 ∩ session scope 三重过滤；**一个条目 = 侧栏一项 + 页内自绘导航** |
| `frontend.admin[]` 条目 | 进**管理组 children**，顺序：平台内置三项 → 存储配置 → 模块 admin 页（manifest 声明序）；三条约法（`/console/admin/` 前缀 / scope ∈ permissions / console 条目禁占该前缀）。组门 `tenant:admin` **菜单与路由双层生效**（#127）——路由经 `admin/*` 分支套 `AdminGate`，与平台内置四项同待遇 |
| `storage: {kind: s3}` | **触发租户管理台「存储配置」页可见**（能力联动：`storageDeclarers ∩ 启用模块 ≠ ∅` 才显示/可达）；运行时 `c.get(TENANT_STORAGE)` 取本租户配置 |
| 模块被停用 | **菜单与路由同隐**（#127）：菜单不出（三重过滤含 config）；直敲模块页/模块 admin 页出「模块可能未启用」Result（路由也吃 config 启用集）。`/console/admin/storage` 的 `StorageGate` 是另一道**能力联动**门。API 面 404（与「不存在」同形） |

> 🕰 上表第 2、4 行在 2026-09-20 曾按**实测旧口径**写（路由不吃 config、模块 admin 页缺
> 组门）——那是当天的实现缺口，**已由 #127 修复**（2026-09-21）：路由层接入 config 启用门、
> 模块 admin 页路由套 `AdminGate`。上表现为修复后的正典口径（菜单与路由同一判定）。

### `frontend.console`：管理台模块页

五项字段（契约源 `packages/platform-sdk/src/manifest.ts`），最小可跑示例见 `modules/demo/manifest.yaml`：

```yaml
frontend:
  console:
    - { path: /console/demo, title: 演示, icon: ExperimentOutlined, scope: demo:view, entry: ./console/index.tsx }
```

- **`path`**——站点路径，**全平台唯一**：两个模块声明同一条 ⇒ `gen-console-registry` 构建期硬失败（菜单按 path 聚合，重复即二义）；**不得占 `/console/admin/` 前缀**（schema 拒，防串组）。壳侧按**前缀**匹配（`pathname === path || pathname.startsWith(path + '/')`），深链 `/console/demo/xyz` 也进得来。
- **`title`**——菜单文案。页内导航的文案归模块自定（协议不管）。
- **`icon`**——AntD 图标**名字符串**，由壳侧白名单 `CONSOLE_ICONS`（`apps/web/src/pages/Console.tsx`）映射成组件。壳不 import 全量图标（`* as Icons` 会把整包打进 bundle）⇒ **未登记的名字不渲染图标、也不报错**；要新图标先在壳里登记。实测一例：`modules/aftersales/manifest.yaml` 声明 `icon: ToolOutlined`，而登记表里没有它 ⇒ 售后那条菜单项目前**无图标**（demo 的 `ExperimentOutlined` 已登记）。
- **`scope`**——页门，也是本节**唯一机器只半查**的字段：**菜单**侧参与 `registry ∩ config 启用集 ∩ session scopes` 三重过滤；**路由**侧由 `ConsoleModulePage` 判 `registry` 命中 + config 启用 + `session.scopes.includes(scope)`——停用出「模块可能未启用」Result、无码 `403 无权访问`（#127 起路由也吃 config）——但 schema **不查它 ∈ `permissions`**（与 `frontend.admin[].scope` 的这处差异见 §2 表脚注）。写一个不存在的码**不报错**，只是那一页永不出现（静默失效）；写 console 条目时按「scope ∈ `permissions[].code`」自查。
- **`entry`**——模块内相对路径，指向该页组件文件（上面示例里的 ./console/index.tsx）；`check-manifests` 验文件存在，registry 生成时去掉 `./` 前缀当 import 说明符。

**多页面姿势**：`frontend.console` 是**扁平数组、协议不支持嵌套** ⇒ 声明**一条** + 页内真子路由（URL 仍是唯一驱动，页内导航模块自绘，见本节开头第三张图）。现成姿势是 `modules/aftersales/console/index.tsx`——一个条目 `/console/aftersales` 挂六个页签，深链可直达。

**两个实测坑**（浏览器实测抓到，正典无载）→ §7 故障速查前端那两行：嵌套 `<Routes>` ⇒ 空白页零报错；相对 `navigate()` ⇒ 丢模块段（跳成 `/console/rules`）。

**菜单与路由同一判定**（#127 起）：两者都走 `registry ∩ config 启用集 ∩ session scope` 三重过滤——模块停用后菜单消失，直敲 URL 也出「模块可能未启用」Result。

### `frontend.admin`：管理组子页

字段五项，与 `frontend.console` **同形**（`{ path, title, icon?, scope, entry }`）；形状与三条约法正典在 `docs/module-protocol.md`「模块管理页：`frontend.admin`」节。

```yaml
# modules/<id>/manifest.yaml —— 本期仓内零真实消费者，照形状写
frontend:
  admin:
    - { path: /console/admin/<id>/settings, title: 模块设置, icon: SettingOutlined, scope: <id>:manage, entry: ./console/admin/settings.tsx }
```

- **三条约法**（前两条 schema 拒，第三条也由 schema 双向拦）：`path` 必须 `/console/admin/` 开头；`scope` 必须 ∈ 本模块 `permissions[].code`（**这一条对 admin 是硬校验，对 console 不是**）；`frontend.console[]` 不得占该前缀。
- **两层权限**：组门 `tenant:admin` + 页门 `scope`（判定同 console 条目），**菜单与路由双层生效**（#127）——路由侧 `admin/*` 分支先套 `AdminGate` 再进 `ConsoleModulePage`。
- **菜单**（侧栏）= registry（构建期聚合，`group:'admin'`）∩ config 启用集 ∩ session scope，整个「管理」组先过 `tenant:admin`；
  **路由**（直敲 URL）= `AdminGate`（组门）→ `ConsoleModulePage`（registry ∩ config 启用集 ∩ session scope）——与菜单同一套判定。
- **服务端 config 不暴露 admin 清单**：菜单侧前端按 registry∩config 自判（`apps/web/src/pages/console-menu.ts`），零后端改动。
- **进组顺序**：平台内置三项（用户管理／角色与授权／我的订阅）→ 存储配置（能力联动）→ 模块 admin 页（manifest 声明序）。
- **停用联动**：模块停用 ⇒ 菜单不出、直敲 URL 也进不去——路由同判 config，出「模块可能未启用」Result（registry 未命中的路径是同款 Result）。
- **已知边界**：本期**零真实消费者**——协议与联动逻辑已交付、fixture 级验证覆盖，但还没有真实模块用它。接入者就是第一个真实用例，记得补浏览器级验收（见文末「已知边界」）。

### `frontend.userApp`：独立前端应用（C 端／移动端）

```yaml
# modules/aftersales/manifest.yaml —— 仓内唯一实例
frontend:
  userApp: { mount: /app/aftersales, dist: ./mobile/dist }
```

- **`mount`**——站点路径前缀。宿主在其上挂静态目录（尾部 `/` 先剥掉）**并补 SPA 兜底**（`index.html`），模块不用自己配 rewrite。
- **`dist`**——**相对模块目录**解析（`apps/server/src/loader.ts` 的 `mount()` 里 `path.resolve(m.dir, dist)`），不是相对仓根。
- ⚠️ **`dist` 目录不存在 ⇒ 装载器静默跳过整段**：`apps/server/src/loader.ts:481` 的
  `if (!existsSync(dist)) continue`（**不报错**）——静态挂载与 SPA 兜底**都没挂**，`/app/<id>/*`
  于是落到控制台顶层 `*` 路由、在移动端 URL 上给你**控制台壳**。前端子包必须先构建（见 §7 前端表）。
- ⚠️ **`mount` 与前端工程自己的 `base` 必须逐字一致**：`modules/aftersales/mobile/vite.config.ts` 的 `base: '/app/aftersales/'` 与 manifest 的 `mount` 是一对。不一致 ⇒ 产物引用**错前缀**（HTML 拿得到、`/assets/*` 全 404），且**没有任何构建期检查替你拦**——只能自查。
- **停用闸门与 API 面同款**：userApp 静态在 `serveStatic` **之前**挂同一道 `gate`——匿名放行（SPA 壳登录前必须可载，业务 API 自会 401/404），**已登录 + 停用 ⇒ 404 与 API 面同形**。语义详见 `docs/module-protocol.md`「停用语义」节。
- 这是「模块交付独立 UI」的**唯一**入口：管理台方向没有「进入应用 → 独立菜单体系」这回事（见本节心智模型）。

### `guest.scope`：访客码

```yaml
# modules/aftersales/manifest.yaml
guest: { scope: aftersales:guest }
```

- **形状**：单值 string，必须 ∈ 本模块 `permissions[].code`（schema 拒越界）——与 `api.internal[].scope` 同纪律：声明一个自己都没有的码 ⇒ 访客拿到的授权恒 403 而无人知晓。
- **发放路径**：宿主 `wechat-oa` 访客登录路（`apps/server/src/routes/auth-wechat-oa.ts`）签 session 时，按**该租户已启用模块**发放这些码（`runtime.enabledGuestScopes`）——发的是**访客码**，不是模块全量权限码；访客身份**不落 Casdoor**（外部用户不进内部 IdP）。
- **它决定访客能调什么**：`api.internal` 里 `scope` = 访客码的那些条目。同一条 `(method, path)` 只能声明一次、一条声明只带一个 scope ⇒ 访客面与管理面只能**按路径分面**（`/guest/tickets` 对 `/tickets`；正例见 `modules/aftersales/manifest.yaml` 的注释）。
- **停用联动**：模块停用 ⇒ 该码不再发放；访客 session 刷新时按当时的启用集**重算**（停用即掉码，`apps/server/src/app.ts` 的接线注释），移动端 API 由闸门 404 + 门卫 403 自然闭合。
- 指针：`docs/module-protocol.md`「停用语义」节的 guest 段。

### `storage`：租户级配置注入

```yaml
# modules/<id>/manifest.yaml —— 声明的是能力，不是租户（写不出 bucket / AK / org）
storage: { kind: s3 }     # 唯一合法值；写别的 ⇒ schema 拒绝 ⇒ 装载失败（进程起不来）
```

- **不声明 = 拿不到**：宿主只对**声明了的**模块、在其 API 子树（`/api/modules/<id>/*`）上挂一条投影中间件；没声明的模块宿主根本不 `set` ⇒ 模块里 `c.get(TENANT_STORAGE)` 恒 `undefined`，行为与今天逐字相同。
- **取法**（模块侧；`TENANT_STORAGE` 与 `TenantStorageConfig` 均从 `@platform/sdk` 导出）：

```ts
import { TENANT_STORAGE } from '@platform/sdk'
import type { TenantStorageConfig } from '@platform/sdk'

const cfg = c.get(TENANT_STORAGE)                    // TenantStorageConfig | undefined
if (!cfg) return c.json({ error: 'ZOS_NOT_CONFIGURED' }, 503)
```

- **值的形状**：`{ kind: 's3', endpoint, region, bucket, accessKeyId, secretAccessKey }`——**投影后的窄值**，不是整行租户记录（租户行里坐着企微／公众号密钥）。配置的作用域**永远是本次请求所属的租户**，模块没有任何途径指定 org。
- **兜底语义（fail-explicit）**：租户五列**全空** ⇒ 注入**平台默认**（进程 env 五键；env 缺任一键 ≈ 没有平台默认 ⇒ 不 set）；**部分填写**（如只填了 endpoint，没有 AK/SK）⇒ **不注入**（`undefined`），**绝不回落平台桶**——回落不是容错，是把「数据落在哪」说错 + 平台替租户承担存储成本。
- ⚠️ **「配了但连不上」在请求路径上不可观测**：预签名是纯本地 SigV4 计算、不发网络请求 ⇒ 平台侧零日志、零告警、各处全绿。故**连通性验证必须在请求路径之外**：管理端**保存时探测**（先探测、通过才写，不留「库里有配置、探测没过」的中间态）+ 显式**「测试连接」**动作（不写库；用于桶被删／AK 轮换／网络策略变更这类事后场景）——两个端点都在 `apps/server/src/routes/admin.ts`。**明确不**在请求路径上探测：每请求一次网络往返会把存储侧抖动放大成平台 5xx，还把可选依赖变成硬依赖。
- 「配置存在但不可用」由**模块自己承接**：宿主只保证如实把本租户的配置（或没有）交给模块，503 错误码与降级话术是模块自己的事。
- 联动提醒：声明 `storage` 也是租户管理台**「存储配置」页可见**的条件之一（`storageDeclarers ∩ 启用模块 ≠ ∅`，见上面的对照表）。
- 指针：`docs/module-protocol.md`「租户级配置注入：`storage`」节——那节自成一体（声明姿势 / 宿主注入的键与位置 / 安全性质 / 兜底语义四层皆有），本节只是接入视角的摘要。

## §6 接入验收清单

全量命令见 `README.md` §常用命令。模块接入后至少跑通：

```bash
pnpm install                  # 收纳新 workspace 包
pnpm test                     # 递归各包 test + scripts/ 守卫单测
pnpm typecheck                # 递归 tsc --noEmit + scripts/
pnpm exec tsx scripts/check-manifests.mjs        # manifest schema + entry/migrations 文件存在性
pnpm exec tsx scripts/lint-architecture.mjs      # 架构不变量
pnpm exec tsx scripts/check-tenant-isolation.mjs # 真库对账：本模块 schema 每张表都有 org 列（需 DATABASE_URL，且该库要有 CREATEDB 权限——它自建一次性库；缺了会响亮失败）
pnpm smoke                    # 装载冒烟（需 DATABASE_URL，且先 pnpm --filter @platform/web build 与 pnpm --filter @aftersales/mobile build——它硬检查移动端产物）
```

CI 四个门禁 job（`unit` / `gates` / `web` / `smoke`）覆盖上面这些——`gates` 另外还跑
`check-compose` / `check-env-example` 与提交纪律守卫，是**超集**；全绿才算接入完成。
装载期检查会额外咬人：**注册路由与 `api.internal` 声明的任一方向差集 ⇒ 装载失败**（进程起不来）。
构建期还有一条：**两个模块声明同一条 `frontend.console[].path` ⇒ `gen-console-registry` 硬失败**
（菜单是按 path 聚合的，重复即二义）。

**给模块测试加一条匿名探测**（`module-protocol.md`「调试：匿名探测」节）——用
`probeAnonymous` 断言每条已声明路由在无 identity 时都是 401，比相信代码里写了什么更硬：

```ts
import { probeAnonymous } from '@platform/sdk/test-util/anonymous-probe'

const results = await probeAnonymous(mountedApp) // 期望每条都是 401
```

**部署/交付不在本文范围**：把模块接入平台（openship 上架、域名、环境变量、回滚）只留指针——
见 `deploy/openship-adopt.md`。

## §7 故障速查

### 后端

| 症状 | 病因 | 出路 |
|---|---|---|
| 端点恒 403 | ① 身份缺该端点的 scope 码（`403 {"error":"FORBIDDEN","need":"<code>"}`——最常见：Casdoor 未授权或角色没挂这个码） ② 请求了已声明路径上**未声明**的 method（`403 {"error":"FORBIDDEN"}`） ③ 声明路径相对/绝对混用（门卫比对基准是宿主**绝对** `routePath`） | ①② 见 `module-protocol.md`「门卫的判定顺序」节；③ 的机制另见同文「实现注意（踩过的坑，勿重蹈）」节 |
| 进程起不来（装载失败） | 注册路由与声明的**双向差集** | 读失败信息里的差集原文（带 `未声明但已注册 […]；已声明但未注册 […]`） |
| 停用模块的 API 面是 404（不是 403） | 停用语义**有意如此**（404 与「不存在」同形 ⇒ 模块 API 面内不可枚举） | `module-protocol.md`「停用语义」节 |
| `c.get(TENANT_STORAGE)` 恒 `undefined` | ① manifest 没声明 `storage` ② 租户行**部分填写**（绝不回落平台桶） ③ 投影中间件挂载顺序错 | `module-protocol.md`「租户级配置注入」节 |

> ⚠️ **裸 `/` 与 scope ∉ `permissions` 不表现为 403**——它们是 schema 拒（`ManifestSchema` 直接
> 拒绝 ⇒ 装载失败 / `check-manifests` 红），见 §2 的「校验」列。别在这张表里找它们。

### 前端

| 症状 | 病因 | 出路 |
|---|---|---|
| 模块页整块空白、零报错 | 用了嵌套 `<Routes>`——模块页挂在壳的 splat 路由 `*` 之下，嵌套路由按 splat 剩余段匹配，永远匹配不上 | 按 pathname 末段直接选页（照 `modules/aftersales/console/index.tsx`） |
| 点页签跳到别的路径（模块段丢失，如 `/console/rules`） | 相对导航以壳的 splat 路由为基准解析 | 导航一律用**绝对路径** |
| 管理台 `message.*` 抛 TypeError | 壳里 antd `<App>` 提供者缺失（`useApp` 是裸 `useContext`） | 已由 `Console.tsx` 的 `<AntdApp>` 覆盖；模块页不需要自己加 |
| 访问 `/app/<id>` 拿到的是控制台壳（不是模块前端） | `frontend.userApp.dist` 目录不存在 ⇒ 装载器**静默跳过**（不报错）：静态挂载与 SPA fallback 都没挂，请求落到控制台顶层 `*` 路由 | 先构建前端子包（`pnpm --filter <pkg> build`）；CI 的移动端产物检查只覆盖 `modules/aftersales/mobile`，新模块要自己保证 |

> 前端表的空白页 / 丢模块段两条是 aftersales M3a 浏览器实测抓到的，正典里没有等价
> 记载——它们只在 `modules/aftersales/console/index.tsx` 的注释里，本表把它提到接入视角。

## 已知边界

- **manifest 三个字段是预留（无消费者）**：`notifications.dir`、`config.schema`（schema 接受、
  无人读取）、`bindings`（仅 `check-manifests` 查键白名单，无运行时消费）。声明它们**不会有
  任何效果**——见 §2 表。清理与否另议。
- **`frontend.admin` 本期零真实消费者**：协议与联动逻辑已交付（fixture 级验证覆盖），但还没有
  真实模块用它。第一个真实模块接入时要补**浏览器级**验收（沿 2026-09-20 spec 的待销账）。
- **平铺菜单在模块多了会破**：侧栏模块条目是平铺的（协议不支持嵌套），行业经验约 7±2 项。
  届时的演进先例是 Grafana 的做法——section 分组 + 排序权重 + **管理员侧** placement 配置
  （与本平台「模块作者 manifest 决定序」不同）。现在不做（YAGNI），方向先钉住。
