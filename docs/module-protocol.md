# 模块接入协议：API 声明（`api.internal`）

> 适用：`modules/<id>/manifest.yaml`。契约源是 `packages/platform-sdk/src/manifest.ts`。
>
> **本文存在本身就是一条教训**：`api.internal` 是一个曾在仓里活了一阵子的**死字段**——当年
> 没有任何一处文档描述它该长什么样，于是没人知道该怎么写，也没人发现它没有任何消费者。
> 一个字段死于零文档。补上这份文档，是让"没人知道它是什么"这件事不再复发的最低成本手段。

## 规则：没声明 = 不可达

模块的每条 API 路由**必须**在 manifest 里声明 method / path / scope：

```yaml
api:
  internal:
    - { method: GET,  path: /ping,  scope: demo:view }
    - { method: POST, path: /notes, scope: demo:note }
```

- `method` 只接受 `GET` / `POST` / `PUT` / `PATCH` / `DELETE`
- `path` 是**模块内相对路径**，必须以 `/` 开头，且与 `createRouter` 里注册的路径模式
  **逐字一致**（含 `:param`，如 `/notes/:id`）。**不能是裸 `/`**：Hono 会把 `use('/')`
  展开成 `/*`，运行期 `routePath` 与比对表对不上 ⇒ 该路径**恒 403 且无人知晓**，schema
  直接拒绝这种写法
- **声明路径里写 `*` 时，一条声明授权的是整棵子树**（PR#5 评审 R2 补记）。schema 只拒绝裸 `/`，
  `*` 是放行的（`GET /files/*` 能过校验，装载期双向核对也照过——它比对的是**字面模式**）。
  但门卫是拿这条路径去 `use()`，而 Hono 的 `use('/files/*')` 匹配的是 `/files/` 下的**所有**
  路径 ⇒ 一条声明把整棵子树一起放行了：「逐字一致」这条核对在它上面退化成「整棵子树对得上」。
  **取舍**：不在 schema 里拒绝 `*`——`app.get('/files/*', h)` 是 Hono 的合法路由写法，拒绝 `*`
  会连带封掉真实存在的写法，而"声明一棵树"本身并非错误，只是**语义比逐条声明粗**。代价由声明者
  承担：要精确到端点就用具体路径或 `:param`（路径参数会被门卫按模式匹配，粒度是"一个段"而不是
  "一棵树"）
- `scope` 必须是本模块 `permissions[].code` 里的码——声明一个自己都没有的码，该路径会恒 403
  而无人知晓，schema 直接拒绝这种写法
- 模块**不再写** `requireScope`：门禁由宿主按声明**强制施加**，模块再写一遍也是冗余（`requireScope`
  仅为兼容保留，仍从 `@platform/sdk` 导出——删除它属于另一个决定，本协议不依赖它被删）。
  漏写不会导致匿名可读——那条路已经堵死：未声明的 `(method, path)` 一律 403，装载期的双向核对
  还会把"注册了没声明"直接变成装载失败

> 同一个 `(method, path)` 只能声明一次，重复声明会被 schema 拒绝（否则门卫的判定出现二义）。

## 装载期双向核对（fail-fast）

装载器把 `router.routes` 与声明集合**双向比对**，任一方向不一致直接**装载失败**：

| 情形 | 结果 |
|---|---|
| 注册了路由但没声明 | **装载失败**（绝不半挂） |
| 声明了路径但没注册（幽灵声明） | **装载失败** |
| 注册了**未声明的多方法端点**（`app.all('/secret', h)`、`use('/backdoor', 终结 handler)`） | **装载失败**（见下） |
| 声明了不属于本模块的 scope | schema 校验失败（`check-manifests` 门禁同时拦下） |
| 同 `(method,path)` 声明两次 | schema 校验失败 |
| 声明路径只有一条**非终结** `use(path, mw)` 撑着（无任何 handler） | **装载通过而运行期 404**——已知放松，见下 |

### `method === 'ALL'` ≠ 一定是中间件

Hono 里 `app.all()` 与 `app.use()` **同记 `'ALL'`**（`hono-base.js` 的 `#addRoute('ALL', …)`），
所以 ALL 里混着两种东西，必须分开处置：

- **无通配的 ALL 就是"多方法端点"**——它只匹配**它自己那一条**请求路径（实测：`use('/prefix')`
  不匹配 `/prefix/notes`，与具体 method 无关）。`app.all('/secret', h)` 是多方法端点（webhook
  一类）的常见写法，正是"改了代码忘了改 manifest"这一族。规则：**它的路径必须逐字等于某条
  声明路径**，否则装载失败。想写多方法端点就**逐 method 声明**（`app.all('/multi', h)` +
  声明 `GET /multi`、`POST /multi`）——此时它落在这些声明的门卫下，门卫按 method 逐条判定，
  未声明的 method 照旧 403。
- **含 `*` 的 ALL 才是中间件形态**（`use('*')`、`use('/prefix/*')`、`mount()`）。它们匹配的
  请求路径集合**大于**任何一条声明路径，逐条声明的门卫盖不住；装载器因此另挂一道**兜底门卫**：
  凡是没被任何一条声明门卫放行的请求，一律 401/403（fail-closed）。没用通配 ALL 的模块不挂
  兜底门卫，行为与从前逐字相同。
  为什么不能直接把 `declaredScopeGate` 挂到通配路径上：门卫判定基准是 `c.req.routePath`，而在
  通配路径上它恒为通配模式本身（已实证：`use('*')` 下恒为 `/*`）⇒ 恒 403，会把合法中间件
  形态打坏。故兜底门卫改问"本次请求是否已被某条声明门卫放行"。

#### 兜底门卫把 404 变成了 401/403（**仅**对用通配 ALL 的模块）

PR#5 评审 R2 补记：兜底门卫拦的是"模块自己确实会处理、但谁都没声明过"的路径（如
`use('/prefix/*')` 下的 `/prefix/other`）。这类路径在加兜底门卫**之前是 404**（Hono 没匹配到
路由），**之后是 401**（无 identity）或 **403**（有 identity）——状态码变了，这是有意的
fail-closed：`404` 与 `403` 的差别会泄露"这个路径存在吗"，而后者是路由枚举的起点。
**没用通配 ALL 的模块行为逐字不变**：未声明路径仍由模块自己的路由表决定（通常是 404）。

#### 已知放松：非终结 `use(path, mw)` 能满足逐 method 声明

PR#5 评审 R2 钉住的一条边界。`use('/x', 非终结 mw)`（只调 `next()`、**没有任何 handler**）也能
满足 `GET /x` + `POST /x` 的声明 ⇒ **装载通过而运行期 404**。

原因：装载器**无法区分** `app.all('/x', h)`（终结，见上，合法写法）与 `use('/x', mw)`（非终结）
——两者在 `router.routes` 里是同一条 `'ALL'` 记录。因此这里**没有**加装载期 warn：它会对合法
写法误报，把 warn 变成噪音（一条总在叫的告警等于没有告警）。改为把行为**钉死在测试里**
（`apps/server/src/loader.test.ts` 的「已知放松」用例）并在本文写明。

代价：`声明 ⟺ 实现` 对 exact-ALL 路径**不再逐字成立**——只保证"这条路径有实现"，不保证
"实现是终结 handler"。安全侧不受影响（声明路径的门卫照挂、未声明的 method 仍 403），放松的
只是**可达性**（404）。

所以「改了代码忘了改 manifest」的后果是**进程起不来**，而不是静默漏掉一个鉴权。

失败信息带双向差集原文，例如：

```
模块 "demo" 的 api.internal 声明与代码不一致：
未声明但已注册 [GET /ping]；已声明但未注册 [-]（未声明 = 不可达；声明与代码必须逐条对齐）
```

## 门卫的判定顺序

宿主在模块 router 外层包一层门卫（`loader.applyDeclaredApiGate`），判定顺序固定：

1. `无 identity` → `401 {"error":"UNAUTHENTICATED"}`
2. `(method, path)` 未声明 → `403 {"error":"FORBIDDEN"}`（fail-closed，不泄方法枚举）
3. `有 identity 但无 scope` → `403 {"error":"FORBIDDEN","need":"<code>"}`

错误体与 `requireScope` **逐字一致**，模块与前端无需感知差异。

模块侧取身份仍走 `c.get('identity')`（由宿主注入），`Identity` 类型从 `@platform/sdk` 导出。

## 停用语义：停用 = 该租户看不到这个模块

`platform.tenant_module.enabled=false` ⇒ **该租户的这条模块 API 一律 404**。**不是 403**：
403 会明说"存在但被停用"；404 与「这个模块压根不存在」**同形**，于是在**模块 API 面内**停用状态
**不可枚举**——打 `/api/modules/<id>/*` 探不到停用与不存在之间的差别。闸门按**租户**在请求期判定，
与 `/config` 的清单闸门**同源**（同一个 `enabledFor` 实现，见 `apps/server/src/loader.ts` 的
`enabledForImpl`）——清单里看不到却仍能调通的模块，正是停用语义只落一半时的样子。
「无行 = 启用默认」照旧：只有显式 `enabled=false` 行才关闸。

⚠️ **「不可枚举」的作用域是模块 API 面，不是系统面**（R4 复审 must-fix 2——本节旧措辞曾写成无
scope 的绝对断言，改掉）。`GET /api/platform/config` 是**有意的披露面**（它本来就给租户看自己的
模块清单），且**只吃租户不吃 identity**——`apps/server/src/routes/platform.ts` 的 `/config` handler
只读 `c.get('tenant')`、做 `enabledFor(t.id)` 过滤，链路上没有任何身份门（宿主 `apps/server/src/app.ts`
把它挂在租户中间件之后、会话中间件旁，无 `identity` 前置要求）。⇒ 任何**能设 Host 的匿名者**都能
取到该租户的**已启用模块清单**，**停用模块直接缺席**；再拿另一个租户的同一响应作对照，就能把
「本租户停用」与「平台内压根不存在」分开。
实测（真 `buildApp`，匿名请求**只带 Host、不带任何凭据/ Cookie**）：

| 请求 | 结果 |
|------|------|
| `GET /api/platform/config` Host=acme.test（demo 已显式停用） | `200 {"tenant":{"slug":"acme",…},"modules":[]}` |
| `GET /api/platform/config` Host=beta.test（demo 未停用） | `200 {…"modules":[{"id":"demo",…}]}` |
| `GET /api/modules/demo/ping` Host=acme.test，停用 | `401 {"error":"UNAUTHENTICATED"}` |
| `GET /api/modules/demo/ping` Host=acme.test，启用 | `401 {"error":"UNAUTHENTICATED"}`（与停用**逐字相同**） |

即：模块 API 面内匿名分不出停用/启用（后两行同形），但 `/config` 这一面把「该租户启用了哪些模块」
匿名公开了。属**存量行为**（`/config` 与 `enabledFor` 都早于停用闸门），非本轮引入；要收紧只能给
`/config` 加身份门，那会改掉控制台首屏的取数前提，不在本闸门范围内。

实现要点（都在 `loader.mount()` 里，动手前先读那段注释）：

- 闸门用 `app.use(base + '/*', gate)` 一条挂在**模块路由之前**。**不需要**再挂一条精确的
  `use(base)`：实测 `/*` 已经吞掉空段、同时命中 `/base`、`/base/`、`/base/ping`（R4 评审 S4
  删掉了那条冗余的精确注册——它只让裸 base 的请求多跑一次 `enabledFor`，把两次 DB 往返花在
  一个本就没有端点的路径上）。
  顺序是硬约束：Hono 里 handler 先注册、`use` 后注册 ⇒ 该中间件**永不执行**（见下节第 2 条），
  闸门晚挂就等于没挂。
- 闸门**不做缓存**：每次请求查一次 `enabledFor`（+1 次 DB 往返）。这是刻意的——「停用后多久
  生效」不该有一个隐式窗口。将来若测出瓶颈要加 TTL，必须同时把窗口语义写进这里与代码注释。
- **两条放行路径**，都不在本闸门职责内：
  - **无租户上下文** → 放行。真实链路上租户中间件先于一切业务路由，闸门见到的请求必带租户；
    未命中 Host 的那类请求早已被租户中间件 404/抛错拦掉。
  - **无 identity（匿名，R4 评审 S5）** → 放行。闸门挂在模块**自身门卫**之前，匿名请求反正
    会被门卫 401 挡下，到这里查库纯属白费：改动前匿名命中模块 API 是 **0 次 DB**，挂上闸门
    后变成每请求 1 次，而模块 API **没有独立限流** ⇒ 匿名流量可被用来放大 DB 压力。放行也
    **不**削弱不可枚举性——匿名打**停用**模块与打**启用**模块的落点都是门卫的 401
    `{"error":"UNAUTHENTICATED"}`，响应逐字相同，停用与否无从区分；**已登录**用户照旧拿到
    404（那条路径上闸门照常判定）。**注意这条的 scope 只到模块 API 面**——系统面上 `/config`
    照旧匿名公开该租户的启用清单（见上一节的 ⚠️）。
- **userApp 静态已吃同一道启用闸门**（售后 M1，2026-09-15 收口）：`frontend.userApp` 的
  静态目录在 `mountPath + '/*'` 上先挂模块 API 同款 `gate` 再 serveStatic——匿名放行
  （SPA 壳登录前必须可载，业务 API 自会 401/404），**已登录 + 停用 ⇒ 404 与 API 面同形**。
  「停用 = 看不到这个模块」现在在 API 面与 userApp 面两侧同时成立（`/api/platform/config`
  披露面的既有口径不变，见上节 ⚠️）。

- **`guest: { scope }` 声明（售后 spec §1.3 协议小扩展）**：模块可声明自己的访客码
  （`scope` 必须 ∈ `permissions[].code`，schema 拒绝越界）；宿主 `wechat-oa` 访客登录路
  签 session 时按**该租户已启用模块**发放这些码——停用模块的移动端 API 由闸门 404 +
  门卫 403 自然闭合。访客身份不落 Casdoor（外部用户不进内部 IdP）。

## 模块管理页：`frontend.admin`（2026-09-20）

> 适用：`modules/<id>/manifest.yaml` 的**可选** `frontend.admin`。契约源
> `packages/platform-sdk/src/manifest.ts`。spec：`docs/superpowers/specs/2026-09-20-module-admin-pages-design.md`。

```yaml
frontend:
  admin:
    - path: /console/admin/<module>/<page>   # 必须 /console/admin/ 开头（schema 拒绝）
      title: 页面标题
      icon: SettingOutlined                  # 可选；壳侧 CONSOLE_ICONS 同规
      scope: <module>:manage                 # 必须 ∈ permissions[].code（schema 拒绝）
      entry: ./console/admin/<page>.tsx      # 模块内文件（check-manifests 验存在）
```

- **语义**：模块自有的「管理」组子页。门禁双层——组门 `tenant:admin`（宿主施加，同平台
  内置管理页）+ 页门 `scope`（同 console 条目判定）。
- **显隐联动**：菜单/路由 = registry（构建期聚合，`group:'admin'`）∩ config 启用集（运行时，
  订阅/tenant_module）∩ session scope——与 `frontend.console` 三重过滤同构。**模块停用 ⇒
  页面消失**（菜单不出、直敲出「模块可能未启用」Result）。
- **服务端 config 不暴露 admin 清单**：前端按 registry∩config 自判，零后端改动。
- **path 约束双向**：admin 必须落 `/console/admin/` 下；`frontend.console[].path` 不得占用
  该前缀（schema 双拦——防串组：菜单把 console 条目当模块区平铺页）。
- **管理组 children 顺序**：平台内置三项（用户/角色/我的订阅）→ 存储配置（能力联动：
  `storageDeclarers ∩ 启用模块 ≠ ∅`，见下）→ 模块 admin 页（manifest 声明序）。
- **存储配置页归属**：留宿主（管的是 `platform.tenant` 租户全局五列，非模块私有配置）；
  `/api/admin/storage` 门禁保持 `tenant:admin` 不随模块联动（宿主域，spec 记录在案）。

## 租户数据隔离（spec-1 §2，2026-09-14）

模块的表分两类，**类属是设计决定，写迁移前就要想清楚**：

- **租户数据表**：存「某租户的数据」的表，必须带 `org text not null` 列，值 =
  `identity.orgId`（宿主注入的身份里现成的租户材料，即该租户的 Casdoor org）。
- **全局表**：字典/配置类跨租户共享的数据，可不带 org——但必须在模块 README 声明理由，
  评审时按此核对；**真有全局表时**还要在该表建表语句上方加一行机器可读的豁免标记
  （`-- global-table: <理由>`，契约见下节「租户隔离 CI 门禁」）。

三条纪律：

1. **读写一律按 org 过滤**：`where org = $1`，参数取 `c.get('identity')!.orgId`。漏过滤 =
   共享部署上租户间数据互见（这正是本约定要堵的洞——demo 模块曾没有 org 列）。
2. **唯一约束必须含 org**：`unique(org, …)`。漏掉会出现「A 租户占住名字，B 租户用不了」。
   没有业务唯一键的表（如纯流水）不适用，不强加。
3. **热路径索引以 org 为前缀列**：查询都带 org，不前缀等于全表扫。

**为什么隔离键是 `org` 文本而不是 `tenant_id` 外键**：identity 里现成的是 orgId，模块代码
零 join、自包含；不跨 schema 引 `platform.tenant`（B1 边界干净）；org 与租户 1:1，权威源
在 Casdoor + 租户行。

**存量数据回填口径**（示例见 `modules/demo/migrations/003_note_org.sql`）：无法归属的旧行
回填**空串**——空串不等于任何真 org，对所有租户不可见；宁可不可见，不可错归属。

CI 门禁：见下节（`scripts/check-tenant-isolation.mjs`，跑在 `ci.yml` 的 **gates** job）。

## 租户隔离 CI 门禁（issue #77，2026-09-16）

**跑在哪**：脚本 `scripts/check-tenant-isolation.mjs`，由 `.github/workflows/ci.yml` 的 **gates**
job 在四条守卫之后执行（`pnpm exec tsx scripts/check-tenant-isolation.mjs`；gates 为它挂了
postgres service）。同一脚本的 fixture 单测在 `scripts/check-tenant-isolation.test.ts`，跑在
unit job 的 `pnpm run test:guard` 里。

**判据是「真库对账」，不是扫 DDL**：脚本真跑一遍每个模块的 migrations（跑进它自建的一次性库
`platform_tenant_isolation_check`，**绝不碰 DATABASE_URL 指的那个库**），再查
`information_schema` 要「该模块 schema 下的每张表都有 `org` 列」。两条读法写死在这里，别按
别的理解改：

1. **按全部 migrations 的累积终态判，不按文件判**。`modules/demo/001_note.sql` 建 `demo.note`
   时没有 org，org 是 `003_note_org.sql` 后补的——按文件判的正则实现会**误报 demo**，而 demo
   正是每个新模块照抄的模板。真库天然只看终态。（回归用例见
   `check-tenant-isolation.test.ts` 的「累积终态」一组。）
2. **只认 `org` 列存在**：不查 `not null`、不查唯一约束含不含 org、不查索引前缀。上面三条纪律
   里只有 ① 进机器判据——②③是**条件适用**的（本文件自己写了「没有业务唯一键的表不适用，
   不强加」），机器判不出「这张表该不该有业务唯一键」，查它必然误报，故仍是评审守；`not null`
   管的是「行可不可见」而非「租户会不会互见」，纳入判据会把门禁的暴露面从「隔离」漂到「数据
   质量」。**纪律正典是三条，门禁只机检第一条。**

另有两条**不看 org** 的静态检查，守的是门禁自身的健全性（fail-closed）：模块迁移里的
`create table` 必须建在**本模块 schema**（= manifest `id`，「三同纪律」），建到别处或不限定
schema 一律判违规（门禁只查本模块 schema，建到别处 = 门禁看不见 = 静默放行）；豁免标记必须
紧贴一条本模块的 `create table` 且理由非空。

**豁免出口：`-- global-table: <理由>`（真有全局表时用）**

```sql
-- global-table: 省份字典，全租户共用，无租户归属
create table if not exists demo.province (…);
```

- 与 DDL **同址**：理由长在表的定义旁边，评审一眼可见，也不会与表走散。这就是它不做成 manifest
  字段的理由——manifest 是**机器契约**（其合法性由 `check-manifests` 守），把评审说明塞进契约
  字段会让契约变成评审簿，且新模块模板里会多出一个空字段，空字段很容易变成默认勾选。
- 理由**必填**（空理由即违规）、标记必须**紧贴**建表语句（挂空即违规）；它**只豁免「org 列
  缺失」这一条判据**，②③纪律照旧由评审守。
- **「本模块没有全局表」不需要任何标记**（售后模块在 README 声明即可）：标记是「真有全局表」
  时的出口，不是「声明我没有」的入口。

## 租户级配置注入：`storage`（M3c 每租户可配 ZOS，2026-09-16 拍板）

> 适用：`modules/<id>/manifest.yaml` 的**可选** `storage` 字段 + 宿主在模块 API 子树上挂的
> 投影中间件。契约源是 `packages/platform-sdk/src/{manifest,module}.ts`。
>
> **本节自成一体**：规则以本节为准，过程稿（`docs/superpowers/specs/2026-09-16-m3c-tenant-storage-protocol-design.md`）
> 只作决策留档，不再承载规则。

**它解决的是什么**：模块配置过去只能来自**进程 env**——`.env` 是进程级的，而 `createRouter` 又是
**装载期只调一次**（`apps/server/src/loader.ts:294`）⇒ 多租户同进程部署时，所有租户**必然**共用一份
配置（共用一个桶 + 一套 AK/SK）：做不到租户自带存储（BYO）、一把密钥泄露的半径 =**全租户**、
也无法按租户归集存储成本。

**这不是隔离修复**（别把它写成修洞）：既有三道隔离都是完好的——key 规范 `aftersales/{org}/…` 带
`{org}` 段、每次读都 `where org = $1`、预签名 URL 由服务端按 DB 行生成（客户端拿不到拼接权）。
缺的是**可配置性**：协议里过去没有承载「本租户的配置」的位置。

### 模块侧：怎么声明（**不声明 = 拿不到**）

```yaml
# modules/<id>/manifest.yaml
storage: { kind: s3 }     # 缺省 = 不声明 = 宿主不注入，本模块行为与今天逐字相同
```

- `kind` 是**收窄的枚举**（目前只允许 `s3`）。写别的值 ⇒ manifest schema 拒绝 ⇒ **装载失败**
  （进程起不来，不是告警）——与 `api.internal[].scope` / `guest.scope` 的 fail-fast 同风格。
- 字段**可选**：现有模块一行不改仍装载通过（见下「加而不改」）。
- ⚠️ 这是**声明进 manifest**的第三种能力（前两种是 `api.internal[]` 与 `guest.scope`），理由相同：
  manifest 是本仓模块能力的**唯一审计面**——看 manifest 就知道某模块用不用存储。宿主**无条件**
  注入会让所有模块都拿得到租户存储凭据，违反最小权限，审计面也消失。

### 宿主侧：注入的键、形状与位置

宿主在**模块 API 子树**（`/api/modules/<id>/*`）上挂一条中间件，把**本次请求所属租户**的配置
投影进该请求的 Hono context：

```ts
import { TENANT_STORAGE } from '@platform/sdk'
import type { TenantStorageConfig } from '@platform/sdk'

const cfg = c.get(TENANT_STORAGE)              // TenantStorageConfig | undefined
if (!cfg) return c.json({ error: 'ZOS_NOT_CONFIGURED' }, 503)
```

| 名 | 值 / 形状 | 出处 |
|---|---|---|
| context 键常量 | `TENANT_STORAGE`，值 `'platform.tenantStorage'` | `packages/platform-sdk/src/module.ts` |
| 值的类型 | `TenantStorageConfig = { kind: 's3'; endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string }` | 同上 |
| 注入点 | `<模块 API 基路径> + '/*'`（**仅声明了 `storage` 的模块的 API 子树**） | `apps/server/src/loader.ts` 的 `mount()` |

- **为什么是模块子树**：注入面 =「声明过的模块」自身，宿主自己的路由与未声明的模块都不在面上。
- **为什么键名带 `platform.` 前缀**：避免与模块自有 context 变量撞车（照 `DECLARED_GATE_APPROVED`
  的既有做法）；键名是**宿主 set / 模块 get 的约定**，编译器不连线，改名是破坏性变更。
- **挂载顺序是硬约束**：**在启用闸门之后、`app.route(base, m.router)` 之前**。Hono 里 handler
  先注册、`use` 后注册 ⇒ 该中间件**永不执行**（见「实现注意」第 2 条）——顺序错了的表现是模块
  `c.get(TENANT_STORAGE)` **恒 `undefined`**（附件类端点全线 503），代码里却看不出问题。
  排在闸门之后：停用模块该拿 404 就先拿 404，不必先花代价解配置。
- **零额外 DB 往返**：租户行本来就已被请求链的租户中间件取过（`apps/server/src/tenant.ts`，
  配置列若落在 `platform.tenant` 则 `select *` 自动带出），投影是**纯函数、零 IO**。
- **不声明就不 set**：manifest 没写 `storage` 的模块，宿主不挂这条中间件 ⇒ `c.get(TENANT_STORAGE)`
  恒 `undefined`。
- ⚠️ **它不是门卫**：这条中间件**不做鉴权、不返回 401/403**，只做投影。「宿主施加门禁」与
  「宿主注入材料」是**两件事**，混为一谈会让后人以为注入了材料就等于加了权限。

### 安全性质：声明的是「能力」，不是「租户」

这三条是本节必须写死的边界：

1. **配置的作用域永远是「本次请求所属的租户」**——宿主从 `c.get('tenant')` 取，模块**没有任何
   途径指定 org**（协议里不存在「模块说明自己要哪个租户」的位置，装成一个按 org 的解析器或
   缓存也是同类越权，一样被排除）。
2. **注入的是投影后的窄值，不是 `TenantRow`**——⚠️ **绝不**把租户行整个递给模块：`TenantRow`
   里坐着 `wecom_secret` / `wechat_oa_secret` / `casdoor_org`（`apps/server/src/tenant.ts`）。
   把整行给模块 = 每个声明了 `storage` 的模块都能读到该租户的**企微/公众号密钥**，还等于把模块
   引到 `platform` schema 的语义上（B1 的精神）。**只投影存储五元组。**
3. **manifest 里不含凭据名的任何自由度**——只写得出 `kind`，写不出 bucket / access key / org。

### 兜底语义（fail-explicit）

| 租户行上的存储配置 | 宿主行为 | 模块读到的 |
|---|---|---|
| **五列全空**（未配） | 注入**平台默认**（进程 env 五键；env 缺任一键 ⇒ 等价于「没有平台默认」⇒ 不 set） | 有值 / `undefined` |
| **部分填写**（如只填了 endpoint，没有 AK/SK） | **不注入**（**绝不回落平台桶**） | `undefined` |
| 五列全填 | 注入该租户自己的配置 | 有值 |

- **部分填写一定不回落**：回落不是容错，是**把红改成绿**——租户以为附件落在自己的桶，实际落在
  平台桶 ⇒ **数据位置被误述** + 平台替租户承担存储成本。「部分填写」没有任何可能是有意为之。
- **env 五键保留**，语义从「唯一来源」降为「**平台默认**」（B9 契约不变）；`platformStorageFromEnv`（SDK）
  现成的「缺任一键 ⇒ `null`」正好承接「没有平台默认」这个状态。
- ⚠️ **「配了但连不上」在请求路径上不可观测**：预签名走 SigV4 **纯本地计算、不发网络请求** ⇒
  宿主**永远无法**在请求路径上发现配置坏；错误只在客户端拿预签名 URL 直连对象存储时出现，而那是
  浏览器/手机直连、**平台侧看不到**——表现在平台侧是零日志、零告警、各处都绿。
  ⇒ **连通性验证必须放在请求路径之外**：管理端**保存时探测**（拒绝保存并回显原因）+ 显式
  **「测试连接」**动作（用于桶被删 / AK 轮换 / 网络策略变更这类事后场景）。**明确不在请求路径上
  探测**：每请求一次网络往返会把存储侧抖动放大成平台 5xx，且把一个可选依赖变成硬依赖。
- 由此，**「配置存在但不可用」由模块自己承接**：宿主只保证「如实把本租户的配置（或没有）交给
  模块」，503 的错误码与降级话术是模块自己的事。

### 加而不改（兼容性论证）

**`ModuleContext` 保持 `{ pool }` 一字不动**：新能力 = manifest **可选字段** + context **键**
（不声明就不 set）。

⇒ 「现有模块不受影响」不是「我们改了但保证不破坏」，而是**根本没改**——`modules/demo` 与
`modules/aftersales` 的 `createRouter` 一行不动，照旧装载通过。装载期的双向核对（本文件上一节）
不受影响：它核对的是**路由集合**，本节不动任何路由。

> 为什么不把能力做成 `ModuleContext` 上的可选字段（如 `storage?: boolean` / `storageFor(c)`）：
> 收益与上文相同，代价更大——`ModuleContext` 的每条边都受 Hono 泛型不变性摩擦
> （`packages/platform-sdk/src/module.ts:27-43` 记录了那段摩擦史），接口每宽一分摩擦面就大一分；
> 且一个**可选**字段对「模块要不要声明」不提供任何结构约束，声明仍得另想办法。

### 与既有不变量的关系

| 不变量 | 关系 |
|---|---|
| **B1 跨 schema（三同）** | **不触犯**：模块**不读** `platform.tenant`——投影由**宿主**做。⚠️ 由此引出一条**新约束**：注入的必须是**投影后的纯值**（见上「安全性质」第 2 条）。 |
| **声明即授权（fail-closed）** | **强化**：新能力同样走 manifest 声明；未声明 = **拿不到**（`undefined`），与「未声明路径 = 不可达」同构。 |
| **装载期双向核对** | **不触犯**：它比对路由集合与 `api.internal` 的差集；本节不动路由。 |
| **`enabledFor` 只能请求期门控** | **同构不冲突**：同样是请求期解析；装载期只拿着 manifest 的**声明**（不含任何租户数据），且顺序上启用闸门在前。 |
| **I-1 挂载顺序** | **天然满足**：投影中间件挂在 `runtime.mount()` 内部（⑨），而租户→会话（⑥）在它之前（`apps/server/src/app.ts`）⇒ 一定读得到 `c.get('tenant')`。 |
| **B9 env 契约** | **不触犯**：env 五键保留（`.env.example` 不变），语义降为「平台默认」。 |

> ⚠️ 与**售后 spec §1.3 的公众号** `wechat_oa_app_id/secret` **只同构一半**：配置都落租户行，但公众号那两个键的
> 消费方是**宿主自己的路由**（它直接 `c.get('tenant')`），**从来没有交付给模块**过。本节是**新增的
> 一条交付通路**，不是复用既有通路——别以为「照公众号抄一下就行」。

## 实现注意（踩过的坑，勿重蹈）

门卫能不能生效，**取决于挂载方式**，与门卫自身的代码无关。三条已实证的 Hono 行为：

1. `use('*', gate)` 里 `c.req.routePath` 恒为 `/*` ⇒ 「一个通配门卫查表」拿不到下游 handler
   的路径，**不可行**。
2. **handler 先注册、`use` 后注册 ⇒ 门卫永不执行**。所以**不能**在 `createRouter()` 返回后对
   模块 router 补 `use(path, gate)`——那会造出一个「代码里有门卫、运行时永不生效」的静默洞。
3. 正解是**包裹层**：新建 Hono → 先挂门卫 → 再 `route('/', 模块 router)`。

另有一条基准问题：包裹层被宿主 mount 到前缀下之后，`c.req.routePath` 回来的是**绝对路径**
（如 `/api/modules/demo/ping`），而 `use()` 的注册路径必须保持**模块相对**（写成绝对会叠成
两段前缀）。装载器因此给门卫传宿主绝对路径、给 `use()` 传模块相对路径——两者不是一回事。

## 调试：匿名探测

`probeAnonymous(router)`（`@platform/sdk/test-util/anonymous-probe`）对每条已注册路由发一个
**无 identity** 的请求，返回实测状态码。用它确认门卫**真的生效**，而不是相信代码里写了什么：

```ts
import { probeAnonymous } from '@platform/sdk/test-util/anonymous-probe'

const results = await probeAnonymous(mountedApp) // 期望每条都是 401
```

路径参数（`/notes/:id`）与通配段（`*`）会被替换为占位段后再请求。

**`method === 'ALL'` 的条目也要探测**（PR#5 评审 R1）：Hono 里 `app.all('/secret', h)` 与
`app.use('/backdoor', 终结 handler)` 同样记为 `'ALL'`，它们**是端点、不是中间件**。旧实现把
ALL 整条滤掉，与装载器的过滤条件逐字相同——两边共享同一个盲区，于是「每条路由都不可匿名到达」
这条回归网对 ALL 形态结构性地看不见（实测：装载器放行的 `app.all('/secret')` 匿名 200，探测全绿）。
ALL 条目没有单一 method 可发，探测用 `GET` 代表，结果里 `method` 原样回 `'ALL'`。
