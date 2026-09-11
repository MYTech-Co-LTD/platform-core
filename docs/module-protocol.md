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
  **逐字一致**（含 `:param`，如 `/notes/:id`）
- `scope` 必须是本模块 `permissions[].code` 里的码——声明一个自己都没有的码，该路径会恒 403
  而无人知晓，schema 直接拒绝这种写法
- 模块**不再写** `requireScope`：门禁由宿主按声明施加。漏写不会导致匿名可读——那条路已经堵死
  （模块手上甚至没有可挂的东西了）

> 同一个 `(method, path)` 只能声明一次，重复声明会被 schema 拒绝（否则门卫的判定出现二义）。

## 装载期双向核对（fail-fast）

装载器把 `router.routes` 与声明集合**双向比对**，任一方向不一致直接**装载失败**：

| 情形 | 结果 |
|---|---|
| 注册了路由但没声明 | **装载失败**（绝不半挂） |
| 声明了路径但没注册（幽灵声明） | **装载失败** |
| 声明了不属于本模块的 scope | schema 校验失败（`check-manifests` 门禁同时拦下） |
| 同 `(method,path)` 声明两次 | schema 校验失败 |

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

路径参数（`/notes/:id`）会被替换为占位段后再请求；`method === 'ALL'` 的中间件记录会被跳过。
