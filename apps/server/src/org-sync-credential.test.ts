// org-sync-credential.test.ts — 同步凭据选择的单一实现（issue #1819）。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { syncCredential } from './org-sync-credential'

const tenant = (over: Partial<Parameters<typeof syncCredential>[0]> = {}) => ({
  casdoor_org: 'shanhaiyiguo-org',
  wecom_corp_id: 'ww-corp',
  wecom_secret: 'tenant-secret',
  ...over,
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('syncCredential', () => {
  it('★ env 覆盖优先：WECOM_SYNC_SECRET__<ORG> 存在时用它（独立通讯录应用）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = syncCredential(tenant(), { WECOM_SYNC_SECRET__SHANHAIYIGUO_ORG: 'override-secret' })
    expect(r).toEqual({ corpId: 'ww-corp', secret: 'override-secret' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('★ 回落租户 secret，且打 warn 点名应配的 env 键（不静默）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = syncCredential(tenant(), {})
    expect(r).toEqual({ corpId: 'ww-corp', secret: 'tenant-secret' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('WECOM_SYNC_SECRET__SHANHAIYIGUO_ORG')
  })

  it('★ org 名里的非字母数字归一成下划线（环境变量键合法化）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = syncCredential(tenant({ casdoor_org: 'a-b.c' }), { WECOM_SYNC_SECRET__A_B_C: 's' })
    expect(r.secret).toBe('s')
    expect(warn).not.toHaveBeenCalled()
  })

  it('★ 无任何配置 ⇒ 空值（调用方据此跳过，不猜测）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = syncCredential(
      tenant({ wecom_corp_id: null, wecom_secret: null }),
      {},
    )
    expect(r).toEqual({ corpId: '', secret: '' })
  })
})
