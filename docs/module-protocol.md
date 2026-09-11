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
