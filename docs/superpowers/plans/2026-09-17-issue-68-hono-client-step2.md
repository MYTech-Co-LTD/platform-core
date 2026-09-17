# issue #68 路① Step 2 提案：`testClient()` 塌成 `unknown`（102 条）

> 状态：**提案，未实施**。Step 1 已实施（194 → 140），见 commit `a79edfd`。
> 本文所有数字均为本机实测（`pnpm exec tsc --noEmit -p <临时 tsconfig>`，临时 tsconfig 只覆盖 `exclude: []`）。

---

## 0. 结论速览（先看这段）

1. **评估里「`Client<T>` 对 `.route()` 组装的 app 返回 `never`」只对了一半——与 `.route()` 无关。**
   真正的触发条件是：**app 的静态 Schema 是 `BlankSchema`（空表）**。
2. 成因是 **hono 的变异式装配**：`use` / `get` / `post` / `route` 在运行时都是 `return this`
   （原地改同一个对象），但 TS 的**类型只跟着链式表达式的返回值走**。写成
   ```ts
   const app = new Hono<E>()
   app.get('/ping', h)      // ← 返回值被丢掉了
   return app               // ← app 的静态类型恒为 Hono<E, BlankSchema, '/'>
   ```
   时，Schema 永远是空的，无论注册了多少路由。
3. hono 把「Schema 为空」翻译成了一个**静默的** `unknown`：
   `Client<T, Prefix>` 的嵌套条件类型判 `never`，而 `UnionToIntersection<never>` 推出 `unknown`
   （不是报错，是静默降级）。所以症状是 `'client' is of type 'unknown'`，不是「类型写错了」。
4. **修法只有一条**：让 Schema 在类型层真的被累加 ⇒ **两侧都必须改成链式**，
   任一侧单独改都无效（实测：只改测试侧 102 → 96；只改生产侧 102 → 102；两侧都改 102 → **0**）。
5. **这不是「把红改成绿」，但也不是零代价**：全绿之后**新暴露 4 条真错**
   （`auth.test.ts` 里响应体是「成功 | 失败」联合、测试没收窄就取字段）。详见 §4。

---

## 1. 最小复现（7 行，已实测）

```ts
// repro.ts
import { Hono } from 'hono'
import { testClient } from 'hono/testing'

const app = new Hono<{ Variables: { x: number } }>()
app.get('/ping', (c) => c.json({ ok: true }))

const client = testClient(app)
client.ping.$get          // error TS18046: 'client' is of type 'unknown'.
```

对照（把注册并进链式表达式即可，**7 行只差在写法**）：

```ts
const client = testClient(
  new Hono<{ Variables: { x: number } }>().get('/ping', (c) => c.json({ ok: true })),
)
client.ping.$get          // ✓ 类型完好：{ ping: ClientRequest<…> }
```

### 1.1 判据表（实测，逐条验过）

| 写法 | `testClient(app)` 的类型 |
|---|---|
| `testClient(new Hono<E>())`（无路由） | `unknown` |
| `const a = new Hono<E>(); a.get(...); testClient(a)` | `unknown` |
| `const a = new Hono<E>(); a.get(...); a.route(...); testClient(a)` | `unknown` |
| `const a = new Hono<E>().get(...); testClient(a)` | ✓ 正确 |
| `testClient(new Hono<E>().get(...).route(...))` | ✓ 正确 |
| `let a = …; a = a.get(...); return a`（**重新赋值也不行**） | `unknown` |

最后一行很重要：**`let` 重新赋值不会让 TS 累加类型**，所以「`const app` 改 `let app`、
每条语句改 `app = app.X(...)`」这种小改法是**无效**的（实测确认）。必须是真正的链式表达式。

---

## 2. 要改哪里

**评估说的「5 个文件改类型别名」做不到** —— 类型别名无法凭空造出 Schema，
Schema 只能从链式表达式的返回值里长出来。实际要改 **8 个文件**：4 个生产路由工厂 + 4 个测试文件。

### 2.1 生产侧（4 个文件，共 10 处路由注册）—— **必需**

这 4 个工厂本身就是变异式 + 显式返回注解，所以它们的 `SubSchema` 也是空的；
`.route(子路径, 子app)` 合并进来的是空表 ⇒ 上层照样塌成 `unknown`。

#### A. `apps/server/src/routes/auth.ts:120-252`

```ts
// 改前
export function authRoutes(deps: AuthRoutesDeps): Hono<TenantEnv & SessionEnv> {
  const app = new Hono<TenantEnv & SessionEnv>()

  app.post('/login', async (c) => { … })        // :123
  app.post('/logout', (c) => { … })             // :221
  app.get('/session', (c) => { … })             // :237

  return app                                     // :251
}

// 改后
export function authRoutes(deps: AuthRoutesDeps) {
  return new Hono<TenantEnv & SessionEnv>()
    .post('/login', async (c) => { … })
    .post('/logout', (c) => { … })
    .get('/session', (c) => { … })
}
```

#### B. `apps/server/src/routes/auth-wecom.ts:149-370`

```ts
// 改前
export function wecomRoutes(deps: WecomRoutesDeps): Hono<TenantEnv & SessionEnv> {
  const app = new Hono<TenantEnv & SessionEnv>()      // :150
  const callbackUri = trimSlash(deps.publicOrigin) + CALLBACK_PATH   // :151（保持在前）
  app.get('/qr', (c) => { … })        // :154
  app.get('/silent', (c) => { … })    // :179
  app.get('/callback', async (c) => { … })  // :199
  return app                          // :369
}

// 改后
export function wecomRoutes(deps: WecomRoutesDeps) {
  const callbackUri = trimSlash(deps.publicOrigin) + CALLBACK_PATH
  return new Hono<TenantEnv & SessionEnv>()
    .get('/qr', …)
    .get('/silent', …)
    .get('/callback', …)
}
```
> ⚠️ 注意 `:151` 的 `callbackUri` 是**闭包捕获的局部量**，必须在链式表达式之前算好；
> 它不能进链。同类「先算局部量、再注册路由」的写法在各工厂里都要照此处理
> （`platform.ts` 的 `listModules`/`enabledFor` 同理）。

#### C. `apps/server/src/routes/auth-wechat-oa.ts:98-201`

```ts
// 改前
export function wechatOaRoutes(deps: WechatOaRoutesDeps): Hono<TenantEnv & SessionEnv> {
  const app = new Hono<TenantEnv & SessionEnv>()       // :99
  const callbackUri = trimSlash(deps.publicOrigin) + CALLBACK_PATH  // :100
  app.get('/silent', (c) => { … })            // :103
  app.get('/callback', async (c) => { … })    // :120
  return app                                   // :200
}

// 改后
export function wechatOaRoutes(deps: WechatOaRoutesDeps) {
  const callbackUri = trimSlash(deps.publicOrigin) + CALLBACK_PATH
  return new Hono<TenantEnv & SessionEnv>()
    .get('/silent', …)
    .get('/callback', …)
}
```

#### D. `apps/server/src/routes/platform.ts:37-76`

```ts
// 改前
export function platformRoutes(deps: PlatformRoutesDeps): Hono<TenantEnv> {
  const listModules = deps.modules ?? (() => [])                    // :38
  const enabledFor = deps.enabledFor ?? (async () => new Set<string>())  // :39
  const app = new Hono<TenantEnv>()                                  // :41
  app.get('/branding', (c) => { … })        // :43
  app.get('/config', async (c) => { … })    // :65
  return app                                 // :75
}

// 改后
export function platformRoutes(deps: PlatformRoutesDeps) {
  const listModules = deps.modules ?? (() => [])
  const enabledFor = deps.enabledFor ?? (async () => new Set<string>())
  return new Hono<TenantEnv>()
    .get('/branding', …)
    .get('/config', …)
}
```

#### 为什么这里删得掉返回类型注解

删注解**不是**为了省事，而是**必需**：`): Hono<TenantEnv & SessionEnv>` 就是
`Hono<E, BlankSchema, '/'>`，注解会把刚长出来的 Schema 再擦一次。

代价与把关：删掉后返回类型变成推导值（Env 会是 `IntersectNonAnyTypes<[...]>`）。
**门禁不在注解上，在消费方**：`app.ts` 用 `.route()` 挂这些工厂，
Env 不对会立刻在 `buildApp` 处报错；`Hono` 的 `get/post/...` 签名本身也钉死了
handler 的 `c.get('tenant')` 等访问。所以这不是「失去检查」，是「检查换了地方」。

> 若评审坚持保留注解，替代写法是显式写出带 Schema 的返回类型，但那要求手抄一遍全部
> 路由签名 —— 等于把 Schema 变成手工维护的副本，**那才是把红改绿**。

### 2.2 测试侧（4 个文件）

这 4 个文件的 `makeApp` 也是变异式 + 注解，同样要链式化。

#### E. `apps/server/src/routes/auth.test.ts:55, 57-72`

```ts
// 改前
type AppClient = ReturnType<typeof testClient<ReturnType<typeof makeApp>>>   // :55

function makeApp(
  pool: Pool, casdoor: CasdoorFactory = casdoorFor,
  limiter: LoginLimiter = createLoginLimiter(),
  degradeWarnIntervalMs?: number, now?: () => number,
): Hono<TenantEnv & SessionEnv> {                      // :63
  const app = new Hono<TenantEnv & SessionEnv>()       // :64
  app.use('*', resolveTenantMiddleware({ … }))         // :65
  app.use('*', sessionMiddleware({ … }))               // :66
  app.route('/api/platform/auth', authRoutes({ … }))   // :67
  return app                                            // :71
}

// 改后（:55 的 AppClient 不用动 —— 它从 makeApp 推导）
function makeApp(
  pool: Pool, casdoor: CasdoorFactory = casdoorFor,
  limiter: LoginLimiter = createLoginLimiter(),
  degradeWarnIntervalMs?: number, now?: () => number,
) {
  return new Hono<TenantEnv & SessionEnv>()
    .use('*', resolveTenantMiddleware({ … }))
    .use('*', sessionMiddleware({ … }))
    .route('/api/platform/auth', authRoutes({ … }))
}
```

`AppClient`（`:55`）**保持原样**——这是关键：它仍然是从 app 的**真实装配**推导出来的，
所以以后加/删路由，`client.xxx` 会跟着变。如果改成手写别名，就退化成 §4 说的那种假绿。

#### F. `apps/server/src/routes/auth-wecom.test.ts:91, 93-117, 123-146`

同 E，两个工厂都要链式化：
- `makeApp`（`:93-117`）：`.use().use().route()`，`return app` 删。
- `makeAppBothDoors`（`:123-146`）：`.use().use().route().route()`（两扇门各一个 `.route`）。
- `type AppClient`（`:91`）不动。

#### G. `apps/server/src/routes/auth-wechat-oa.test.ts:64, 77-97`

同 E：`makeApp`（`:77-97`）链式化为 `.use().use().route()`；`type AppClient`（`:64`）不动。

#### H. `apps/server/src/tenant.test.ts:22-29, 44-53`

这个文件结构略不同（`makeBareApp` 造空 app，`makeApp` 再变异 + `testClient`）：

```ts
// 改前
type AppClient = ReturnType<typeof testClient<ReturnType<typeof makeBareApp>>>  // :23-25
function makeBareApp() { return new Hono<TenantEnv>() }                          // :27-29
…
  function makeApp(mode, platformOrg = '', deps?): AppClient {   // :44-48
    const app = makeBareApp()                                    // :49
    app.use('*', resolveTenantMiddleware({ pool, mode, platformOrg }))  // :50
    app.route('/api/platform', platformRoutes(deps ?? { pool }))        // :51
    return testClient(app)                                              // :52
  }

// 改后
  function makeApp(mode: 'multi' | 'single', platformOrg = '', deps?: PlatformRoutesDeps) {
    return testClient(
      new Hono<TenantEnv>()
        .use('*', resolveTenantMiddleware({ pool, mode, platformOrg }))
        .route('/api/platform', platformRoutes(deps ?? { pool })),
    )
  }
```
`makeBareApp` 与 `type AppClient`（`:22-29`）随之删除——它们存在的唯一理由就是给
`testClient` 喂一个**没有 Schema 的** app。**注意 `AppClient` 在别处若还有引用要一并改**
（本文件另用作 `:48` 的注解，链式化后由推导接管）。

---

## 3. 实测收益

| | Step 1 后 | Step 2 后（本提案，已实测） |
|---|---|---|
| apps/server | 116 | **18** |
| ├ TS18046（本次目标） | 102 | **0** |
| ├ TS2345（hono Env 方差，另一码事） | 13 | 13 |
| └ TS2339 | 1 | 5（1 旧 + **4 新暴露**，见 §4） |
| packages/auth-core | 13 | 13 |
| modules/aftersales | 11 | 11 |
| modules/demo | 0 | 0 |
| **仓库合计** | **140** | **42** |

两侧都要改的证据（分批实测）：

| 改动 | TS18046 |
|---|---|
| 都不改（Step 1 后基线） | 102 |
| 只改测试侧（E–H） | 96 |
| 只改生产侧（A–D） | 102 |
| **两侧都改** | **0** |

---

## 4. 为什么这不是「把红改成绿」

### 4.1 说清 workaround 之后**仍然受检**的是什么

链式化**没有削弱任何检查**，理由有三条，都可验：

1. **运行时零变化**。hono 的 `use` / `route` / `get` / `post` 源码都是 `return this`
   （`hono/dist/hono-base.js`：`this.use = (arg1, ...handlers) => { …; return this }`，
   `route(path, app) { …; return this }`）。链式写法与原写法**改的是同一个对象**，
   注册顺序、返回值、错误传播都不变。本提案是**纯类型层改动**，不是行为改动。
2. **`AppClient` 仍是推导出来的**（`ReturnType<typeof testClient<ReturnType<typeof makeApp>>>`
   一字未动）。它跟着 app 的真实装配走：以后 `makeApp` 少挂一条 `.route`，
   `client.xxx` 立刻变 `unknown` 或报错。**假绿的典型特征（手工维护一份路由清单）在本提案里不存在。**
3. **修完之后模型更严**，严到立刻抓出原来抓不到的东西 —— 见下。

### 4.2 被**绕过**的是什么：没有绕过。被**暴露**的是什么：4 条真错

这是本次提案最重要的诚实部分：`unknown` 消失后，`auth.test.ts` **新报 4 条 TS2339**：

```
auth.test.ts(165,13): error TS2339: Property 'csrfToken' does not exist on type
  '{ error: string } | { user: { id; name; displayName }; org; scopes; csrfToken }'
auth.test.ts(209,31): error TS2339: Property 'scopes' does not exist on type (同上)
auth.test.ts(272,33): error TS2339: Property 'scopes' does not exist on type (同上)
auth.test.ts(491,33): error TS2339: Property 'scopes' does not exist on type (同上)
```

含义：`/login` 的响应体类型是「失败 `{error}` | 成功 `{user,org,scopes,csrfToken}`」的**联合**，
测试在 `expect(res.status).toBe(200)` 之后直接取 `body.csrfToken` —— 运行时没问题
（状态码已经保证了分支），但**类型层没有收窄**。

**这 4 条恰恰是 `unknown` 一直在掩盖的东西。** 换句话说：
`unknown` 不是「暂时缺类型」，它是**一块盖住整个客户端的幕布**——
102 条红是幕布本身的形状，幕布一掀，底下藏着的东西才第一次可见。

按本仓对「用容错掩盖失败」的态度（`rules/common/deploy-verify.md` §3）：
这 4 条**必须如实计入 Step 2 的成本**，不能算成「顺手修掉的噪声」。
修法很轻（断言状态码后收窄类型，或改用一次 `expect(res.status).toBe(200)` +
类型守卫），但它是**新增工作量**，不是本提案的赠品。

> 附：`app.test.ts(239) closeAllConnections` 那 1 条 TS2339 与本提案无关
> （`ServerType` 联合上没有该方法，Step 1 前就在），不要混进这笔账。

---

## 5. 替代方案与代价

| 方案 | 做法 | 代价 / 判断 |
|---|---|---|
| **A. 本提案：两侧链式化**（推荐） | 改 4 生产 + 4 测试文件，纯类型层 | 运行时零风险；一次性能把 102 归零；**代价是新暴露 4 条真错要一并修**。生产侧删返回注解是必要动作，检查转移到 `app.ts` 的 `.route()` 消费点 |
| **B. 等上游修** | 向 hono 提 issue，让 `Client<T>` 对空 Schema 报错而非静默 `unknown` | 值得提（静默 `unknown` 是上游的粗糙面），但**不解决本仓问题**：即使上游改成报错，本仓的 app 依然是空 Schema，红的还是红的。**不能作为路线** |
| **C. 升级 hono** | 换到修复了该行为的版本 | 需先确认上游是否认为这是 bug；即便是，本仓的装配写法仍要改（Schema 靠链式累加是 hono 的**设计**，不是 bug）。升级还会引入 `hono/testing` 之外的连带风险，性价比最低 |
| **D. 换断言方式** | 不用 `testClient`，改回 `app.request(path, init)` + 手写 `Response` 断言 | 能绕开类型塌陷，但**丢掉了整条客户端类型链**：URL/方法/请求体/响应体的形状全靠手写，正是 §4.2 那种「幕布」换了个地方盖。且 4 个文件几十处调用全要重写，比 A 大得多 |
| **E. 手工给 `AppClient` 写一份类型** | 用类型别名/interface 手抄端点清单 | **这就是「把红改成绿」**：清单与真实路由无机械关联，路由改了别名不动，门禁全绿而缺陷不可见。**明确否掉** |
| **F. 测试里 `.route()` 换成链式 `.get()` 逐个注册** | 不碰生产代码，测试自建等价 app | 测的就不再是生产装配链（`.route` 前缀拼接、中间件顺序都不测了），替身比真机宽松 —— 违反 AGENTS.md 硬约束 #11。**明确否掉** |

---

## 6. 建议的落地顺序（若拍板走 A）

1. **先做生产侧 A–D**，单独一次提交，跑 `pnpm test` 全量 + `pnpm typecheck`（此时测试文件仍被
   `exclude` 挡住，所以**看不出变化**——这正是「Step 3 原子切换」要解决的问题，顺序上不冲突）。
2. **再做测试侧 E–H**，跑 `pnpm test`（apps/server 的用例需 `DATABASE_URL`）。
3. **在同一次提交里修那 4 条新暴露的 TS2339**（§4.2），不要留红。
4. 用临时 tsconfig 度量，确认 `TS18046: 0`、`apps/server: 18`。
5. 之后再走 Step 3：把 `exclude` 去掉（原子切换），此时仓库剩 **42 条**（见 §3 表），
   Step 3 的「清零 or 设基线」是另一个决策。

---

## 附：本次实测用过的命令

```sh
# 度量（temp tsconfig 只覆盖 exclude: []，用完即删）
printf '{\n  "extends": "./tsconfig.json",\n  "exclude": []\n}\n' > <pkg>/tsconfig.tmp-measure.json
pnpm exec tsc --noEmit -p <pkg>/tsconfig.tmp-measure.json

# 主工程不受影响
pnpm typecheck
pnpm --filter @platform/auth-core test
pnpm --filter demo test
pnpm --filter @platform/server exec vitest run src/routes/admin.test.ts
pnpm run test:guard
```
