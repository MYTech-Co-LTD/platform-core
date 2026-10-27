// net-guard.test.ts — webhook 出站 URL 守卫（纯函数）
import { describe, it, expect } from 'vitest'
import { assertSafeWebhookUrl, isForbiddenHost } from './net-guard'

describe('assertSafeWebhookUrl', () => {
  it('https + 公网主机通过', () => {
    const r = assertSafeWebhookUrl('https://hooks.example.com/notify')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.url.hostname).toBe('hooks.example.com')
  })

  it('http / 非 http(s) / 带用户信息 / 非法 URL 一律拒绝', () => {
    expect(assertSafeWebhookUrl('http://hooks.example.com/x'))
      .toMatchObject({ ok: false, reason: 'not_https' })
    expect(assertSafeWebhookUrl('ftp://hooks.example.com/x'))
      .toMatchObject({ ok: false, reason: 'not_https' })
    expect(assertSafeWebhookUrl('https://user:pw@hooks.example.com/x'))
      .toMatchObject({ ok: false, reason: 'credentials_in_url' })
    expect(assertSafeWebhookUrl('not a url'))
      .toMatchObject({ ok: false, reason: 'invalid_url' })
  })

  it('私网 / 回环 / 链路本地 / 元数据 / .local / 单标签主机拒绝', () => {
    for (const h of [
      '127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.1.1', '169.254.169.254',
      '::1', 'localhost', 'metadata.google.internal', 'internal', 'svc.local',
    ]) {
      expect(isForbiddenHost(h), h).toBe(true)
    }
    for (const h of ['8.8.8.8', 'hooks.example.com']) {
      expect(isForbiddenHost(h), h).toBe(false)
    }
  })

  it('IP 字面量形式的 URL 也走同一守卫', () => {
    expect(assertSafeWebhookUrl('https://169.254.169.254/latest/meta-data'))
      .toMatchObject({ ok: false, reason: 'forbidden_host' })
    expect(assertSafeWebhookUrl('https://8.8.8.8/hook')).toMatchObject({ ok: true })
  })
})
