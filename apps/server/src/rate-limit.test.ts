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

  it('桶数上限：慢速持续填充到上限后清扫过期桶，桶数回落到上限之下（内存不发散）', () => {
    // 填充方式是有讲究的：**必须按时间铺开**。瞬时灌 8000+ 条会先撞租户层
    // （TENANT_ATTEMPT_LIMIT 1000/分、TENANT_FAIL_LIMIT 300/分），根本走不到桶上限 ——
    // 那是"被租户层拦下"，不是本用例要测的"桶数有界"。
    let t = 0
    const l = createLoginLimiter({ now: () => t })
    for (let step = 0; step < 30; step++) {
      for (let i = 0; i < 299; i++) l.record(1, `u${step}-${i}`, false) // 每步 299 < 300，不触租户层
      t += 61_000 // 快进一个租户窗口
    }
    // 30 步 × 299 = 8970 个桶 > USER_BUCKET_CAP(8192) ⇒ 上限必然已被触达一次并清扫。
    // 断言"回落到上限之下"是有咬合力的：**删掉清扫实现，这里会红**（桶数会停在 ≥8192）。
    // 注意不能改断言成"最早的桶不在了"——过期桶本来就 live() 读作 0，那种断言删掉实现也照样绿。
    expect(l.bucketCount(1)).toBeLessThan(USER_BUCKET_CAP)

    t += 61_000 // 再清掉租户层的 60s 窗口，否则下面的 check 会被租户层拦
    for (let i = 0; i < USER_FAIL_LIMIT; i++) l.record(1, 'latest', false)
    expect(l.check(1, 'latest').allowed).toBe(false) // 新桶照常受 user 层约束
  })

  it('★ 键长有界：桶键在限速器内部截断到 256（check/record 同键，超长串不放大内存）', () => {
    let t = 0
    const l = createLoginLimiter({ now: () => t })
    const prefix = 'x'.repeat(256) // 与 routes/auth.ts 的 MAX_USERNAME_LEN 同值（同源投影）
    // 5 个仅在第 256 位之后不同的超长用户名：截断后同键 ⇒ 落同一桶、累加到达阈值。
    // 反证：键不截断（raw username 直作 Map 键）时 5 个是 5 个独立桶，下面两条断言都会红
    // ——bucketCount 会是 5，且全新后缀仍被放行（未认证攻击者可造 8192×任意长键常驻内存）。
    for (const tail of ['A', 'B', 'C', 'D', 'E']) l.record(1, prefix + tail, false)
    expect(l.bucketCount(1)).toBe(1)
    expect(l.check(1, prefix + 'Z').allowed).toBe(false)
  })
})
