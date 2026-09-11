// 限速器自己的语义也要有测试——否则它给出的"挡住了"没有任何证据价值。
// 时钟注入：全部用例不碰真时间，窗口过期可被精确断言。
import { describe, expect, it } from 'vitest'
import {
  MAX_KEY_LEN,
  TENANT_ATTEMPT_LIMIT,
  TENANT_FAIL_LIMIT,
  USER_BUCKET_CAP,
  USER_FAIL_LIMIT,
  USER_FAIL_WINDOW_MS,
  createLoginLimiter,
} from './rate-limit'
// 常量同源守卫（建议改 2）：两侧都是"用户名长度上限"的投影，必须相等——用可执行断言替代
// 注释。从 routes/auth 导出而非写死 256，漂移即红（见文末两个用例）。
import { MAX_USERNAME_LEN } from './routes/auth'

describe('登录限速器（进程内存、租户内三层、不依赖客户端 IP）', () => {
  it('★ 负例：第 5 次失败后第 6 次被拒（user 维度），桶按用户名与租户隔离', () => {
    let t = 0
    const l = createLoginLimiter({ now: () => t })
    for (let i = 0; i < USER_FAIL_LIMIT; i++) {
      expect(l.check(1, 'password', 'alice').allowed).toBe(true)
      l.record(1, 'password', 'alice', false)
    }
    const d = l.check(1, 'password', 'alice')
    expect(d.allowed).toBe(false)
    expect(d.dimension).toBe('user')
    expect(d.retryAfterSec).toBeGreaterThan(0)
    // 同租户另一个用户名不受影响；另一个租户的同名用户也不受影响
    expect(l.check(1, 'password', 'bob').allowed).toBe(true)
    expect(l.check(2, 'password', 'alice').allowed).toBe(true)
  })

  it('成功即清零该用户失败桶（否则正常用户被自己的成功登录耗尽配额）', () => {
    let t = 0
    const l = createLoginLimiter({ now: () => t })
    for (let i = 0; i < USER_FAIL_LIMIT - 1; i++) l.record(1, 'password', 'alice', false)
    expect(l.check(1, 'password', 'alice').allowed).toBe(true)
    l.record(1, 'password', 'alice', true) // 成功
    for (let i = 0; i < USER_FAIL_LIMIT - 1; i++) l.record(1, 'password', 'alice', false)
    expect(l.check(1, 'password', 'alice').allowed).toBe(true) // 计数确实从 0 重来
  })

  it('窗口过期即复位（固定窗口：resetAt 到了就重算）', () => {
    let t = 0
    const l = createLoginLimiter({ now: () => t })
    for (let i = 0; i < USER_FAIL_LIMIT; i++) l.record(1, 'password', 'alice', false)
    expect(l.check(1, 'password', 'alice').allowed).toBe(false)
    t += USER_FAIL_WINDOW_MS // 恰好在窗口边界之后
    expect(l.check(1, 'password', 'alice').allowed).toBe(true)
  })

  it('租户失败总数：换用户名也拦得住（灌表威胁的真正闸门）', () => {
    let t = 0
    const l = createLoginLimiter({ now: () => t })
    for (let i = 0; i < TENANT_FAIL_LIMIT; i++) l.record(1, 'password', `u${i}`, false) // 每个用户名只失败一次
    const d = l.check(1, 'password', 'brand-new-user')
    expect(d.allowed).toBe(false)
    expect(d.dimension).toBe('tenant-fail')
    expect(l.check(2, 'password', 'brand-new-user').allowed).toBe(true) // 另一租户不受牵连
  })

  it('租户全部尝试：成功也计数（有效凭据刷成功路径同样被拦）', () => {
    let t = 0
    const l = createLoginLimiter({ now: () => t })
    const n = TENANT_ATTEMPT_LIMIT
    for (let i = 0; i < n; i++) l.record(1, 'password', `u${i}`, true) // 全成功
    const d = l.check(1, 'password', 'whoever')
    expect(d.allowed).toBe(false)
    expect(d.dimension).toBe('tenant-all')
    expect(l.check(2, 'password', 'whoever').allowed).toBe(true)
  })

  it('username=null（企微回调）：跳过 user 层，租户层照常生效', () => {
    let t = 0
    const l = createLoginLimiter({ now: () => t })
    for (let i = 0; i < USER_FAIL_LIMIT * 3; i++) l.record(1, 'wecom', null, false)
    expect(l.check(1, 'wecom', null).allowed).toBe(true) // user 层不适用 ⇒ 仍在阈值内
    for (let i = 0; i < TENANT_FAIL_LIMIT; i++) l.record(1, 'wecom', null, false)
    expect(l.check(1, 'wecom', null).allowed).toBe(false)
    expect(l.check(1, 'wecom', null).dimension).toBe('tenant-fail')
  })

  // PR#5 评审 R2（协调者裁定）：第 2/3 层的桶键是 **(tenantId, door)**，不再是 tenantId。
  // 反证：把 TenantState 的 fail/attempt 退回单桶（不分门）⇒ 下面三条"另一扇门"断言全红。
  // 路由层的等价断言见 routes/auth-wecom.test.ts 的「拆桶①②」（真 HTTP、真两扇门）。
  it('★ 拆桶：第 2/3 层按 (tenantId, door) 隔离——灌满一扇门不牵连另一扇，租户隔离不受影响', () => {
    const t = 0
    // ① 企微门灌满：账密门租户层照常
    const l = createLoginLimiter({ now: () => t })
    for (let i = 0; i < TENANT_FAIL_LIMIT; i++) l.record(1, 'wecom', null, false)
    expect(l.check(1, 'wecom', null)).toEqual(
      expect.objectContaining({ allowed: false, dimension: 'tenant-fail' }),
    )
    expect(l.check(1, 'password', 'alice').allowed).toBe(true)
    // ② 反向：账密门灌满，企微门照常
    const l2 = createLoginLimiter({ now: () => t })
    for (let i = 0; i < TENANT_FAIL_LIMIT; i++) l2.record(1, 'password', `u${i}`, false)
    expect(l2.check(1, 'password', 'fresh')).toEqual(
      expect.objectContaining({ allowed: false, dimension: 'tenant-fail' }),
    )
    expect(l2.check(1, 'wecom', null).allowed).toBe(true)
    // ③ 兜底闸（tenant-all）同样分门：全成功的流量也只在【本门】累计
    const l3 = createLoginLimiter({ now: () => t })
    for (let i = 0; i < TENANT_ATTEMPT_LIMIT; i++) l3.record(1, 'wecom', null, true)
    expect(l3.check(1, 'wecom', null)).toEqual(
      expect.objectContaining({ allowed: false, dimension: 'tenant-all' }),
    )
    expect(l3.check(1, 'password', 'whoever').allowed).toBe(true)
    // ④ 分门没有把【租户】隔离弄丢：另一租户照旧互不相干
    expect(l.check(2, 'password', 'alice').allowed).toBe(true)
  })

  it('check 是只读的：被拒的请求不 record 也不改状态（限速挡在 audit 之前的实现形态）', () => {
    let t = 0
    const l = createLoginLimiter({ now: () => t })
    for (let i = 0; i < USER_FAIL_LIMIT; i++) l.record(1, 'password', 'alice', false)
    for (let i = 0; i < 100; i++) expect(l.check(1, 'password', 'alice').allowed).toBe(false)
    t += USER_FAIL_WINDOW_MS
    expect(l.check(1, 'password', 'alice').allowed).toBe(true) // 100 次 check 没有延长窗口
  })

  it('桶数上限：慢速持续填充到上限后清扫过期桶，桶数回落到上限之下（内存不发散）', () => {
    // 填充方式是有讲究的：**必须按时间铺开**。瞬时灌 8000+ 条会先撞租户层
    // （TENANT_ATTEMPT_LIMIT 1000/分、TENANT_FAIL_LIMIT 300/分），根本走不到桶上限 ——
    // 那是"被租户层拦下"，不是本用例要测的"桶数有界"。
    let t = 0
    const l = createLoginLimiter({ now: () => t })
    for (let step = 0; step < 30; step++) {
      for (let i = 0; i < 299; i++) l.record(1, 'password', `u${step}-${i}`, false) // 每步 299 < 300，不触租户层
      t += 61_000 // 快进一个租户窗口
    }
    // 30 步 × 299 = 8970 个桶 > USER_BUCKET_CAP(8192) ⇒ 上限必然已被触达一次并清扫。
    // 断言"回落到上限之下"是有咬合力的：**删掉清扫实现，这里会红**（桶数会停在 ≥8192）。
    // 注意不能改断言成"最早的桶不在了"——过期桶本来就 live() 读作 0，那种断言删掉实现也照样绿。
    expect(l.bucketCount(1)).toBeLessThan(USER_BUCKET_CAP)

    t += 61_000 // 再清掉租户层的 60s 窗口，否则下面的 check 会被租户层拦
    for (let i = 0; i < USER_FAIL_LIMIT; i++) l.record(1, 'password', 'latest', false)
    expect(l.check(1, 'password', 'latest').allowed).toBe(false) // 新桶照常受 user 层约束
  })

  it('★ 键长有界：桶键在限速器内部截断到 MAX_KEY_LEN（check/record 同键，超长串不放大内存）', () => {
    let t = 0
    const l = createLoginLimiter({ now: () => t })
    const prefix = 'x'.repeat(MAX_KEY_LEN) // 引用常量而非写死长度：断言随常量走
    // 5 个仅在 MAX_KEY_LEN 位之后不同的超长用户名：截断后同键 ⇒ 落同一桶、累加到达阈值。
    // 反证：键不截断（raw username 直作 Map 键）时 5 个是 5 个独立桶，下面两条断言都会红
    // ——bucketCount 会是 5，且全新后缀仍被放行（未认证攻击者可造 8192×任意长键常驻内存）。
    for (const tail of ['A', 'B', 'C', 'D', 'E']) l.record(1, 'password', prefix + tail, false)
    expect(l.bucketCount(1)).toBe(1)
    expect(l.check(1, 'password', prefix + 'Z').allowed).toBe(false)
  })

  // 建议改 1：旧用例只证明"存在截断"，把 MAX_KEY_LEN 改成 8 仍全绿（常量漂到危险值也不红）。
  // 这两条边界断言钉住截断点恰在 MAX_KEY_LEN：恰好 MAX_KEY_LEN 不截断、+1 起才截断。
  // 反证：截断点写成 MAX_KEY_LEN-1（或任何 off-by-one）⇒ 第一段红；写成 MAX_KEY_LEN+1 ⇒ 第二段红。
  it('★ 截断边界：长度 255 与 256 落两个桶（未截断），256 与 257 落同一个桶（257 截断到 256）', () => {
    const under = 'a'.repeat(MAX_KEY_LEN - 1) // 255：未截断
    const at = 'a'.repeat(MAX_KEY_LEN) // 256：未截断（截断条件是 length > MAX_KEY_LEN）
    const over = 'a'.repeat(MAX_KEY_LEN + 1) // 257：截断到前 MAX_KEY_LEN 位 ⇒ 与 at 同键

    {
      let t = 0
      const l = createLoginLimiter({ now: () => t })
      l.record(1, 'password', under, false)
      l.record(1, 'password', at, false)
      expect(l.bucketCount(1)).toBe(2) // 255 ≠ 256：两个不同的未截断键
    }
    {
      let t = 0
      const l = createLoginLimiter({ now: () => t })
      l.record(1, 'password', at, false)
      l.record(1, 'password', over, false)
      expect(l.bucketCount(1)).toBe(1) // 256 = 257.slice(0,256)：同一个截断键
    }
  })

  // 建议改 2：两个常量各自写死 256，只有注释声明"同源…必须同步"——注释不是约束。这条守卫把
  // 它变成可执行断言：把任一侧改成 512（或把 MAX_KEY_LEN 改成 8）这里即红。
  it('★ 常量同源：MAX_KEY_LEN 与 routes/auth.ts 的 MAX_USERNAME_LEN 相等（防两侧静默漂移）', () => {
    expect(MAX_USERNAME_LEN).toBe(MAX_KEY_LEN)
  })
})
