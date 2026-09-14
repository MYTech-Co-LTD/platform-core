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
- ⚠️ **闸门只覆盖模块 API 半边：`frontend.userApp` 静态未落**（R4 复审 S-d；**存量缺口，
  本轮不改行为**）。闸门挂在 `base + '/*'`；而 `frontend.userApp` 的静态目录由 `loader.mount()`
  另挂在 manifest 自己的 mount 路径下、**不经过闸门** ⇒ 显式 `enabled=false` 后
  `/api/modules/<id>/ping` 返 404，而 `<mount>/index.html` 仍 200。**休眠中**：仓内暂无模块声明
  `frontend.userApp`（唯一模块 `modules/demo` 只声明了 `console`），当前无可观测面；将来有模块
  启用它时必须一并补闸，否则「停用 = 看不到这个模块」会被读成绝对规则。

## 租户数据隔离（spec-1 §2，2026-09-14）

模块的表分两类，**类属是设计决定，写迁移前就要想清楚**：

- **租户数据表**：存「某租户的数据」的表，必须带 `org text not null` 列，值 =
  `identity.orgId`（宿主注入的身份里现成的租户材料，即该租户的 Casdoor org）。
- **全局表**：字典/配置类跨租户共享的数据，可不带 org——但必须在模块 README 声明理由，
  评审时按此核对。

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

CI 门禁：暂无（文档 + 评审守）；等第一个真实业务模块落地后再评估要不要扫 migrations 的
建表语句（本仓规矩：门禁升级是单独的决定）。

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
