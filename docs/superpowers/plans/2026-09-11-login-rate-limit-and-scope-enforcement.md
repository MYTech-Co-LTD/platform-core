# 登录限速 + audit 保留 + 模块 scope「声明即授权」（M1 闭债 R2）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让登录端点（账密 + 企微两扇门）有速率限制且限速判定先于 audit 写入，给 `platform.audit` 补上保留策略；把模块 API 的鉴权从「开发者记得挂 `requireScope`」改成「manifest 声明即授权，未声明 = 不可达，声明与代码不一致则装载失败」。

**Architecture:** 限速器是一个**进程内存**的三层计数器（租户内，不依赖客户端 IP——见 Global Constraints），在两条登录路由的 `writeAudit` 之前判定、按结果落账；被拦请求不写 audit。scope 侧把 `manifest.api.internal[]` 从死字段 `{name,scope}` 改为可机械消费的 `{method,path,scope}`，由装载器**在模块 router 外层包一层**逐路径门卫（顺序关键，见下），并在装载期对 `router.routes` 做**双向核对**，任何不一致直接装载失败。

**Tech Stack:** TypeScript / Hono 4.13 / PostgreSQL(pg) / zod / vitest / tsx；PG 真跑（非 skip）

**设计依据:** `docs/superpowers/specs/2026-09-11-login-rate-limit-and-scope-enforcement-design.md`（issue #3 第四节前两条）

## Global Constraints

- Node `>=22`；包管理器 `pnpm@11.22.0`（`package.json` 的 `packageManager`，**不要在别处写第二份版本号**）
- 本地 PG：`docker compose -f deploy/docker-compose.yml up -d postgres`
  → `DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform`（宿主视角）
- **守卫脚本必须经 `tsx` 跑**：`pnpm exec tsx scripts/<x>.mjs`。直接 `node scripts/<x>.mjs` 会因
  `checks.ts` 的 extensionless import 报 `ERR_MODULE_NOT_FOUND`（R1 计划文档里那句 `node` 是错的）
- 冒烟前置：**必须先构建 web**（`pnpm --filter @platform/web build`），否则静态托管断言无从谈起
- **不引入客户端 IP 维度**（真机取证：openship edge 不转发 `X-Forwarded-For`，生产机 openresty
  全树只有 `proxy_set_header Host $host`；按 IP 限速会退化成全局限速，一个攻击者锁死整个租户）
- **限速计数用进程内存**，不做成 env（每加一个 env 键要同步 `.env.example` + `config.ts` +
  runbook 三处，而 `check-env-example` 守卫盯着键全集）；阈值是模块内常量
- 提交纪律（`docs/standards/dev-discipline.md`）：可见变更必须在 `CHANGELOG.md` 行内标
  **【新增】/【优化】/【修复】**（本轮的 schema 变更另标 **【破坏】**）；改动走 PR，不直推 `main`
- 四个守卫脚本对本仓真跑：`check-manifests` / `lint-architecture` / `check-compose` / `check-env-example`
- **每个任务的新断言必须先在改动前跑红**（spec §4.4）：一条「修完才第一次运行」的断言，
  等于没有验证过它测的是不是那个故障

---

### ⚠️ 落实现前必读：三条已实证的 Hono 机制（省你一次返工）

都已在 hono 4.13.7 上实跑验证过，不是推断：

1. **`use('*', mw)` 里 `c.req.routePath` 恒为 `/*`** ⇒ 「一个通配门卫查表」拿不到下游 handler 的
   路径，**不可行**。
2. **handler 先注册、`use` 后注册 ⇒ 门卫永不执行**（实测只跑了 handler）。
   ⇒ **绝不能**在 `createRouter()` 返回后对模块 router 补 `use(path, gate)`——那会造出一个
   「代码里有门卫、运行时永不生效」的静默洞。必须用**包裹层**：新建 Hono，先挂门卫，
   再 `route('/', 模块 router)`（已实测：路径合成正确、门卫先跑、可再挂到 `/api/modules/<id>`）。
3. **`router.routes` 会把子路由带全路径枚举**（`mod.route('/api', sub)` → `GET /api/notes/:id`），
   中间件记作 `ALL /*`（比对时须过滤）⇒ 装载期双向核对可行。

---

### Task 1: 限速器 + 两扇门接入 + audit 保留（`apps/server`）

**Files:**
- Create: `apps/server/src/rate-limit.ts`
- Create: `apps/server/src/rate-limit.test.ts`
- Create: `apps/server/src/migrations/002_audit_retention.sql`
- Modify: `apps/server/src/routes/auth.ts`（`AuthRoutesDeps` + login 三处）
- Modify: `apps/server/src/routes/auth-wecom.ts`（`WecomRoutesDeps` + callback 三处）
- Modify: `apps/server/src/app.ts`（建 limiter 并注入两个路由工厂）
- Modify: `apps/server/src/routes/auth.test.ts`（`makeApp` 增参 + 两条新用例）
- Modify: `apps/server/src/routes/auth-wecom.test.ts`（`makeApp` 传 limiter + 一条新用例）

**Interfaces:**
- Consumes: 无（任务内的新模块）
- Produces:
  - `createLoginLimiter(opts?: { now?: () => number }): LoginLimiter`
  - `LoginLimiter.check(tenantId: number, username: string | null): LimitDecision`
  - `LoginLimiter.record(tenantId: number, username: string | null, ok: boolean): void`
  - `LimitDecision = { allowed: boolean; retryAfterSec?: number; dimension?: 'user' | 'tenant-fail' | 'tenant-all' }`
  - `tooManyRequests<E extends Env>(c, tenantId, d): Response`
  - 常量 `USER_FAIL_LIMIT` / `USER_FAIL_WINDOW_MS` / `TENANT_FAIL_LIMIT` /
    `TENANT_FAIL_WINDOW_MS` / `TENANT_ATTEMPT_LIMIT` / `TENANT_ATTEMPT_WINDOW_MS` / `USER_BUCKET_CAP`
  - 两个路由工厂的 deps 均**新增必填** `limiter: LoginLimiter`（宿主 `app.ts` 建一个实例传给两者，
    **必须共用同一实例**：分成两个实例等于攻击者把流量劈成两半、各享一份预算）

- [ ] **Step 1: 写失败测试**

新建 `apps/server/src/rate-limit.test.ts`：

```ts
// 限速器自己的语义也要有测试——否则它给出的"挡住了"没有任何证据价值。
// 时钟注入：全部用例不碰真时间，窗口过期可被精确断言。
import { describe, expect, it } from 'vitest'
import {
  TENANT_ATTEMPT_LIMIT,
  TENANT_FAIL_LIMIT,
  USER_BUCKET_CAP,
  USER_FAIL_LIMIT,
  USER_FAIL_WINDOW_MS,
  createLoginLimiter,
} from './rate-limit'

describe('登录限速器（进程内存、租户内三层、不依赖客户端 IP）', () => {
  it('★ 负例：第 5 次失败后第 6 次被拒（user 维度），桶按用户名与租户隔离', () => {
    let t = 0
    const l = createLoginLimiter({ now: () => t })
    for (let i = 0; i < USER_FAIL_LIMIT; i++) {
      expect(l.check(1, 'alice').allowed).toBe(true)
      l.record(1, 'alice', false)
    }
    const d = l.check(1, 'alice')
    expect(d.allowed).toBe(false)
    expect(d.dimension).toBe('user')
    expect(d.retryAfterSec).toBeGreaterThan(0)
    // 同租户另一个用户名不受影响；另一个租户的同名用户也不受影响
    expect(l.check(1, 'bob').allowed).toBe(true)
    expect(l.check(2, 'alice').allowed).toBe(true)
  })

  it('成功即清零该用户失败桶（否则正常用户被自己的成功登录耗尽配额）', () => {
    let t = 0
    const l = createLoginLimiter({ now: () => t })
    for (let i = 0; i < USER_FAIL_LIMIT - 1; i++) l.record(1, 'alice', false)
    expect(l.check(1, 'alice').allowed).toBe(true)
    l.record(1, 'alice', true) // 成功
    for (let i = 0; i < USER_FAIL_LIMIT - 1; i++) l.record(1, 'alice', false)
    expect(l.check(1, 'alice').allowed).toBe(true) // 计数确实从 0 重来
  })

  it('窗口过期即复位（固定窗口：resetAt 到了就重算）', () => {
    let t = 0
    const l = createLoginLimiter({ now: () => t })
    for (let i = 0; i < USER_FAIL_LIMIT; i++) l.record(1, 'alice', false)
    expect(l.check(1, 'alice').allowed).toBe(false)
    t += USER_FAIL_WINDOW_MS // 恰好在窗口边界之后
    expect(l.check(1, 'alice').allowed).toBe(true)
  })

  it('租户失败总数：换用户名也拦得住（灌表威胁的真正闸门）', () => {
    let t = 0
    const l = createLoginLimiter({ now: () => t })
    for (let i = 0; i < TENANT_FAIL_LIMIT; i++) l.record(1, `u${i}`, false) // 每个用户名只失败一次
    const d = l.check(1, 'brand-new-user')
    expect(d.allowed).toBe(false)
    expect(d.dimension).toBe('tenant-fail')
    expect(l.check(2, 'brand-new-user').allowed).toBe(true) // 另一租户不受牵连
  })

  it('租户全部尝试：成功也计数（有效凭据刷成功路径同样被拦）', () => {
    let t = 0
    const l = createLoginLimiter({ now: () => t })
    const n = TENANT_ATTEMPT_LIMIT
    for (let i = 0; i < n; i++) l.record(1, `u${i}`, true) // 全成功
    const d = l.check(1, 'whoever')
    expect(d.allowed).toBe(false)
    expect(d.dimension).toBe('tenant-all')
    expect(l.check(2, 'whoever').allowed).toBe(true)
  })

  it('username=null（企微回调）：跳过 user 层，租户层照常生效', () => {
    let t = 0
    const l = createLoginLimiter({ now: () => t })
    for (let i = 0; i < USER_FAIL_LIMIT * 3; i++) l.record(1, null, false)
    expect(l.check(1, null).allowed).toBe(true) // user 层不适用 ⇒ 仍在阈值内
    for (let i = 0; i < TENANT_FAIL_LIMIT; i++) l.record(1, null, false)
    expect(l.check(1, null).allowed).toBe(false)
    expect(l.check(1, null).dimension).toBe('tenant-fail')
  })

  it('check 是只读的：被拒的请求不 record 也不改状态（限速挡在 audit 之前的实现形态）', () => {
    let t = 0
    const l = createLoginLimiter({ now: () => t })
    for (let i = 0; i < USER_FAIL_LIMIT; i++) l.record(1, 'alice', false)
    for (let i = 0; i < 100; i++) expect(l.check(1, 'alice').allowed).toBe(false)
    t += USER_FAIL_WINDOW_MS
    expect(l.check(1, 'alice').allowed).toBe(true) // 100 次 check 没有延长窗口
  })

  it('桶数上限：超限时先清过期、再淘汰最久未更新者，内存不发散', () => {
    let t = 0
    const l = createLoginLimiter({ now: () => t })
    for (let i = 0; i < USER_BUCKET_CAP + 100; i++) {
      l.record(1, `u${i}`, false)
      t += 1 // 让每个桶的 resetAt 不同，淘汰顺序可判定
    }
    // 尚未被淘汰的最近桶仍在（最久未更新者被淘汰，不是不建桶）
    const latest = `u${USER_BUCKET_CAP + 99}`
    for (let i = 0; i < USER_FAIL_LIMIT; i++) l.record(1, latest, false)
    expect(l.check(1, latest).allowed).toBe(false)
    // 最早那个桶已被淘汰 ⇒ 计数归零（诚实记录：这是已知取舍，见 rate-limit.ts 注释）
    expect(l.check(1, 'u0').allowed).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @platform/server test -- rate-limit
```
预期：**整体失败**——`./rate-limit` 模块不存在（`Cannot find module`）。

- [ ] **Step 3: 写限速器**

新建 `apps/server/src/rate-limit.ts`：

```ts
// rate-limit.ts — 登录端点限速（M1 闭债 R2；issue #3 第四节第一条）
//
// 为什么必须有：登录端点此前既无限速、又每失败一次就往 platform.audit 写一行 ⇒ 外部可无限度
// 灌表（routes/auth.ts 的"超长凭据"分支甚至不调 Casdoor 就能写一行，是最廉价的灌表路径）。
// 限速若排在 audit 之后等于没限速——本模块的判定点必须【先于 audit 写入】。
//
// 口径：租户内三层，**不依赖客户端 IP**。理由（真机取证，spec §1.5）：openship edge 目前不
// 转发 X-Forwarded-For（生产机 openresty 全树只有 `proxy_set_header Host $host`），应用侧看到
// 的恒为 edge 回环地址 ⇒ 按 IP 限速会退化成"全局限速"，一个攻击者即可锁死该租户全体用户，
// 比不做更糟。将来 edge 转发真实 IP 时，可作为独立一轮追加维度。
//
// 存储：进程内存。当前拓扑单容器（compose 只有一个 server 服务）⇒ 准确；多副本部署时各副本
// 各算一份（实际阈值 × 副本数）、重启清零。**这是已知取舍，不是疏漏**。
//
// 三个桶记的其实就是"会写 audit 的那些尝试"的速率——这正是不让它长成无界表的那道闸。
import type { Context, Env } from 'hono'

export interface LimitDecision {
  allowed: boolean
  /** 被拒时建议的重试间隔（秒） */
  retryAfterSec?: number
  /** 被拒时命中的维度（日志与测试用） */
  dimension?: 'user' | 'tenant-fail' | 'tenant-all'
}

/** 单账号失败：5 次 / 15 分钟（挡慢速爆破） */
export const USER_FAIL_LIMIT = 5
export const USER_FAIL_WINDOW_MS = 15 * 60_000
/** 租户失败总数：300 / 分钟（挡"换用户名喷洒"灌表——真正救 audit 的那道） */
export const TENANT_FAIL_LIMIT = 300
export const TENANT_FAIL_WINDOW_MS = 60_000
/** 租户全部尝试：1000 / 分钟（挡有效凭据滥用成功路径 + 兜底） */
export const TENANT_ATTEMPT_LIMIT = 1000
export const TENANT_ATTEMPT_WINDOW_MS = 60_000
/**
 * 每租户 user 级失败桶数上限（兜底）。造桶必须先造成失败，而失败速率已被 TENANT_FAIL_LIMIT
 * 压住（300/分 × 15 分 = 4500），故正常永远够用。
 */
export const USER_BUCKET_CAP = 8192

interface Counter {
  count: number
  resetAt: number
}

interface TenantState {
  fail?: Counter
  attempt?: Counter
  /** username → 失败计数。**只在失败时创建**（成功直接删）——这是桶数有界的前提 */
  users: Map<string, Counter>
}

export interface LoginLimiter {
  /** 只读判定，不改状态（先查后记；被拒的请求不落账） */
  check(tenantId: number, username: string | null): LimitDecision
  /** 判定之后按真实结果落账：ok ⇒ 清该用户失败桶；!ok ⇒ 失败桶 +1。两者都计入"全部尝试" */
  record(tenantId: number, username: string | null, ok: boolean): void
}

export function createLoginLimiter(opts: { now?: () => number } = {}): LoginLimiter {
  const now = opts.now ?? (() => Date.now())
  const tenants = new Map<number, TenantState>()

  const stateOf = (id: number): TenantState => {
    let s = tenants.get(id)
    if (!s) {
      s = { users: new Map() }
      tenants.set(id, s)
    }
    return s
  }

  /** 未过期的计数（过期视作 0——固定窗口） */
  const live = (c: Counter | undefined, t: number): Counter | undefined =>
    c && t < c.resetAt ? c : undefined

  const deny = (
    dimension: NonNullable<LimitDecision['dimension']>,
    until: number,
    t: number,
  ): LimitDecision => ({
    allowed: false,
    dimension,
    retryAfterSec: Math.max(1, Math.ceil((until - t) / 1000)),
  })

  return {
    check(tenantId, username) {
      const t = now()
      const s = tenants.get(tenantId)
      if (!s) return { allowed: true } // 从没失败过的租户零成本放行
      const att = live(s.attempt, t)
      if (att && att.count >= TENANT_ATTEMPT_LIMIT) return deny('tenant-all', att.resetAt, t)
      const f = live(s.fail, t)
      if (f && f.count >= TENANT_FAIL_LIMIT) return deny('tenant-fail', f.resetAt, t)
      if (username) {
        const u = live(s.users.get(username), t)
        if (u && u.count >= USER_FAIL_LIMIT) return deny('user', u.resetAt, t)
      }
      return { allowed: true }
    },

    record(tenantId, username, ok) {
      const t = now()
      const s = stateOf(tenantId)

      const att = live(s.attempt, t)
      if (att) att.count += 1
      else s.attempt = { count: 1, resetAt: t + TENANT_ATTEMPT_WINDOW_MS }

      if (ok) {
        // 成功即清该用户的失败桶：否则正常用户会被自己的成功登录耗尽配额
        if (username) s.users.delete(username)
        return
      }

      const f = live(s.fail, t)
      if (f) f.count += 1
      else s.fail = { count: 1, resetAt: t + TENANT_FAIL_WINDOW_MS }

      if (!username) return // 企微路的租户层（拿不到用户名，见 spec §3.2）

      const cur = live(s.users.get(username), t)
      if (cur) {
        cur.count += 1
        return
      }
      if (s.users.size >= USER_BUCKET_CAP) {
        // 先清过期桶；仍满则淘汰最久未更新者。
        // 诚实记下残余弱点：理论上可用新用户名刷掉受害者桶（使其计数归零），但产生桶必须先
        // 【造成失败】，而失败速率已被 TENANT_FAIL_LIMIT 限死，此时攻击者自己的请求也已被拒，
        // 净收益为零。
        for (const [k, v] of s.users) if (t >= v.resetAt) s.users.delete(k)
        if (s.users.size >= USER_BUCKET_CAP) {
          let oldestKey: string | undefined
          let oldest = Infinity
          for (const [k, v] of s.users) {
            if (v.resetAt < oldest) {
              oldest = v.resetAt
              oldestKey = k
            }
          }
          if (oldestKey !== undefined) s.users.delete(oldestKey)
        }
      }
      s.users.set(username, { count: 1, resetAt: t + USER_FAIL_WINDOW_MS })
    },
  }
}

/**
 * 被限速时的统一响应：429 + Retry-After，**不写 audit**（写了等于没限速），改一行 warn 让攻击
 * 在容器日志 / OpenObserve 里可见。错误体形状沿用既有 `{ error: string }` 约定，前端无需改。
 */
export function tooManyRequests<E extends Env>(
  c: Context<E>,
  tenantId: number,
  d: LimitDecision,
): Response {
  console.warn(
    `[rate-limit] 拒绝登录尝试 tenant=${tenantId} 维度=${d.dimension} retry-after=${d.retryAfterSec}s`,
  )
  return c.json({ error: 'TOO_MANY_REQUESTS' }, 429, {
    'Retry-After': String(d.retryAfterSec ?? 60),
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @platform/server test -- rate-limit
```
预期：`rate-limit.test.ts` 全绿（8 条）。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/rate-limit.ts apps/server/src/rate-limit.test.ts
git commit -m "feat(server): 登录限速器（租户内三层、内存、不依赖 IP）"
```

- [ ] **Step 6: 写两扇门的接入契约（失败的集成断言先写）**

在 `apps/server/src/routes/auth.test.ts` 里：

① `makeApp` 增一个可注入的 limiter 参数（默认新建 ⇒ 每个 `makeApp` 拿到**独立**限速器，
   用例之间不互相污染；`client` 是文件级共享的，所以新用例必须自建 app）：

```ts
// 顶部 import 增补
import { USER_FAIL_LIMIT, createLoginLimiter, type LoginLimiter } from '../rate-limit'

// makeApp 签名改为（原有调用点不动——后两个参数有默认值）
function makeApp(
  pool: Pool,
  casdoor: CasdoorFactory = casdoorFor,
  limiter: LoginLimiter = createLoginLimiter(),
): Hono<TenantEnv & SessionEnv> {
  const app = new Hono<TenantEnv & SessionEnv>()
  app.use('*', resolveTenantMiddleware({ pool, mode: 'multi', platformOrg: '' }))
  app.use('*', sessionMiddleware({ casdoor, sessionSecret: SECRET }))
  app.route(
    '/api/platform/auth',
    authRoutes({ casdoor, sessionSecret: SECRET, pool, limiter }),
  )
  return app
}
```

② 文件末尾（`})` 之前）追加两条用例：

```ts
  // ⑮ 限速（M1 闭债 R2）：失败达阈值 → 429，且【此后再不产生 audit 行】
  //
  // 审计断言必须按【专用 actor】计数，不能用全局 count(*)：vitest 并发跑各测试文件，
  // 别的文件同时在写/清（migrate.test.ts 的 prune 用例）platform.audit —— 全局计数会抖。
  // 这个用户名全仓只有本用例用，计数因此稳定。
  it('★ 负例：连续失败达阈值 → 429 + Retry-After，且限速挡在 audit 之前（行数不再增长）', async () => {
    const RL_USER = 'rate-limit-probe-user'
    const c2 = testClient(makeApp(pool)) // 独立限速器，不受本文件其他用例影响
    const auditCount = async (): Promise<number> => {
      const { rows } = await pool.query<{ n: string }>(
        'select count(*) as n from platform.audit where actor = $1',
        [RL_USER],
      )
      return Number(rows[0]!.n)
    }
    expect(await auditCount()).toBe(0) // 前置：该 actor 从未出现过

    for (let i = 0; i < USER_FAIL_LIMIT; i++) {
      const r = await c2.api.platform.auth.login.$post(
        { json: { username: RL_USER, password: 'wrong' } },
        { headers: { host: 'acme.test' } },
      )
      expect(r.status).toBe(401)
    }
    const afterFails = await auditCount()
    expect(afterFails).toBe(USER_FAIL_LIMIT) // 阈值内的失败照常记账

    const blocked = await c2.api.platform.auth.login.$post(
      { json: { username: RL_USER, password: 'wrong' } },
      { headers: { host: 'acme.test' } },
    )
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toEqual({ error: 'TOO_MANY_REQUESTS' })
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await auditCount()).toBe(afterFails) // ← 被拦的请求一行都不写
  })

  // ⑯ 限速不该误伤正常用户：只要没超阈值，正确凭据照常登录
  it('未达阈值的正常登录不受限速影响（200 + 会话 cookie）', async () => {
    const c2 = testClient(makeApp(pool))
    await c2.api.platform.auth.login.$post(
      { json: { username: 'alice', password: 'wrong' } },
      { headers: { host: 'acme.test' } },
    )
    const ok = await c2.api.platform.auth.login.$post(
      { json: { username: 'alice', password: 'pw' } },
      { headers: { host: 'acme.test' } },
    )
    expect(ok.status).toBe(200)
    expect(setCookies(ok).join('\n')).toContain('platform_session=')
  })
```

- [ ] **Step 7: 跑测试确认失败**

```bash
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter @platform/server test -- auth.test
```
预期：**typecheck 阶段即失败**——`authRoutes` 的 deps 还没有 `limiter`（若 vitest 未先做类型检查，
则 ⑮ 失败在「第 6 次仍是 401 而非 429」）。

- [ ] **Step 8: 接入账密路**

`apps/server/src/routes/auth.ts` 三处：

① 顶部 import 增补，deps 加 `limiter`：

```ts
import { tooManyRequests, type LoginLimiter } from '../rate-limit'

export interface AuthRoutesDeps {
  /** org 随租户变：multi 模式下各租户各自的 Casdoor org（c.get('tenant').casdoor_org） */
  casdoor: CasdoorFactory
  sessionSecret: string
  pool: Pool
  /**
   * 登录限速器（M1 闭债 R2）。**必须与企微路共用同一实例**——分成两个实例等于攻击者把流量
   * 劈成两半、各享一份预算。宿主 app.ts 建一个传两处。
   */
  limiter: LoginLimiter
}
```

② login handler 里，**在 `writeAudit` 之前**判定（放在解析出 username 之后、空值判断之前——
空 body 也要按租户层拦）：

```ts
    const username = typeof body?.username === 'string' ? body.username : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    // 限速（M1 闭债 R2）：**先于任何 writeAudit**。被拦的请求不写 audit——写了等于没限速
    const decision = deps.limiter.check(t.id, username || null)
    if (!decision.allowed) return tooManyRequests(c, t.id, decision)
    // 形状不对也按坏凭据处理（401 不区分原因，不泄探查面）
    if (!username || !password) {
      return c.json({ error: 'BAD_CREDENTIALS' }, 401)
    }
```

③ 三个"落账"点（**与 audit 写入一一对应**）：

```ts
    // 超长分支（原本就写 audit）——它不调 Casdoor，但同样是一条灌表路径，必须计入失败
    if (username.length > MAX_USERNAME_LEN || password.length > MAX_PASSWORD_LEN) {
      await writeAudit(deps.pool, t.id, username.slice(0, MAX_USERNAME_LEN), 'login.fail', {
        via: 'password',
        reason: 'oversized',
      })
      deps.limiter.record(t.id, username, false)
      return c.json({ error: 'BAD_CREDENTIALS' }, 401)
    }
```

```ts
    if (name === null) {
      await writeAudit(deps.pool, t.id, username, 'login.fail', { via: 'password' })
      deps.limiter.record(t.id, username, false)
      return c.json({ error: 'BAD_CREDENTIALS' }, 401)
    }
```

```ts
    await writeAudit(deps.pool, t.id, name, 'login.ok', { via: 'password' })
    deps.limiter.record(t.id, name, true)
    c.res.headers.append('Set-Cookie', serializeSessionCookie(token))
```

（`CASDOOR_UNAVAILABLE` 的两个 502 分支**不 record**：传输层故障非用户过错，与既有的
「不记 login.fail」语义一致。）

- [ ] **Step 9: 接入企微路**

`apps/server/src/routes/auth-wecom.ts` 三处：

① deps 加 `limiter: LoginLimiter`（import 同 auth.ts）。

② `/callback` handler 开头（`const t = c.get('tenant')` 之后、任何 `fail()` 之前）：

```ts
    // 限速（M1 闭债 R2）：租户层，必须早于任何 writeAudit。企微路在 code 换票前拿不到用户名
    // ⇒ 只判租户维度（spec §3.2 的已知口径落差，刻意如此）
    const decision = deps.limiter.check(t.id, null)
    if (!decision.allowed) return tooManyRequests(c, t.id, decision)
```

③ 两个 audit 点：

```ts
      await writeAudit(deps.pool, t.id, name, 'login.fail', { via, reason: 'no-account' })
      deps.limiter.record(t.id, null, false) // 企微路不建 user 桶（check 也不看它）
```
```ts
    await writeAudit(deps.pool, t.id, name, 'login.ok', { via })
    deps.limiter.record(t.id, null, true)
```

- [ ] **Step 10: 宿主装配（共用同一实例）**

`apps/server/src/app.ts`：在 `buildApp` 内、创建路由之前加常量，并把 `limiter` 传给两个工厂：

```ts
  // 登录限速器（M1 闭债 R2）：**一个实例传两处**（账密 + 企微）——分实例等于把预算劈成两半
  const limiter = createLoginLimiter()
```
```ts
  app.route('/api/platform/auth', authRoutes({
    casdoor: casdoorFactory,
    sessionSecret: config.sessionSecret,
    pool,
    limiter,
  }))
  app.route('/api/platform/auth/wecom', wecomRoutes({
    casdoor: casdoorFactory,
    sessionSecret: config.sessionSecret,
    pool,
    limiter,
    casdoorUrl: config.casdoor.url,
    /* 其余字段不变 */
  }))
```

- [ ] **Step 11: 补企微路的限速用例**

`apps/server/src/routes/auth-wecom.test.ts`：`makeApp` 增第三个参数并透传，然后追加用例。

① `makeApp` 改为（原有调用点不动——后两个参数有默认值）：

```ts
// 顶部 import 增补
import { TENANT_FAIL_LIMIT, createLoginLimiter, type LoginLimiter } from '../rate-limit'

function makeApp(
  pool: Pool,
  casdoor: CasdoorFactory = casdoorFor,
  limiter: LoginLimiter = createLoginLimiter(),
): Hono<TenantEnv & SessionEnv> {
  const app = new Hono<TenantEnv & SessionEnv>()
  app.use('*', resolveTenantMiddleware({ pool, mode: 'multi', platformOrg: '' }))
  app.use('*', sessionMiddleware({ casdoor, sessionSecret: SECRET }))
  app.route(
    '/api/platform/auth/wecom',
    wecomRoutes({
      casdoor,
      sessionSecret: SECRET,
      pool,
      limiter, // ← 新增
      casdoorUrl: mock.origin,
      casdoorClientId: 'test-client',
      casdoorClientSecret: 'test-secret',
      publicOrigin: PUBLIC_ORIGIN,
      wecomFetch: fakeWecomFetch,
    }),
  )
  return app
}
```

② 文件末尾（`})` 之前）追加：

```ts
  // 企微路：租户层限速（code 换票前拿不到用户名 ⇒ 只判租户维度，见 spec §3.2）
  it('★ 负例：租户失败达阈值 → 回调整体 429 TOO_MANY_REQUESTS（不落任何 audit）', async () => {
    const { rows } = await pool.query<{ id: number }>(
      "select id from platform.tenant where slug = 'acme'",
    )
    const acmeId = rows[0]!.id
    const limiter = createLoginLimiter()
    const c2 = testClient(makeApp(pool, casdoorFor, limiter))
    for (let i = 0; i < TENANT_FAIL_LIMIT; i++) limiter.record(acmeId, null, false)

    const res = await c2.api.platform.auth.wecom.callback.$get(
      { query: { code: 'x', state: 'y' } },
      { headers: { host: 'acme.test' } },
    )
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'TOO_MANY_REQUESTS' })
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
  })
```

（该用例只需 pool / casdoorFor 已在该文件装配好；`state` 随意——限速判定在所有校验之前。）

- [ ] **Step 12: 跑测试确认两扇门都通过**

```bash
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter @platform/server test
```
预期：`auth.test.ts` / `auth-wecom.test.ts` 全绿（含新增 3 条）。

- [ ] **Step 13: 写 audit 保留迁移**

新建 `apps/server/src/migrations/002_audit_retention.sql`：

```sql
-- 002_audit_retention.sql — platform.audit 的保留策略（M1 闭债 R2）
--
-- 背景：001 建表时只有主键，at 无索引、全仓无清理逻辑 ⇒ 表单调增长，且增长速率由攻击者
-- 决定（登录端点此前无限速，每次失败写一行）。限速（apps/server/src/rate-limit.ts）只降低
-- 速率，**不改"无界"这件事**，故保留策略必须同时做。
--
-- 清理【不】由应用进程执行：有副作用的运维动作不该藏在一个 HTTP 服务里。这里只提供函数，
-- 由 openship job 定时调用（见 deploy/openship-adopt.md「audit 保留」）。

-- 只为 prune 的 where 子句服务：不预先造用不上的复合索引
create index if not exists audit_at_idx on platform.audit(at);

-- 删除 keep_days 之前的审计行，返回删除行数（便于 job 日志核对）
create or replace function platform.prune_audit(keep_days int default 90)
returns bigint
language sql
as $$
  with deleted as (
    delete from platform.audit
     where at < now() - make_interval(days => keep_days)
    returning 1
  )
  select count(*) from deleted;
$$;
```

- [ ] **Step 14: 写迁移与 prune 的测试**

`apps/server/src/migrate.test.ts` 追加一条（沿用该文件既有的 pool / 迁移目录装配）：

```ts
  it('002：audit 保留 —— prune_audit(days) 只删超期行并返回删除条数', async () => {
    // 该用例自带清理，不污染其他用例：只插自己造的、且 actor 带专用前缀的行
    await pool.query(
      "insert into platform.audit(tenant_id, actor, action, detail, at) values"
      + " (null, 'prune-test-old', 'login.fail', '{}', now() - interval '100 days'),"
      + " (null, 'prune-test-new', 'login.fail', '{}', now())",
    )
    const { rows } = await pool.query<{ n: string }>(
      'select platform.prune_audit(90) as n',
    )
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(1) // 至少删掉自己那条超期行
    const left = await pool.query<{ c: string }>(
      "select count(*) as c from platform.audit where actor like 'prune-test-%'",
    )
    expect(Number(left.rows[0]!.c)).toBe(1) // 未超期那条还在
    await pool.query("delete from platform.audit where actor like 'prune-test-%'")
  })
```

- [ ] **Step 15: 跑全包测试 + 类型检查**

```bash
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter @platform/server test
pnpm typecheck
```
预期：全绿；`pnpm typecheck` 会**替你抓出漏改的调用点**（`app.ts` 是唯一生产调用点，
两个测试文件是另两处）。

- [ ] **Step 16: Commit**

```bash
git add apps/server/src/routes/auth.ts apps/server/src/routes/auth-wecom.ts \
        apps/server/src/app.ts apps/server/src/routes/auth.test.ts \
        apps/server/src/routes/auth-wecom.test.ts \
        apps/server/src/migrations/002_audit_retention.sql apps/server/src/migrate.test.ts
git commit -m "fix(server): 登录两扇门接入限速（先于 audit）+ audit 保留策略"
```

---

### Task 2: 模块 scope「声明即授权」（`@platform/sdk` + 装载器 + demo）

**Files:**
- Modify: `packages/platform-sdk/src/manifest.ts`
- Modify: `packages/platform-sdk/src/module.ts`
- Modify: `packages/platform-sdk/src/index.ts`（导出）
- Modify: `packages/platform-sdk/package.json`（`exports` 增 `./test-util/*`）
- Create: `packages/platform-sdk/src/test-util/anonymous-probe.ts`
- Create: `packages/platform-sdk/src/test-util/anonymous-probe.test.ts`
- Modify: `packages/platform-sdk/src/manifest.test.ts`（旧形状夹具 + 两条新负例）
- Modify: `apps/server/src/loader.ts`（包裹层 + 双向核对）
- Modify: `apps/server/src/loader.test.ts`（两个 fixture 工厂 + 三条新用例）
- Modify: `modules/demo/manifest.yaml`、`modules/demo/index.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'`
  - `ModuleManifest.api?: { internal?: Array<{ method: ApiMethod; path: string; scope: string }> }`
  - `declaredScopeGate(declared: ReadonlyArray<DeclaredEndpoint>): MiddlewareHandler`
  - `DeclaredEndpoint = { method: string; path: string; scope: string }`
  - `applyDeclaredApiGate(router: Hono, manifest: ModuleManifest): Hono`（装载器导出，返回包裹后的 router）
  - `probeAnonymous(router: Hono): Promise<Array<{ method: string; path: string; status: number }>>`

- [ ] **Step 1: 写失败的 schema 测试**

`packages/platform-sdk/src/manifest.test.ts`：

① `validManifest` 第 16 行的旧形状改成新形状：

```ts
  api: { internal: [{ method: 'GET', path: '/tickets', scope: 'demo:view' }] },
```
第 42 行同步：
```ts
    expect(r.data.api?.internal).toEqual([{ method: 'GET', path: '/tickets', scope: 'demo:view' }])
```

② 文件末尾（`})` 之前）追加三条：

```ts
  // R2：api.internal 是可机械消费的声明（旧形状 {name,scope} 无 path/method，谁也没法消费，
  // 于是成了死字段——identity 从"忘挂 requireScope"变成"没声明就不可达"）
  it('api.internal：method 必须是白名单内的方法', () => {
    const bad = { ...validManifest, api: { internal: [{ method: 'TRACE', path: '/x', scope: 'demo:view' }] } }
    expect(ManifestSchema.safeParse(bad).success).toBe(false)
  })

  it('★ 负例：api.internal[].scope 不属于本模块 permissions ⇒ 校验失败', () => {
    // 声明一个自己都没有的码 ⇒ 该路径恒 403 而无人知晓（与"忘挂 requireScope"同一种病的变种）
    const bad = {
      ...validManifest,
      api: { internal: [{ method: 'GET', path: '/x', scope: 'other-module:view' }] },
    }
    const r = ManifestSchema.safeParse(bad)
    expect(r.success).toBe(false)
    if (r.success) return
    expect(r.error.issues[0]!.message).toContain('不在本模块 permissions')
  })

  it('★ 负例：同 (method,path) 声明两次 ⇒ 校验失败（门卫会出现二义）', () => {
    const bad = {
      ...validManifest,
      api: {
        internal: [
          { method: 'GET', path: '/x', scope: 'demo:view' },
          { method: 'GET', path: '/x', scope: 'demo:edit' },
        ],
      },
    }
    expect(ManifestSchema.safeParse(bad).success).toBe(false)
  })
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @platform/sdk test -- manifest
```
预期：全量用例红——旧 schema 不认识 `method`/`path`（`api.internal[0].name` 必填缺失），
三条新用例中负例两条因"当前 schema 照单全收"而红。

- [ ] **Step 3: 改 schema**

`packages/platform-sdk/src/manifest.ts`：

① 接口（替换第 10 行）：

```ts
/** api.internal 的条目：一条 = 一个被声明的模块 API 端点。**未声明 = 不可达**（宿主门卫施加） */
export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface ModuleApiEndpoint {
  method: ApiMethod
  /** 模块内相对路径，必须以 / 开头（与 router 注册的路径模式逐字一致，装载期双向核对） */
  path: string
  scope: string
}
```
并把 `ModuleManifest` 里那行改为：
```ts
  api?: { internal?: ModuleApiEndpoint[] }
```

② zod（替换第 32-34 行）：

```ts
  api: z.object({
    internal: z.array(z.object({
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
      path: z.string().regex(/^\//, 'api.internal[].path 必须以 / 开头（模块内相对路径）'),
      scope: z.string(),
    })).optional(),
  }).optional(),
```

③ `superRefine` 追加（接在既有 permissions 循环之后）：

```ts
  // R2：api.internal[].scope 必须 ∈ 本模块 permissions[].code —— 否则模块声明一个自己都没有
  // 的码，该路径恒 403 而无人知晓（与"忘挂 requireScope"同一种病的变种）。由 schema 承载 ⇒
  // 运行时装载与 check-manifests 门禁同时覆盖。
  const codes = new Set(m.permissions.map((p) => p.code))
  const seenEndpoints = new Set<string>()
  for (const [i, e] of (m.api?.internal ?? []).entries()) {
    if (!codes.has(e.scope)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['api', 'internal', i, 'scope'],
        message: `api.internal[].scope "${e.scope}" 不在本模块 permissions[].code 内（模块只能声明自己的权限码）`,
      })
    }
    const key = `${e.method} ${e.path}`
    if (seenEndpoints.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['api', 'internal', i],
        message: `api.internal 重复声明 ${key}（同 (method,path) 只能有一条，否则门卫二义）`,
      })
    }
    seenEndpoints.add(key)
  }
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @platform/sdk test -- manifest
```
预期：全绿。

- [ ] **Step 5: 写失败的门卫测试**

新建 `packages/platform-sdk/src/test-util/anonymous-probe.test.ts`：

```ts
// 门卫自己的语义也要有测试。这里同时钉死一条【载荷性假设】：门卫靠 c.req.routePath 取
// 命中的路径模式——若 Hono 行为变化（或改用通配挂载），这些用例会立刻变红。
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { declaredScopeGate, type Identity } from '../module'

const declared = [
  { method: 'GET', path: '/ping', scope: 'demo:view' },
  { method: 'GET', path: '/notes/:id', scope: 'demo:note' },
]

type Env = { Variables: { identity: Identity } }
const withIdentity = (scopes: string[]) =>
  createMiddleware<Env>(async (c, next) => {
    c.set('identity', {
      userId: 'u', orgId: 'o', displayName: 'U', scopes,
      hasScope: (code: string) => scopes.includes(code),
    })
    await next()
  })

function appWith(scopes: string[] | null): Hono {
  const app = new Hono()
  const gate = declaredScopeGate(declared)
  for (const p of new Set(declared.map((d) => d.path))) app.use(p, gate)
  if (scopes) app.use('*', withIdentity(scopes))
  app.get('/ping', (c) => c.json({ hit: 'ping' }))
  app.get('/notes/:id', (c) => c.json({ hit: 'note' }))
  return app
}

describe('declaredScopeGate：未声明 = 不可达', () => {
  it('★ 负例：无 identity ⇒ 401 UNAUTHENTICATED（绝不能落到 handler）', async () => {
    const res = await appWith(null).request('/ping')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'UNAUTHENTICATED' })
  })

  it('★ 负例：identity 在但 scope 不含 ⇒ 403 FORBIDDEN + need', async () => {
    const res = await appWith(['other:scope']).request('/ping')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'FORBIDDEN', need: 'demo:view' })
  })

  it('scope 命中 ⇒ 放行到 handler', async () => {
    const res = await appWith(['demo:view']).request('/ping')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ hit: 'ping' })
  })

  it('★ 参数化路径同样被守住（/notes/42 命中 /notes/:id 的门卫）', async () => {
    const blocked = await appWith(['demo:view']).request('/notes/42')
    expect(blocked.status).toBe(403) // 有 demo:view 但缺 demo:note
    const ok = await appWith(['demo:note']).request('/notes/42')
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ hit: 'note' })
  })

  it('★ 负例：声明外的 method 打到已声明路径 ⇒ 403 而非 404（fail-closed，不泄方法枚举）', async () => {
    const res = await appWith(['demo:view']).request('/ping', { method: 'POST' })
    expect(res.status).toBe(403)
  })
})
```

- [ ] **Step 6: 跑测试确认失败**

```bash
pnpm --filter @platform/sdk test -- anonymous-probe
```
预期：`declaredScopeGate` 不存在（`is not a function` / 导入失败）。

- [ ] **Step 7: 实现门卫**

`packages/platform-sdk/src/module.ts` 末尾追加：

```ts
/** 一个被声明的端点（与 manifest.api.internal[] 同形；宿主 loader 传进来） */
export interface DeclaredEndpoint {
  method: string
  path: string
  scope: string
}

/**
 * 模块 API 门卫：**按声明授权**。
 *
 * 为什么不是模块手写 requireScope（M1 闭债 R2）：漏写一次就是**匿名可读**，且不报错、不告警、
 * CI 不红——一种纯靠人记得的契约。改由 host 按 manifest 施加后，"忘挂"这件事在结构上不可能
 * 发生（没有可挂的东西）。
 *
 * 挂载方式决定了它能不能生效（已实证，勿踩）：
 *   - 必须 `app.use(声明路径, gate)` **先于** handler 注册，否则门卫永不执行；
 *   - `use('*', gate)` 里 c.req.routePath 恒为 '/*'，**拿不到**下游 handler 的路径。
 * 故宿主用"包裹层"：新建 Hono → 先挂门卫 → 再 route('/', 模块 router)（loader.applyDeclaredApiGate）。
 *
 * 错误体与 requireScope 逐字一致（模块与前端无需感知差异）。
 */
export function declaredScopeGate(
  declared: ReadonlyArray<DeclaredEndpoint>,
): MiddlewareHandler {
  return async (c, next) => {
    const identity = c.get('identity') as Identity | undefined
    if (!identity) {
      return c.json({ error: 'UNAUTHENTICATED' }, 401)
    }
    const hit = declared.find((d) => d.path === c.req.routePath && d.method === c.req.method)
    if (!hit) {
      // 未声明即不可达（fail-closed）。装载期双向核对已保证每个注册路由都被声明过，
      // 所以这条只会在"声明路径下的未声明 method"（如声明 GET 而请求 POST）时命中。
      return c.json({ error: 'FORBIDDEN' }, 403)
    }
    if (!identity.hasScope(hit.scope)) {
      return c.json({ error: 'FORBIDDEN', need: hit.scope }, 403)
    }
    await next()
  }
}
```

- [ ] **Step 8: 跑测试确认通过**

```bash
pnpm --filter @platform/sdk test -- anonymous-probe
```
预期：全绿（5 条）。**若"参数化路径"那条红**，说明 `c.req.routePath` 在门卫里拿不到路径模式——
停下来查（这是本设计的载荷性假设），不要放宽断言。

- [ ] **Step 9: 写匿名探测工具（回归网）**

新建 `packages/platform-sdk/src/test-util/anonymous-probe.ts`：

```ts
// anonymous-probe.ts — 匿名探测：对 router 的每条已注册路由发一个【无 identity】的请求，
// 断言它被门卫拦下（401）。它测的是"门卫真的生效"这件事本身，而非"代码里写了 requireScope"
// ——与 M1 闭债 R1 的教训一致：断言必须真跑。
import type { Hono } from 'hono'

export interface AnonymousProbeResult {
  method: string
  path: string
  status: number
}

/**
 * 探测 router 的每条【非中间件】路由（method !== 'ALL'）的匿名可达性。
 * 返回每条的实测状态码，由调用方断言（通常：全部 === 401）。
 * 路径参数（/notes/:id）替换为占位段后再请求（'：' 与 '*' 段换成 'probe'）。
 */
export async function probeAnonymous(router: Hono): Promise<AnonymousProbeResult[]> {
  const routes = router.routes.filter((r) => r.method !== 'ALL')
  const out: AnonymousProbeResult[] = []
  for (const r of routes) {
    const realPath = r.path.replace(/[:*][^/]*/g, 'probe')
    const res = await router.request(realPath, { method: r.method })
    out.push({ method: r.method, path: r.path, status: res.status })
  }
  return out
}
```

`packages/platform-sdk/package.json` 的 `exports` 增一行（auth-core 无 exports 表故可深引用；
sdk 有，必须显式开）：

```json
  "exports": {
    ".": "./src/index.ts",
    "./web": "./web/platform-fetch.ts",
    "./test-util/*": "./src/test-util/*"
  },
```

`packages/platform-sdk/src/index.ts` 增导出：

```ts
export { defineModule, requireScope, declaredScopeGate } from './module'
export type { DeclaredEndpoint, Identity, ModuleContext, ModuleDefinition } from './module'
```

- [ ] **Step 10: 给探测工具写测试**

新建 `packages/platform-sdk/src/test-util/anonymous-probe.test.ts` **末尾追加**：

```ts
describe('probeAnonymous：匿名探测回归网', () => {
  it('★ 负例：门卫缺失的路由会被如实报成 200（探测不能"永远绿"）', async () => {
    const unguarded = new Hono()
    unguarded.get('/open', (c) => c.json({ leaked: true }))
    const results = await probeAnonymous(unguarded)
    expect(results).toEqual([{ method: 'GET', path: '/open', status: 200 }])
  })

  it('门卫齐备 ⇒ 每条路由都 401，含参数化路径', async () => {
    const router = new Hono()
    router.get('/ping', (c) => c.json({ hit: 'ping' }))
    router.get('/notes/:id', (c) => c.json({ hit: 'note' }))
    const guarded = new Hono()
    const gate = declaredScopeGate(declared)
    for (const p of new Set(declared.map((d) => d.path))) guarded.use(p, gate)
    guarded.route('/', router)
    const results = await probeAnonymous(guarded)
    expect(results.map((r) => r.status)).toEqual([401, 401])
  })
})
```
（文件顶部 import 补 `import { probeAnonymous } from './anonymous-probe'`。）

- [ ] **Step 11: 跑测试确认通过**

```bash
pnpm --filter @platform/sdk test
```
预期：全绿。

- [ ] **Step 12: Commit（sdk 侧）**

```bash
git add packages/platform-sdk/src/manifest.ts packages/platform-sdk/src/module.ts \
        packages/platform-sdk/src/index.ts packages/platform-sdk/package.json \
        packages/platform-sdk/src/manifest.test.ts \
        packages/platform-sdk/src/test-util/
git commit -m "feat(sdk): manifest 声明即授权——api.internal 改 {method,path,scope} + 门卫 + 匿名探测"
```

- [ ] **Step 13: 写装载器的失败测试**

`apps/server/src/loader.test.ts`：

① **两个 fixture 工厂改为新协议**（它们被全文件复用，不改则既有用例集体变红）：

```ts
  /** fixture 模块入口：真协议（defineModule），不再手写 requireScope——声明在 manifest 里 */
  function indexTs(id: string, permCode: string): string {
    return [
      "import { Hono } from 'hono'",
      "import { defineModule } from '@platform/sdk'",
      '',
      'export default defineModule({',
      `  manifest: {`,
      `    id: '${id}', name: '${id} 模块', version: '1.0.0', platform: '>=0.1.0',`,
      `    permissions: [{ code: '${permCode}', name: '${id} 查看' }],`,
      `    api: { internal: [{ method: 'GET', path: '/ping', scope: '${permCode}' }] },`,
      '  },',
      '  createRouter: (ctx) => {',
      '    const app = new Hono()',
      `    app.get('/ping', (c) => c.json({ module: '${id}', hasPool: !!ctx.pool }))`,
      '    return app',
      '  },',
      '})',
      '',
    ].join('\n')
  }
```

② 文件末尾（`})` 之前）追加三条：

```ts
  it('★ 负例：模块注册了未声明的路由 ⇒ 装载失败（fail-fast，绝不半挂）', async () => {
    cleanupModules.push('undeclaredmod')
    const modulesDir = await newModulesDir()
    await writeModule(modulesDir, 'undeclaredmod', {
      'manifest.yaml': manifestYaml('undeclaredmod'),
      // manifest 没有 api 段，index 却注册了 /ping
      'index.ts': [
        "import { Hono } from 'hono'",
        "import { defineModule } from '@platform/sdk'",
        'export default defineModule({',
        "  manifest: { id: 'undeclaredmod', name: 'm', version: '1.0.0', platform: '>=0.1.0',",
        "    permissions: [{ code: 'undeclaredmod:view', name: 'x' }] },",
        '  createRouter: () => { const a = new Hono(); a.get(\'/ping\', (c) => c.json({})); return a },',
        '})',
        '',
      ].join('\n'),
    })
    await expect(loadModules(modulesDir, { pool })).rejects.toThrow(/未声明/)
  })

  it('★ 负例：声明了模块未注册的路径（幽灵声明）⇒ 装载失败', async () => {
    cleanupModules.push('phantommod')
    const modulesDir = await newModulesDir()
    await writeModule(modulesDir, 'phantommod', {
      'manifest.yaml': manifestYaml(
        'phantommod',
        "api:\n  internal:\n    - { method: GET, path: /ghost, scope: phantommod:view }",
      ),
      'index.ts': indexTs('phantommod', 'phantommod:view'),
    })
    await expect(loadModules(modulesDir, { pool })).rejects.toThrow(/幽灵|未注册|声明/)
  })

  it('声明齐备 ⇒ 装载通过；匿名 401、scope 不符 403、scope 命中 200', async () => {
    cleanupModules.push('guardedmod')
    const modulesDir = await newModulesDir()
    await writeModule(modulesDir, 'guardedmod', {
      'manifest.yaml': manifestYaml('guardedmod'),
      'index.ts': indexTs('guardedmod', 'guardedmod:view'),
    })
    const runtime = await loadModules(modulesDir, { pool })
    const probe = new Hono()
    runtime.mount(probe)
    // 匿名：宿主真实链路里 identity 由会话中间件注入，此处不注入 = 未登录
    const anon = await probe.request('/api/modules/guardedmod/ping')
    expect(anon.status).toBe(401)
    expect(await anon.json()).toEqual({ error: 'UNAUTHENTICATED' })

    const wrong = new Hono()
    wrong.use('*', injectIdentity(['other:scope']))
    runtime.mount(wrong)
    const forbidden = await wrong.request('/api/modules/guardedmod/ping')
    expect(forbidden.status).toBe(403)
    expect(await forbidden.json()).toEqual({ error: 'FORBIDDEN', need: 'guardedmod:view' })

    const right = new Hono()
    right.use('*', injectIdentity(['guardedmod:view']))
    runtime.mount(right)
    expect((await right.request('/api/modules/guardedmod/ping')).status).toBe(200)
  })

  it('匿名探测回归网：装载出的模块每条路由都不可匿名到达', async () => {
    cleanupModules.push('probemod')
    const modulesDir = await newModulesDir()
    await writeModule(modulesDir, 'probemod', {
      'manifest.yaml': manifestYaml('probemod'),
      'index.ts': indexTs('probemod', 'probemod:view'),
    })
    const runtime = await loadModules(modulesDir, { pool })
    const probe = new Hono()
    runtime.mount(probe)
    const results = await probeAnonymous(probe)
    const apiRoutes = results.filter((r) => r.path.startsWith('/api/modules/probemod'))
    expect(apiRoutes.length).toBeGreaterThan(0)
    expect(apiRoutes.every((r) => r.status === 401)).toBe(true)
  })
```
（顶部 import 补 `import { probeAnonymous } from '@platform/sdk/test-util/anonymous-probe'`。）

- [ ] **Step 14: 跑测试确认失败**

```bash
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter @platform/server test -- loader
```
预期：三条新用例红（装载器尚不核对、也不挂门卫）；既有用例**在 fixture 工厂改过之后**应仍绿。

- [ ] **Step 15: 装载器实现**

`apps/server/src/loader.ts`：

① import 增补：

```ts
import { ManifestSchema, declaredScopeGate, type DeclaredEndpoint, type ModuleDefinition, type ModuleManifest } from '@platform/sdk'
import { Hono } from 'hono'   // 原为 `import type { Hono } from 'hono'`——包裹层要真建实例
```

② 新增导出函数（放在 `provisionModulePermissions` 之后）：

```ts
/**
 * 按 manifest 声明给模块 router 施加门卫，并核对声明与代码一致（M1 闭债 R2）。
 *
 * **为什么用包裹层而不是对 router 补 use()**：Hono 里 handler 先注册、use 后注册时门卫
 * 【永不执行】（已实证）——那样会造出一个"代码里有门卫、运行时永不生效"的静默洞。
 * 正解是新建 Hono → 先挂门卫 → 再 route('/', router)（已实证：路径合成正确、门卫先跑）。
 *
 * 双向核对：注册的路由集合必须与声明集合完全一致，任一方向的差集都让装载失败（fail-fast，
 * 与"装载器必填"同风格）。这让"声明与代码漂移"不可能悄悄存在。
 */
export function applyDeclaredApiGate(router: Hono, manifest: ModuleManifest): Hono {
  const declared: DeclaredEndpoint[] = manifest.api?.internal ?? []

  const registered = router.routes
    .filter((r) => r.method !== 'ALL') // 模块自己的 use() 中间件记为 ALL，不参与比对
    .map((r) => `${r.method} ${r.path}`)
  const declaredKeys = declared.map((d) => `${d.method} ${d.path}`)
  const declaredSet = new Set(declaredKeys)
  const registeredSet = new Set(registered)
  const undeclared = registered.filter((k) => !declaredSet.has(k))
  const phantom = declaredKeys.filter((k) => !registeredSet.has(k))

  if (undeclared.length > 0 || phantom.length > 0) {
    throw new Error(
      `模块 "${manifest.id}" 的 api.internal 声明与代码不一致：`
      + `未声明但已注册 [${undeclared.join(', ') || '-'}]；`
      + `已声明但未注册 [${phantom.join(', ') || '-'}]`
      + `（未声明 = 不可达；声明与代码必须逐条对齐）`,
    )
  }

  const guarded = new Hono()
  const gate = declaredScopeGate(declared)
  for (const p of new Set(declared.map((d) => d.path))) guarded.use(p, gate)
  guarded.route('/', router)
  return guarded
}
```

③ 循环内建 router 的那行改为走包裹层（第 159 行）：

```ts
    loaded.push({ manifest, router: applyDeclaredApiGate(def.createRouter({ pool: deps.pool }), manifest), dir })
```

- [ ] **Step 16: 跑测试确认通过**

```bash
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter @platform/server test -- loader
```
预期：`loader.test.ts` 全绿（含 4 条新用例）。

- [ ] **Step 17: 让 demo 模块走新协议**

`modules/demo/manifest.yaml` 在 `permissions` 之后加：

```yaml
api:
  internal:
    - { method: GET,  path: /ping,  scope: demo:view }
    - { method: GET,  path: /notes, scope: demo:note }
    - { method: POST, path: /notes, scope: demo:note }
```

`modules/demo/index.ts`：import 去掉 `requireScope`（保留 `Identity` 类型），三条路由的
`requireScope('…')` 参数**整段删除**：

```ts
    // 门禁由宿主按 manifest 声明施加（M1 闭债 R2）——模块不再手写 requireScope：
    // 忘挂就匿名可读，那条路已经堵死。身份仍由宿主注入 c.get('identity')
    r.get('/ping', (c) => c.json({
      pong: true,
      identity: { userId: c.get('identity')!.userId, orgId: c.get('identity')!.orgId },
    }))

    r.get('/notes', async (c) => { /* 原样 */ })

    r.post('/notes', async (c) => { /* 原样 */ })
```

- [ ] **Step 18: 变异检验（证明双向核对真咬得住）**

先跑一遍基线（应绿）：

```bash
pnpm exec tsx scripts/check-manifests.mjs
```

再做最小变异——**临时**从 demo 声明里删掉 `/ping` 那行：

```bash
perl -0pi -e "s/    - \{ method: GET,  path: \/ping,  scope: demo:view \}\n//" modules/demo/manifest.yaml
grep -c "path: /ping" modules/demo/manifest.yaml   # 确认变异已生效（应为 0）
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm smoke
```

预期：**冒烟变红**，且红在装载失败上（未声明但已注册 `GET /ping`）。把红的那一行原文
记进本任务报告。若变异后**仍然全绿**：说明双向核对没咬住，停下来查，**不要**就这样提交。

还原并复验：

```bash
git checkout modules/demo/manifest.yaml
pnpm exec tsx scripts/check-manifests.mjs    # 复绿
```

- [ ] **Step 19: 全量验证 + Commit**

```bash
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm test
pnpm typecheck
pnpm exec tsx scripts/check-manifests.mjs && pnpm exec tsx scripts/lint-architecture.mjs \
  && pnpm exec tsx scripts/check-compose.mjs && pnpm exec tsx scripts/check-env-example.mjs
```
预期：全绿。

```bash
git add apps/server/src/loader.ts apps/server/src/loader.test.ts \
        modules/demo/manifest.yaml modules/demo/index.ts
git commit -m "feat(loader): 模块 scope 声明即授权——包裹层门卫 + 装载期双向核对"
```

---

### Task 3: 冒烟加固（真进程层面）

**Files:**
- Modify: `scripts/smoke-load.mjs`

**Interfaces:**
- Consumes: Task 1 的 429 行为；Task 2 的「匿名 = 401」
- Produces: 无（冒烟是终端验证，不被其他任务消费）

- [ ] **Step 1: 在 `runMulti` 末尾追加两段断言**

放在 `runMulti` **最后**（beta 那段之后）——限速用例会污染该用户名在本进程内的计数，
故必须排在所有依赖正常登录的断言之后，且**用一个专用用户名**，绝不能用 `admin1`/`viewer1`：

```js
  step('multi：模块 API 匿名不可达（声明即授权 —— 身份门卫在拦）')
  const anonPing = await httpRequest({
    port,
    host: TENANT_HOST,
    path: '/api/modules/demo/ping',
  })
  check(
    anonPing.status === 401 && json(anonPing)?.error === 'UNAUTHENTICATED',
    '匿名 GET /api/modules/demo/ping → 401 UNAUTHENTICATED（未声明 = 不可达的另一面：没身份就没门）',
    describe(anonPing),
  )

  step('multi：登录限速（连续失败达阈值 ⇒ 429，含 Retry-After）')
  // 专用用户名：本进程的限速器是幂等的内存状态，用 admin1 会把后续用例的登录一起拦掉
  const RL_USER = 'ratelimit-probe'
  let rlRes = null
  for (let i = 0; i < 6; i++) {
    rlRes = await httpRequest({
      port,
      host: TENANT_HOST,
      method: 'POST',
      path: '/api/platform/auth/login',
      body: JSON.stringify({ username: RL_USER, password: 'wrong' }),
    })
    if (rlRes.status === 429) break
    check(rlRes.status === 401, `第 ${i + 1} 次坏凭据登录 401（尚未达阈值）`, describe(rlRes))
  }
  check(
    rlRes.status === 429 && json(rlRes)?.error === 'TOO_MANY_REQUESTS',
    '连续失败达阈值后返回 429 TOO_MANY_REQUESTS',
    describe(rlRes),
  )
  check(
    Number(rlRes.headers['retry-after']) > 0,
    `429 带 Retry-After 头（实际 ${rlRes.headers['retry-after']}）`,
    { headers: rlRes.headers },
  )
```

**两处与 spec §4.2 的偏差，都在这里交代清楚（不是漏做）：**

1. **「audit 行数不再增长」不在冒烟里做**——`scripts/` 的依赖表不含 `pg`，冒烟引入数据库客户端
   要先给仓根加依赖，不值得。该断言已在 `auth.test.ts` 用例 ⑮ 用真 PG 覆盖。
2. **「企微回调租户层限速」不在冒烟里做，下移到单测**（`auth-wecom.test.ts`，Task 1 Step 11）——
   冒烟驱动企微回调要真走 OIDC `code` 换票链路（`casdoorCodeToName` 打真 Casdoor 令牌端点），
   构造成本远超收益；单测已用假企微 + 真 HTTP + 真 PG 覆盖同一代码路径。
   ⇒ spec §4.2 那两条冒烟断言按此收敛，**其余冒烟断言照做**。

- [ ] **Step 2: 跑冒烟确认绿**

```bash
pnpm --filter @platform/web build
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm smoke
```
预期：`smoke-load: OK（multi + single 双形态全通过）`，输出里能看到新增的两段
`== multi：模块 API 匿名不可达…` 与 `== multi：登录限速…` 的 ✓。

- [ ] **Step 3: 红检——证明新断言咬得住**

临时把限速器的 user 阈值调大（等效于"限速不存在"）：

```bash
perl -0pi -e "s/export const USER_FAIL_LIMIT = 5/export const USER_FAIL_LIMIT = 999/" apps/server/src/rate-limit.ts
grep -n "USER_FAIL_LIMIT = " apps/server/src/rate-limit.ts
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm smoke
```
预期：冒烟变红，红在「连续失败达阈值后返回 429」那条。同样地，把 demo 声明删一行可验证
匿名/装载那条（Task 2 Step 18 已做过）。记录红的原文。

还原：

```bash
git checkout apps/server/src/rate-limit.ts
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm smoke   # 复绿
```

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-load.mjs
git commit -m "test(smoke): 补登录限速 429 与模块 API 匿名不可达断言"
```

---

### Task 4: 文档 + CHANGELOG + 全量门禁

**Files:**
- Create: `docs/module-protocol.md`
- Modify: `deploy/openship-adopt.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 1–3 的全部行为变化
- Produces: 无

- [ ] **Step 1: 写模块协议文档**

新建 `docs/module-protocol.md`。**这个字段（`api.internal`）当年正是死于零文档**——仓库里
查不到任何一处描述它，于是没人知道它该长什么样、也没人发现它没人消费。核心内容：

````markdown
# 模块接入协议：API 声明（`api.internal`）

> 适用：`modules/<id>/manifest.yaml`。契约源是 `packages/platform-sdk/src/manifest.ts`。

## 规则：没声明 = 不可达

模块的每条 API 路由**必须**在 manifest 里声明 method / path / scope：

```yaml
api:
  internal:
    - { method: GET,  path: /ping,  scope: demo:view }
    - { method: POST, path: /notes, scope: demo:note }
```

- `path` 是**模块内相对路径**，与 `createRouter` 里注册的路径模式**逐字一致**（含 `:param`）
- `scope` 必须是本模块 `permissions[].code` 里的码（否则该路径恒 403，schema 直接拒绝）
- 模块**不再写** `requireScope`：门禁由宿主按声明施加。写漏了不会匿名可读——那条路已经堵死

## 装载期双向核对（fail-fast）

装载器把 `router.routes` 与声明集合**双向比对**，任一方向不一致直接装载失败：

| 情形 | 结果 |
|---|---|
| 注册了路由但没声明 | **装载失败**（绝不半挂） |
| 声明了路径但没注册 | **装载失败** |
| 声明了不属于本模块的 scope | schema 校验失败（`check-manifests` 门禁同时拦下） |

所以「改了代码忘了改 manifest」的后果是**起不来**，而不是静默漏掉一个鉴权。

## 门卫的判定顺序

`无 identity → 401 UNAUTHENTICATED` / `(method,path) 未声明 → 403 FORBIDDEN` /
`有 identity 但无 scope → 403 FORBIDDEN + need`。错误体与 `requireScope` 逐字一致。

## 调试：匿名探测

`probeAnonymous(router)`（`@platform/sdk/test-util/anonymous-probe`）对每条已注册路由发匿名
请求并返回实测状态码——用来确认门卫真的生效，而不是相信代码里写了什么。
````

- [ ] **Step 2: runbook 加「audit 保留」一节**

`deploy/openship-adopt.md` 的「已知陷阱」之前加：

````markdown
## audit 保留（`platform.audit` 清理）

登录端点失败会写 `platform.audit`（限速器只把它压到有界速率，不改变"会一直长"）。
清理由 **openship job** 定时执行，**应用进程不自己跑**（有副作用的运维动作不该藏在 HTTP 服务里）：

```bash
# 每日一次；默认保留 90 天。返回值 = 删除行数
psql "$DATABASE_URL" -c "select platform.prune_audit();"
```

- 函数与索引来自 `apps/server/src/migrations/002_audit_retention.sql`
- 保留期按需传参：`select platform.prune_audit(180);`
- job 的建立方式见 openship 面板「Jobs」；建议同时订阅失败通知
````

- [ ] **Step 3: 加 CHANGELOG 条目**

`CHANGELOG.md` 的 `## [Unreleased]` 下、现有内容之前插入：

```markdown
### Added / Fixed / Changed - M1 闭债 R2：登录限速 + 审计保留 + 模块 scope 声明即授权（issue #3 第四节）

- 【新增】**登录端点限速**（`apps/server/src/rate-limit.ts`）：租户内三层——单账号失败 5 次/15 分、
  租户失败总数 300/分、租户全部尝试 1000/分。**限速判定先于 audit 写入**，被拦请求不落审计行，
  返 `429 {error:'TOO_MANY_REQUESTS'}` + `Retry-After`，改经 `console.warn` 让攻击在日志侧可见。
  账密与企微回调**两扇门共用同一实例**（分实例等于把预算劈成两半）
- 【修复】**`platform.audit` 无界增长**：此前既无限速、又每次失败写一行，且表上无 `at` 索引、
  全仓无清理逻辑，增长速率完全由攻击者决定。补 `002_audit_retention.sql`（`at` 索引 +
  `platform.prune_audit(days)`），由 openship job 定时调用，默认保留 90 天
- 【破坏】**`manifest.api.internal[]` 形状变更**：`{name, scope}` → `{method, path, scope}`。
  旧形状没有 path/method，**无法被任何消费者机械使用**（全仓零消费者、零文档），已按新形状重定义
- 【破坏】**模块不再手写 `requireScope`**：API 鉴权改由宿主按 manifest 声明施加门卫。
  此前漏写一次就是**匿名可读**——不报错、不告警、CI 不红
- 【新增】**装载期双向核对**：`router.routes` 与声明集合双向比对，注册未声明/声明未注册
  一律**装载失败**（fail-fast）。「改了代码忘了改 manifest」的后果从此是起不来，而非静默漏鉴权
- 【新增】**schema 约束 `api.internal[].scope` ∈ 本模块 `permissions[].code`**：否则该路径
  恒 403 而无人知晓——同一种病的变种
- 【新增】**匿名探测回归网**（`@platform/sdk/test-util/anonymous-probe` + 冒烟断言）：
  对每条已注册路由发匿名请求断言 401，测的是"门卫真的生效"而非"代码里写了什么"
```

- [ ] **Step 4: 全量门禁**

```bash
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm test
pnpm typecheck
pnpm exec tsx scripts/check-manifests.mjs
pnpm exec tsx scripts/lint-architecture.mjs
pnpm exec tsx scripts/check-compose.mjs
pnpm exec tsx scripts/check-env-example.mjs
pnpm --filter @platform/web build && DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm smoke
```
预期：全绿，且 `pnpm test` 里**没有大面积 skip**（`loader`/`auth`/`tenant`/`migrate` 的
PG 测试应当真跑）；`.env.example` 本轮**不加键**（阈值是常量），故 `check-env-example` 键全集不变。

- [ ] **Step 5: Commit**

```bash
git add docs/module-protocol.md deploy/openship-adopt.md CHANGELOG.md
git commit -m "docs: 模块 API 协议文档 + audit 保留 runbook + CHANGELOG"
```

---

## 完成判据（全部满足才算做完）

1. `pnpm test` 全绿且 PG 测试真跑（非 skip）
2. `pnpm typecheck` 全绿
3. `pnpm smoke` 绿，且**两处红检都做过**：Task 2 Step 18（删一条声明 ⇒ 装载失败）、
   Task 3 Step 3（阈值调大 ⇒ 429 断言红），各有原文记录
4. 四个守卫脚本绿
5. `git log` 中四个任务各至少一条 commit，均带 `X-Issue: 3` trailer
6. spec §4.4 满足：每个新断言都有「先红后绿」的记录

## 本计划不做（spec §2 非目标）

按客户端 IP 限速（真机取证：edge 不转发真实 IP，会退化成全局限速）、edge/Cloudflare 层限速、
限速计数落库（多副本场景）、`platform.audit` 分区表、企微路的按用户名维度、
issue 第三节（真机验证 `sso.hookflow.cn`）、第四节其余条目（branding 语义、`/healthz` vs `/readyz`、
`getPermissions` 翻页）、第五节工程 Minor、撤销「multi 按非生产可用对待」那句警告。
