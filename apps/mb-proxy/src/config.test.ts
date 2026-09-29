// config.test.ts — env 契约的**形状**校验（订正记录 2026-09-29，Task 4 评审轮）。
//
// 为什么 `MB_PROXY_CONSOLE_ORIGIN` 值得单测：它是 CSP `frame-ancestors` 的**唯一**来源，
// 而本代理同时又剥掉了上游的 `X-Frame-Options` ⇒ 这个值配错的后果是「CSP 失效 + XFO 已剥」，
// 即**任意站点都能 iframe 编辑页**，且线上完全静默（不报错、不告警）。故必须在启动期就拒掉。
import { describe, expect, it } from 'vitest'
import { loadProxyConfig } from './config'

const base: Record<string, string> = {
  PORT: '13010',
  PLATFORM_SESSION_SECRET: 'test-secret-test-secret-test-secret!',
  MB_PROXY_CONSOLE_ORIGIN: 'https://console.example',
  // 尾斜杠是历史写法，归一后必须与不带斜杠等价
  DATA_METABASE_URL: 'https://mb.example/',
  DATA_METABASE_API_KEY: 'upstream-key',
}

describe('loadProxyConfig：MB_PROXY_CONSOLE_ORIGIN 的形状', () => {
  it('合法值：原样收下（upstreamUrl 去掉尾斜杠）', () => {
    const cfg = loadProxyConfig({ ...base })
    expect(cfg.consoleOrigin).toBe('https://console.example')
    expect(cfg.upstreamUrl).toBe('https://mb.example')
    expect(cfg.port).toBe(13010)
  })

  it('尾斜杠归一：`https://a.example/` 与 `https://a.example` 等价（CSP 值不能带斜杠）', () => {
    expect(loadProxyConfig({ ...base, MB_PROXY_CONSOLE_ORIGIN: 'https://a.example/' }).consoleOrigin)
      .toBe('https://a.example')
    expect(loadProxyConfig({ ...base, MB_PROXY_CONSOLE_ORIGIN: 'https://a.example///' }).consoleOrigin)
      .toBe('https://a.example')
  })

  const bad: [label: string, value: string][] = [
    ['http://（非 https）', 'http://console.example'],
    ['没有 scheme', 'console.example'],
    ['通配 `*`（等价于「谁来都能嵌」）', '*'],
    ['空串（缺必填）', ''],
    ['看着像 origin 但带路径', '/console'],
  ]

  it.each(bad)('%s ⇒ 启动期抛（fail-closed，不放它进运行态）', (_label, value) => {
    expect(() => loadProxyConfig({ ...base, MB_PROXY_CONSOLE_ORIGIN: value })).toThrow()
  })

  it('正向对照：把校验拿掉会怎样——`https://x.example` 这类**恰好**合法的不受影响', () => {
    // 防「校验写成恒真」的哨兵：合法值必须**通过**，否则上面的 it.each 可能是被别的错拒的
    expect(loadProxyConfig({ ...base, MB_PROXY_CONSOLE_ORIGIN: 'https://x.example' }).consoleOrigin)
      .toBe('https://x.example')
  })

  it('其它必填项缺失仍在启动期抛（原有口径未回退）', () => {
    expect(() => loadProxyConfig({ ...base, PORT: '' })).toThrow()
    expect(() => loadProxyConfig({ ...base, PLATFORM_SESSION_SECRET: 'short' })).toThrow()
    expect(() => loadProxyConfig({ ...base, DATA_METABASE_API_KEY: '' })).toThrow()
  })
})
