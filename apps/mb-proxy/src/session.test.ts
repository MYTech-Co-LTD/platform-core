import { describe, expect, it } from 'vitest'
import { EDIT_COOKIE, clearEditCookie, serializeEditCookie } from './session'

describe('mb_edit Cookie 序列化', () => {
  it('host-only + HttpOnly + Secure + SameSite=Lax（**不设 Domain**——不扩散到兄弟子域）', () => {
    const s = serializeEditCookie('tok')
    expect(s).toBe(`${EDIT_COOKIE}=tok; Path=/; Max-Age=28800; HttpOnly; Secure; SameSite=Lax`)
    expect(s).not.toMatch(/Domain=/i)
  })
  it('清除版 Max-Age=0', () => {
    expect(clearEditCookie()).toContain('Max-Age=0')
  })
})
