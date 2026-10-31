// resolve-address.test.ts — 「收件人 → 渠道地址」的唯一实现（spec 2026-10-31 §3.3）
//
// 这些断言守的是**顺序**，不是某一条分支：显式解析优先、兜底只在显式失败且开关打开时生效、
// 兜底必须留下可 grep 的痕迹（否则「还在靠猜发消息」无人知晓）。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { resolveDeliveryAddress } from './resolve-address'

const wecom = (config: Record<string, unknown> = {}) => ({ provider: 'wecom_chat', config })
const inapp = { provider: 'in_app', config: {} }

afterEach(() => { vi.restoreAllMocks() })

describe('resolveDeliveryAddress', () => {
  it('★ 显式解析命中 ⇒ 用它，**不走兜底**（即使开关打开）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await resolveDeliveryAddress(
      async () => 'wecom-real-id',
      wecom({ address_fallback: 'casdoor_name' }),
      { org: 'o', casdoorName: '张三' },
    )
    expect(r).toBe('wecom-real-id')
    expect(warn).not.toHaveBeenCalled()
  })

  it('★ 显式失败 + 开关打开 ⇒ 兜底用名字，并打 `address_fallback_used`', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await resolveDeliveryAddress(
      async () => null,
      wecom({ address_fallback: 'casdoor_name' }),
      { org: 'o', casdoorName: 'yangwei' },
    )
    expect(r).toBe('yangwei')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('address_fallback_used')
  })

  it('★ 开关关闭（缺省 none）⇒ 不兜底，返回 null（调用方落 missing_channel_address）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await resolveDeliveryAddress(async () => null, wecom(), { org: 'o', casdoorName: 'x' })).toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })

  it('兜底只对企微生效：其它 provider 即使配了同样开关也不猜', async () => {
    const r = await resolveDeliveryAddress(
      async () => null,
      { provider: 'webhook', config: { address_fallback: 'casdoor_name' } },
      { org: 'o', casdoorName: 'x' },
    )
    expect(r).toBeNull()
  })

  it('in_app：解析器缺省也拿得到（地址就是用户名，不经过渠道）', async () => {
    expect(await resolveDeliveryAddress(undefined, inapp, { org: 'o', casdoorName: 'u1' })).toBe('u1')
  })

  it('没有解析器（未注入）⇒ 显式段为空，按兜底/失败处理', async () => {
    expect(await resolveDeliveryAddress(undefined, wecom(), { org: 'o', casdoorName: 'x' })).toBeNull()
    expect(await resolveDeliveryAddress(undefined, wecom({ address_fallback: 'casdoor_name' }), { org: 'o', casdoorName: 'x' })).toBe('x')
  })
})
