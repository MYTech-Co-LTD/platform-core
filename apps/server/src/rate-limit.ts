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

/**
 * 桶键长度上限。**键必须有界这件事由限速器自己保证**——任何调用方（含将来新增的路由）都
 * 不该能靠传超长串绕过。256 与 routes/auth.ts 的 MAX_USERNAME_LEN 同值：两者都是"用户名
 * 长度上限"这一个事实的投影（auth 侧管 audit 写入有界，限速侧管内存桶键有界）——同源，
 * 变更必须同步。若只改调用方，键就仍可被下一条登录路径重新撑爆。
 */
const MAX_KEY_LEN = 256

/** 桶键统一规范化：超长截断到 MAX_KEY_LEN（check 与 record 必须经此取键，否则两处键不一致） */
function keyOf(u: string): string {
  return u.length > MAX_KEY_LEN ? u.slice(0, MAX_KEY_LEN) : u
}

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
  /** 当前租户的 user 失败桶数（"内存有界"唯一可观测的口子；将来也可喂运维指标） */
  bucketCount(tenantId: number): number
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
        const u = live(s.users.get(keyOf(username)), t)
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
        if (username) s.users.delete(keyOf(username))
        return
      }

      const f = live(s.fail, t)
      if (f) f.count += 1
      else s.fail = { count: 1, resetAt: t + TENANT_FAIL_WINDOW_MS }

      if (!username) return // 企微路的租户层（拿不到用户名，见 spec §3.2）

      const cur = live(s.users.get(keyOf(username)), t)
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
      s.users.set(keyOf(username), { count: 1, resetAt: t + USER_FAIL_WINDOW_MS })
    },

    bucketCount(tenantId) {
      return tenants.get(tenantId)?.users.size ?? 0
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
