# 设计：登录端点限速 + 审计保留 + 模块 scope「声明即授权」（M1 闭债 R2）

> 来源：GitHub issue #3「M1 立项：平台底座 M0 终审遗留债」第四节前两条。
> 状态：设计已获批（2026-09-11），待写实现计划。
> 轮次名：R2。两条互相独立，**一份 spec、两条并行支线**（详见 §6）。
> R1（multi 权限供给）已随 PR #4 合入 `main`。

## 0. 一句话

**限速**：登录端点今天既不限速、又每失败一次就往 `platform.audit` 写一行 ⇒ 外部可无限度灌表；
**收口**：`manifest.api.internal[]` 是个**零消费者、零文档、连 path 都没有**的死字段，模块路由
全凭开发者手写 `requireScope`，**忘挂即匿名可读**——把「靠人记得」变成「结构上不可能」。

## 1. 现状取证

### 1.1 写 audit 的门有两扇，只堵一扇等于没堵

| 入口 | 位置 | 何时写 audit |
|---|---|---|
| 账密 | `apps/server/src/routes/auth.ts:54` | 超长凭据 `:69`（**不调 Casdoor 就写**）、坏凭据 `:88`、成功 `:110` |
| 企微 SSO | `apps/server/src/routes/auth-wecom.ts:186` | `no-account` `:252`、成功 `:264` |

`:69` 那条尤其要紧：**不触发任何上游调用就能写一行**，是成本最低的灌表路径。
两条路由各自持有一份同款 `writeAudit`（`auth.ts:38`、`auth-wecom.ts:63`）——限速必须**同时覆盖两扇门**。

### 1.2 audit 表：无索引、无保留策略

`apps/server/src/migrations/001_platform.sql:34-41` 只有主键 `id bigserial`，`at` 无索引；
全仓没有任何清理逻辑（`grep -rn 'delete from platform.audit'` 零命中）。
⇒ 表**单调增长**，且增长速率完全由攻击者决定。**限速只降低速率，不改变"无界"这件事**，
故保留策略必须与限速同时做（issue 原文即「无限速，**且**每次失败写一行」）。

### 1.3 `manifest.api.internal[]` 是死字段

- 声明：`packages/platform-sdk/src/manifest.ts:10`（接口）、`:33`（zod schema）——形状 `{ name, scope }`
- **消费者：零**。全仓 `grep -rn 'api\.internal'` 只命中上面两行定义处
- **文档：零**。全仓 md / yaml 里没有任何一处描述它（M0 那份定义它的计划文档不在本仓历史里）
- **`modules/demo/manifest.yaml` 根本没写 `api:` 段**，`modules/demo/index.ts:32,37,44` 三条路由
  各自手写 `requireScope('demo:view' / 'demo:note')`
- 且该形状**没有 path 也没有 method** ⇒ 即便想消费它，也无法机械地把它映射到任何一条路由上

⇒ 这不是「给一个已定义字段补消费者」，而是「这份协议从没定过语义」。

### 1.4 漏挂 = 匿名可读（fail-open by omission）

`packages/platform-sdk/src/module.ts:60-71` 的 `requireScope` 是**模块自己**在每条路由上手挂的中间件。
模块作者漏写一次，该路由就**完全无鉴权**——不报错、不告警、CI 不红。
`apps/server/src/loader.ts:187-190` 的 mount 只做 `app.route('/api/modules/' + id, router)`，不施加任何门禁。

今天没有实际暴露（demo 三条都挂了），**风险在协议本身**：`scaffolds/` 尚不存在，全仓只有 demo 一个模块，
现在改协议是**成本最低的窗口**。

### 1.5 客户端真实 IP 拿不到（真机取证）

上了生产机（`f993b5c7`，跑 woke / salary-calculation 那台）翻遍 openresty 配置树：
`grep -rn 'proxy_set_header' /etc/openship /usr/local/openresty/nginx/conf` 全树**只有一处**
`proxy_set_header Host $host;`（`sites-enabled/_default.conf:10`），**没有任何 `X-Forwarded-For` / `X-Real-IP`**。

⇒ 应用侧看到的客户端地址恒为 edge 的回环地址。**按 IP 限速在此拓扑下会退化成"全局限速"——
一个攻击者即可锁死该租户全体用户**，比不做更糟。故本设计**不引入 IP 维度**（§2 非目标）。
（取证范围限于该台机器；若后续确认 edge 转发真实 IP，可作为独立一轮追加维度。）

### 1.6 Hono 机制实证（决定 §3.5 的可行性，hono 4.13.7）

三条都是在本仓实跑得到的结论，不是推断：

| 探针 | 结果 | 含义 |
|---|---|---|
| `app.use('*', mw)` 内读 `c.req.routePath` | 恒为 `/*` | **拿不到下游 handler 的路径** ⇒「单点通配门卫查表」不可行 |
| `app.use('/notes/:id', mw)` 内读 `c.req.routePath` | `/notes/:id` | 按路径挂载的门卫**能**拿到模式 ⇒ 逐路径施加可行 |
| `router.routes`（含 `mod.route('/api', sub)` 的子路由） | `GET /api/notes/:id` 等**全路径** | 装载期双向核对可行；中间件记为 `ALL /*`，需过滤 |

## 2. 目标与非目标

### 目标

1. 登录端点（**两扇门**）有速率限制，且**限速判定先于 audit 写入**——被拦的请求不产生 audit 行。
2. 限速器自身**不发散**：内存占用有界（不重蹈「无界增长」）。
3. `platform.audit` 有**保留策略**与配套索引，「无界增长」这件事本体被治掉。
4. 模块 API 的鉴权从「开发者记得挂」变为**结构上不可能漏**：manifest 声明即唯一事实源，
   宿主施加，**未声明 = 不可达**；声明与代码不一致时**装载期 fail-fast**。
5. 上条有**行为回归网**：匿名探测（对每条已装载路由断言 401），不是靠读代码相信。

### 非目标（本轮不做）

- **按客户端 IP 限速**（§1.5 取证：当前拓扑下有害）
- edge / Cloudflare 层限速（openship `routingConfig.proxy` 无此能力，属平台侧能力，另立）
- 限速计数落库 / 多副本一致的集中式计数（§5 取舍；当前拓扑单容器）
- `platform.audit` 分区表（YAGNI，量级不到）
- 企微路的**按用户名**维度（§3.2 口径落差，换票前拿不到用户名）
- issue 第三节（真机验证 `sso.hookflow.cn`）、第四节其余条目（branding 语义、`/healthz` vs `/readyz`、
  `getPermissions` 翻页）、第五节工程 Minor
- 撤销「`TENANT_MODE=multi` 按非生产可用对待」那句警告（仍等一次真实 multi 生产演练）

## 3. 设计

### 3.1 限速器（`apps/server/src/rate-limit.ts`，新增）

**口径**：三层，全部**租户内**（不依赖 IP），计数在**进程内存**：

| # | 维度 | 阈值（默认） | 挡什么 |
|---|---|---|---|
| 1 | `(tenant, username)` **失败**数 | 5 / 15 分钟 | 单账号爆破 |
| 2 | `(tenant)` **失败**总数 | 300 / 分钟 | **换用户名喷洒灌表**——真正救 audit 的那道 |
| 3 | `(tenant)` **全部尝试**数 | 1000 / 分钟 | 有效凭据滥用成功路径 + 兜底 |

- **成功即清零**该 `(tenant, username)` 的失败桶：否则正常用户会被自己的成功登录耗尽配额
- `username === null` 时**跳过第 1 层**（企微回调，见 §3.2），只判第 2/3 层
- 阈值是**模块内常量**（单一事实源），**不做成 env**：每加一个 env 键要同步 `.env.example` +
  `config.ts` + runbook 三处（`check-env-example` 守卫盯着键全集），而眼下没有任何运维方要求可调。
  将来真需要再提升为配置，届时是纯机械改动。
- 接口（`now` 可注入，测试不碰真时钟）：

```ts
export interface LimitDecision { allowed: boolean; retryAfterSec?: number; dimension?: 1 | 2 | 3 }
export interface LoginLimiter {
  /** 只读判定，不改状态（先查后记，见下） */
  check(tenantId: number, username: string | null): LimitDecision
  /** 判定之后按真实结果落账：ok ⇒ 清该用户失败桶；!ok ⇒ 失败桶 +1。两者都计入"全部尝试" */
  record(tenantId: number, username: string | null, ok: boolean): void
}
export function createLoginLimiter(opts?: { now?: () => number }): LoginLimiter
```

- **先查后记**（check 在调用 Casdoor 之前，record 在拿到结果之后）。两段之间有 await，并发下会
  轻微超额放行——这是限速器的常规精度取舍，**明确接受并写进注释**，不假装它是精确的。
- **被拒的请求不 record**：攻击者被拦后不延长自己窗口；且这是"限速挡在 audit 之前"的实现形态。

**内存有界（必须，否则限速器自己变成新的无界增长点）**：

- 每用户名失败桶**只在 `record(…, ok=false)` 时创建** ⇒ 造桶速率被第 2 层（300 失败/分钟）压住，
  15 分钟窗口内每租户最多约 4500 个，过期即惰性清走
- 另设硬上限（8192/租户）作兜底：超限时**淘汰最久未更新的桶**并 `console.warn`
- 诚实记下残余弱点：攻击者理论上可用新用户名刷掉受害者桶（使其失败计数归零）；但产生桶必须先
  **造成失败**，而失败速率已被第 2 层限死，此时攻击者自己的请求也已被拒——**净收益为零**

### 3.2 接入点与口径落差

| 路由 | 第 1 层（用户名） | 第 2/3 层（租户） |
|---|---|---|
| `POST /api/platform/auth/login` | ✅ `body.username` | ✅ |
| `GET /api/platform/auth/wecom/callback` | ❌ **拿不到** | ✅ |

**已知落差**：企微回调在 `code` 换票成功前没有用户名，「单账号爆破」维度对它不可用；但灌表威胁
由第 2/3 层（租户总量）覆盖——攻击者没有有效 `code`，每次都会产生失败。`/wecom/qr`、`/wecom/silent`
不写 audit（`:148`、`:166` 无 audit 调用），**本轮不加限速**。

**位置**：在 `writeAudit` 之前判定；被拦时**直接返回 429，不写 audit、不调 Casdoor**。

**超长凭据路径**（`routes/auth.ts:66-77`，不调 Casdoor 就写一行 audit）同样先 `check`、
按**失败**`record`——它正是最廉价的灌表路径（§1.1），不能因为"走不到 Casdoor"就绕过限速。

### 3.3 429 形状与可观测性

- 响应体 `{ error: 'TOO_MANY_REQUESTS' }` + 头 `Retry-After: <秒>`
- **不写 audit 行**（写了等于没限速）；改 `console.warn` 一行结构化日志（含 tenantId / 维度 /
  被拦的 username 前缀），经容器日志进 OpenObserve —— 攻击可见，但不落库
- 复用既有错误体形状约定（`{ error: string }`），前端 `platformFetch` 无需改

### 3.4 audit 保留（迁移 `002`）

`apps/server/src/migrations/002_audit_retention.sql`：

```sql
create index if not exists audit_at_idx on platform.audit(at);
create or replace function platform.prune_audit(keep_days int default 90) returns bigint ...
```

- 索引只为 prune 的 `where at < now() - interval` 服务（一条即可，不预先造用不上的复合索引）
- `prune_audit` 返回删除行数，便于 job 日志核对
- **由 openship job 定时调用**（每日一次，默认保留 90 天），runbook 补一节；
  应用进程**不**自己跑清理——清理是有副作用的运维动作，不该藏在一个 HTTP 服务里
- 迁移沿用既有装载器约定（`platform` 为一个"模块"，版本 = 文件名）

### 3.5 声明即授权（协议破坏性变更）

**schema**（`packages/platform-sdk/src/manifest.ts:33`）：

```ts
api: z.object({
  internal: z.array(z.object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    path: z.string().startsWith('/'),
    scope: z.string(),
  })).optional(),
}).optional(),
```

- `name` 字段**删除**（它无定义、无消费者；`path` 才是能被机械消费的身份）
- `superRefine` 增一条：**`scope` 必须 ∈ 本模块 `permissions[].code`**。
  否则模块声明一个自己都没有的码 ⇒ 该路径**恒 403 而无人知晓**——这是同一个 failure mode 的新变种。
  该约束由 schema 承载，故**运行时装载与 `check-manifests` 门禁同时覆盖**，无需在 `checks.ts` 另写一遍。
- **不留兼容**：该字段零消费者零文档，全仓仅 demo 一个模块 —— 现在是最便宜的窗口（§1.3、§1.4）

**宿主施加**（`apps/server/src/loader.ts`）：

1. `createRouter()` 之后、mount 之前，按声明中每个 **distinct path** 挂一个门卫：
   `router.use(path, gate)`（§1.6 已证 `use('*')` 不可行、逐路径可行）
2. gate 逻辑：无 `identity` → `401 {error:'UNAUTHENTICATED'}`；`(method,path)` 未声明 →
   `403 {error:'FORBIDDEN'}`（fail-closed）；声明了但 `hasScope` 为假 →
   `403 {error:'FORBIDDEN', need:<code>}` —— 三种错误体与既有 `requireScope` **逐字一致**，
   模块与前端无需感知差异
   **一处刻意的行为变化**：某路径已声明（如 `GET /notes`）而请求用了未声明的 method
   （`POST /notes`）时，**返回 403 而非 404**——门卫按路径先于路由匹配执行，判定 `(POST,/notes)`
   未声明即 fail-closed。这是有意的：不做方法枚举泄露，且与"未声明 = 不可达"同一条规则。
3. **双向核对**：过滤掉 `router.routes` 里的 `ALL` 条目后，与声明集合**双向比对**：
   有路由未声明 ⇒ 装载失败；声明了不存在的 (method,path) ⇒ 装载失败。
   错误信息同时列出两侧差集。⇒ 声明与代码的漂移**不可能悄悄存在**（与「装载器必填」同风格）
4. 模块**不再手写 `requireScope`**：`modules/demo/index.ts` 三条路由的调用删除。
   导出**保留**（模块内部子路由仍可用，且不制造无谓的破坏面）

**行为回归网（匿名探测）**：`packages/platform-sdk` 加 test-util——对 router 的每条已注册路由
发**无 identity** 的请求，断言 `401 UNAUTHENTICATED`。落两处：模块自己的单测、`smoke-load.mjs`。
它测的是「门卫真的生效」这件事本身，而非「代码里写了 requireScope」——与 R1 的教训一致
（**断言必须真跑**）。

**文档**：新增 `docs/module-protocol.md`，把 `api.internal[]` 的语义、双向核对规则、
「没声明 = 不可达」写全。**这个字段当年正是死于零文档**，不补文档等于给复发留门。

### 3.6 失败语义

| 情形 | 行为 |
|---|---|
| `(method,path)` 未声明但模块注册了 | **装载失败**（宿主启动 fail-fast） |
| 声明了模块未注册的 `(method,path)` | **装载失败** |
| 声明 `scope` ∉ 本模块 `permissions[].code` | schema 校验失败 ⇒ `check-manifests` 红 + 装载红 |
| 匿名访问任意模块路由 | 401（门卫生效），由匿名探测回归网守住 |
| 限速命中 | 429 + `Retry-After`；**不写 audit**；`console.warn` 一行 |
| Casdoor 传输层故障 | 502（**不变**）；**不计入失败桶**——非用户过错，与既有语义一致 |
| `platform.audit` 写不进去 | 500（**不变**：审计先行，写不进就不发会话） |

## 4. 验收判据

### 4.1 单元测试

- `rate-limit.test.ts`（新）：三层各自触发 429 / 成功清零失败桶 / 窗口过期复位 /
  桶数上限淘汰 / **被拒请求不 record**（注入时钟，不碰真时间）
- `routes/auth.test.ts`：连续失败达阈值 ⇒ 第 N+1 次 **429 且未写 audit**（mock pool 断言 insert 次数）
- `routes/auth-wecom.test.ts`：同款租户层断言（无用户名维度）
- `manifest.test.ts`：`method`/`path` 形状校验；**scope 不属于本模块 ⇒ 校验失败**（负例）
- `loader.test.ts`：**双向核对两个方向各一条负例**（未声明路由 / 幽灵声明）⇒ 装载抛错
- `smoke`/模块单测：匿名探测对每条路由断言 401

### 4.2 集成（冒烟）

- 账密连续失败至阈值 ⇒ 429，且**此后不再产生新的 audit 行**（可查 `platform.audit` 行数）
- 企微回调同款租户层断言
- 匿名请求模块路由 ⇒ 401；**带合法会话但无 scope ⇒ 403**（与 R1 的 beta-403 断言同形）

### 4.3 门禁

`pnpm test`（PG 真跑、非 skip）、`pnpm typecheck`、`pnpm smoke`、四个守卫脚本全绿
（守卫须经 `pnpm exec tsx` —— 直接 `node scripts/*.mjs` 会因 extensionless import 报
`ERR_MODULE_NOT_FOUND`，R1 计划文档里那句 `node` 是错的）。

### 4.4 判据的元要求（**先红后绿**）

1. **限速**：先写「第 N+1 次为 429」断言并跑红，再实现。
2. **双向核对**：先写两条负例跑红（此刻装载器根本不核对），再实现。
3. **声明即授权**：**变异检验**——临时从 demo manifest 删掉一条声明，跑冒烟/装载，
   **必须红且红在双向核对上**；还原后复绿。把红的那一行原文记进任务报告。
   （这是 R1 Task 3 Step 8 的同款手法：一条「改完才第一次运行」的断言，
   等于没有验证过它测的是不是那个故障。）

## 5. 风险与取舍

| 风险 | 处置 |
|---|---|
| 内存计数在多副本部署下失效；重启清零 | 当前 compose 单实例（已确认）；**限制写进代码注释与 runbook**；水平扩容时换集中式计数（独立一轮） |
| 被拒请求不 record ⇒ 无 audit 证据留存 | 攻击可见性由 `console.warn` → OpenObserve 承担；刻意不落库（否则灌表威胁原样存在） |
| check-then-record 并发下轻微超额放行 | 已接受；注释写明，不假装精确 |
| 桶淘汰可被刷掉受害者计数 | 产生桶必须先造成失败，速率已被第 2 层限死，攻击者净收益为零（§3.1 已论证） |
| 阈值拍得不准（误伤早高峰 / 挡不住慢速爆破） | 三层里第 1 层管慢速爆破（5/15min），第 2/3 层管灌表；常量集中在一处，调整成本低 |
| `api.internal` 形状破坏性变更 | 无消费者、无文档、仅 1 个模块（§1.3）——现在改最便宜；CHANGELOG 标**破坏项** |
| 逐路径挂载门卫的中间件顺序 | §1.6 已实证；装载期双向核对会在顺序错误导致的行为异常时**于装载期暴露**，而非线上 |
| 企微路缺用户名维度 | 已知落差（§3.2），灌表威胁由租户层覆盖 |
| 阈值/保留期改动 | 阈值是常量、保留期是 `prune_audit(keep_days)` 实参——都不需要改代码结构 |

## 6. 变更面清单与任务切分

**任务切分（4 任务 / 2 波）**：同波文件触碰面不重叠；`CHANGELOG` 统一归 T4，避免两个 worker 争同一文件。

| 波 | 任务 | 触碰面 |
|---|---|---|
| 1 | T1 限速器 + 两扇门接入 + audit 保留 | `apps/server/src/rate-limit.ts`(新)、`rate-limit.test.ts`(新)、`routes/auth.ts`、`routes/auth-wecom.ts`、`routes/*.test.ts`、`migrations/002_audit_retention.sql`(新) |
| 1 | T2 声明即授权 + 双向核对 + 匿名探测 + demo 同步 | `packages/platform-sdk/src/manifest.ts`、`module.ts`、`checks.ts`、`test-util/`(新)、`*.test.ts`、`apps/server/src/loader.ts`、`loader.test.ts`、`modules/demo/manifest.yaml`、`modules/demo/index.ts` |
| 2 | T3 冒烟加固（429 + audit 不增 + 匿名探测） | `scripts/smoke-load.mjs` |
| 2 | T4 文档 + CHANGELOG（含**破坏项**）+ 门禁复跑 | `docs/module-protocol.md`(新)、`deploy/openship-adopt.md`、`CHANGELOG.md` |

| 文件 | 变更 |
|---|---|
| `apps/server/src/rate-limit.ts` | 新增：三层限速器（内存、有界、clock 可注入） |
| `apps/server/src/routes/auth.ts` | 登录前置 `check`、结果后置 `record`；429 分支 |
| `apps/server/src/routes/auth-wecom.ts` | 回调同款（仅租户层） |
| `apps/server/src/migrations/002_audit_retention.sql` | 新增：`at` 索引 + `platform.prune_audit` |
| `packages/platform-sdk/src/manifest.ts` | `api.internal[]` 形状改 `{method,path,scope}`；scope ∈ permissions |
| `packages/platform-sdk/src/module.ts` | 门卫中间件（复用 `requireScope` 错误体）；导出保留 |
| `packages/platform-sdk/src/test-util/` | 新增：匿名探测 |
| `apps/server/src/loader.ts` | 逐路径施加门卫 + 装载期双向核对 |
| `modules/demo/manifest.yaml` / `index.ts` | 补三条声明；删掉手写 `requireScope` |
| `scripts/smoke-load.mjs` | 429 断言、audit 行数不增断言、匿名探测 |
| `docs/module-protocol.md` | 新增：字段语义 +「没声明 = 不可达」 |
| `deploy/openship-adopt.md` | 新增：audit 清理 job 一节 |
| `CHANGELOG.md` | 【新增】限速 /【修复】审计无界 /【破坏】`api.internal` 形状 |
