// cred-crypto.test.ts — 渠道凭据加密（spec 2026-10-31 §3.2）
//
// 断言的是**失败可见**：KEK 缺失要抛、密文被改要抛、长度异常要抛。
// 静默返回空串会把「凭据坏了」伪装成「凭据是空的」——两者处置完全不同。
import { describe, it, expect } from 'vitest'
import { decryptSecret, encryptSecret, kekFromEnv } from './cred-crypto'

const KEK = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

describe('cred-crypto', () => {
  it('加解密往返', () => {
    const kek = Buffer.from(KEK, 'hex')
    const enc = encryptSecret('s3cr3t-企微', kek)
    expect(enc).not.toContain('s3cr3t')
    expect(decryptSecret(enc, kek)).toBe('s3cr3t-企微')
  })

  it('同一明文两次加密结果不同（随机 IV）', () => {
    const kek = Buffer.from(KEK, 'hex')
    expect(encryptSecret('x', kek)).not.toBe(encryptSecret('x', kek))
  })

  it('★ KEK 不对 ⇒ 抛错（GCM 认证失败，不返回垃圾）', () => {
    const enc = encryptSecret('x', Buffer.from(KEK, 'hex'))
    expect(() => decryptSecret(enc, Buffer.from(OTHER, 'hex'))).toThrow()
  })

  it('★ 密文被篡改 ⇒ 抛错', () => {
    const kek = Buffer.from(KEK, 'hex')
    const buf = Buffer.from(encryptSecret('hello', kek), 'base64')
    buf[buf.length - 1] ^= 0xff
    expect(() => decryptSecret(buf.toString('base64'), kek)).toThrow()
  })

  it('★ KEK 未配置/格式不对 ⇒ 抛错（fail-closed，绝不降级明文）', () => {
    expect(() => kekFromEnv({})).toThrow(/NOTIFY_CRED_KEK/)
    expect(() => kekFromEnv({ NOTIFY_CRED_KEK: 'short' })).toThrow(/NOTIFY_CRED_KEK/)
    expect(kekFromEnv({ NOTIFY_CRED_KEK: KEK }).length).toBe(32)
  })
})
