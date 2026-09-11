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

/**
 * 门（PR#5 评审 R2）：第 2/3 层的桶按「门」再分一层——`password` = 账密路，`wecom` = 企微回调。
 *
 * 为什么必须分：这两层此前只按 tenantId 分桶、**不分门**，于是 300 次匿名
 * `GET /wecom/callback?code=x&state=<不匹配>`（连 state cookie 都不需要）就能推满租户失败桶，
 * 同租户的 `POST /login` 一起 429 ⇒ **打企微回调即锁死该租户的两种登录入口**，且可持续打
 * = 永久锁死。分桶后爆炸半径缩回「哪扇门被灌，哪扇门自己挨」。
 *
 * 注意分的是**桶的键**，不是实例：两扇门仍共用 `app.ts` 里的同一个 limiter 实例，别实现成
 * 两个实例。
 *
 * 但**拆桶不是"不劈预算"**（PR#5 终轮评审 S1 更正：初稿这么写，与实测相反）。如实说：第 2/3
 * 层的额度是**每 (租户, 门) 一份**，故拆桶的代价是**聚合预算 ×门数**——每租户每分钟可写 audit
 * 的失败行数由 300 变 **600**（第 3 层 1000 变 **2000**），收益是**爆炸半径 ÷门数**（灌企微
 * 回调不再锁死账密路）。这是**有意的取舍**：只按租户合成一个跨门总闸，等于把 R1 那个"打一扇
 * 门即锁死两扇门"的缺陷原样复现，故不做。而第 1 层（单账号失败）**未**拆门，故"拆桶"严格
 * 优于"拆实例"（后者连第 1 层也一起放大，换不来任何额外收益）。
 *
 * 第 1 层（单账号失败）**不**分门：企微路本就没有用户名维度（spec §3.2），账密路的 user 桶
 * 保持 `(tenantId, username)` 不变。企微路的 record 一律传 username=null，天然不碰 user 桶。
 */
export type Door = 'password' | 'wecom'

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
 *
 * 导出用于让"同源"这条约束变成可执行断言（见 rate-limit.test.ts 的守卫用例）——注释不是
 * 约束，两个各写死的 256 会在无人报警的情况下漂移。
 */
export const MAX_KEY_LEN = 256

/** 桶键统一规范化：超长截断到 MAX_KEY_LEN（check 与 record 必须经此取键，否则两处键不一致） */
function keyOf(u: string): string {
  return u.length > MAX_KEY_LEN ? u.slice(0, MAX_KEY_LEN) : u
}

interface Counter {
  count: number
  resetAt: number
}

interface TenantState {
  /** 门 → 租户失败计数（第 2 层）。**按需造桶**：没失败过的门零成本 */
  fail: Partial<Record<Door, Counter>>
  /** 门 → 租户全部尝试计数（第 3 层） */
  attempt: Partial<Record<Door, Counter>>
  /** username → 失败计数（第 1 层，**不分门**）。**只在失败时创建**（成功直接删）——这是桶数有界的前提 */
  users: Map<string, Counter>
}

export interface LoginLimiter {
  /** 只读判定，不改状态（先查后记；被拒的请求不落账） */
  check(tenantId: number, door: Door, username: string | null): LimitDecision
  /** 判定之后按真实结果落账：ok ⇒ 清该用户失败桶；!ok ⇒ 失败桶 +1。两者都计入"全部尝试" */
  record(tenantId: number, door: Door, username: string | null, ok: boolean): void
  /** 当前租户的 user 失败桶数（"内存有界"唯一可观测的口子；将来也可喂运维指标） */
  bucketCount(tenantId: number): number
}

export function createLoginLimiter(opts: { now?: () => number } = {}): LoginLimiter {
  const now = opts.now ?? (() => Date.now())
  const tenants = new Map<number, TenantState>()

  const stateOf = (id: number): TenantState => {
    let s = tenants.get(id)
    if (!s) {
      s = { fail: {}, attempt: {}, users: new Map() }
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
    check(tenantId, door, username) {
      const t = now()
      const s = tenants.get(tenantId)
      if (!s) return { allowed: true } // 从没失败过的租户零成本放行
      // 第 2/3 层只看【本门】的桶：另一扇门被灌满不影响这一扇（PR#5 评审 R2）
      const att = live(s.attempt[door], t)
      if (att && att.count >= TENANT_ATTEMPT_LIMIT) return deny('tenant-all', att.resetAt, t)
      const f = live(s.fail[door], t)
      if (f && f.count >= TENANT_FAIL_LIMIT) return deny('tenant-fail', f.resetAt, t)
      if (username) {
        const u = live(s.users.get(keyOf(username)), t)
        if (u && u.count >= USER_FAIL_LIMIT) return deny('user', u.resetAt, t)
      }
      return { allowed: true }
    },

    record(tenantId, door, username, ok) {
      const t = now()
      const s = stateOf(tenantId)

      const att = live(s.attempt[door], t)
      if (att) att.count += 1
      else s.attempt[door] = { count: 1, resetAt: t + TENANT_ATTEMPT_WINDOW_MS }

      if (ok) {
        // 成功即清该用户的失败桶：否则正常用户会被自己的成功登录耗尽配额
        if (username) s.users.delete(keyOf(username))
        return
      }

      const f = live(s.fail[door], t)
      if (f) f.count += 1
      else s.fail[door] = { count: 1, resetAt: t + TENANT_FAIL_WINDOW_MS }

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
 * 被限速时的告警：**不写 audit**（写了等于没限速），改一行 warn 让攻击在容器日志 /
 * OpenObserve 里可见。
 *
 * 它与响应形状**分开**导出，是因为两扇门的呈现契约不同（PR#5 评审 R2）：账密路是 XHR，
 * JSON 429 正确；企微回调恒是浏览器导航，JSON 是用户死胡同 ⇒ 那条路由必须把限速也折叠进
 * 自己的 `fail()` 呈现。告警这一半两边都要，故从响应里拆出来单独调用。
 */
export function warnRateLimitDeny(tenantId: number, d: LimitDecision): void {
  console.warn(
    `[rate-limit] 拒绝登录尝试 tenant=${tenantId} 维度=${d.dimension} retry-after=${d.retryAfterSec}s`,
  )
}

/**
 * 账密路被限速时的统一响应：429 + Retry-After。错误体形状沿用既有 `{ error: string }`
 * 约定，前端无需改。**只用于 XHR 形态的调用方**（见上一条：企微回调不用它）。
 */
export function tooManyRequests<E extends Env>(
  c: Context<E>,
  tenantId: number,
  d: LimitDecision,
): Response {
  warnRateLimitDeny(tenantId, d)
  return c.json({ error: 'TOO_MANY_REQUESTS' }, 429, {
    'Retry-After': String(d.retryAfterSec ?? 60),
  })
}
