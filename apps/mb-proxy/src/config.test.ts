// config.test.ts — env 契约的**形状**校验（订正记录 2026-09-29，Task 4 评审轮）。
//
// 为什么 `MB_PROXY_CONSOLE_ORIGIN` 值得单测：它是 CSP `frame-ancestors` 的**唯一**来源，
// 而本代理同时又剥掉了上游的 `X-Frame-Options` ⇒ 这个值配错的后果是「CSP 失效 + XFO 已剥」，
// 即**任意站点都能 iframe 编辑页**，且线上完全静默（不报错、不告警）。故必须在启动期就拒掉。
//
// **校验口径（与实现逐字一致，别把标签写成超出实际的保证）**：只许 `https://<host[:port]>`
// —— scheme 必须是 `https`，且整个值必须**恰好是一个 origin**（无路径 / 无查询 / 无片段 / 无凭据），
// 末尾斜杠先归一。返回的是规范化的 `origin`。
// ⚠️ 用例按**臂**分组（scheme 臂 / 解析臂 / 「只许 origin」臂）：带路径的用例必须是**带 scheme** 的
// `https://console.example/path`——拿没有 scheme 的 `/console` 当「带路径」的证据是**假证据**
// （它红在 scheme 臂，压根没走到「只许 origin」那条判据）。
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

  it('合法值：带端口；带大写/尾斜杠的写法归一成规范 origin', () => {
    expect(loadProxyConfig({ ...base, MB_PROXY_CONSOLE_ORIGIN: 'https://console.example:8443' }).consoleOrigin)
      .toBe('https://console.example:8443')
    // 大小写归一：CSP 值必须是规范形式（host 小写）
    expect(loadProxyConfig({ ...base, MB_PROXY_CONSOLE_ORIGIN: 'https://Console.Example/' }).consoleOrigin)
      .toBe('https://console.example')
  })

  it('尾斜杠归一：`https://a.example/` 与 `https://a.example` 等价（CSP 值不能带斜杠）', () => {
    expect(loadProxyConfig({ ...base, MB_PROXY_CONSOLE_ORIGIN: 'https://a.example/' }).consoleOrigin)
      .toBe('https://a.example')
    expect(loadProxyConfig({ ...base, MB_PROXY_CONSOLE_ORIGIN: 'https://a.example///' }).consoleOrigin)
      .toBe('https://a.example')
  })

  const bad: [label: string, value: string][] = [
    // —— scheme 臂 ——
    ['http://（非 https）', 'http://console.example'],
    ['没有 scheme', 'console.example'],
    ['相对路径（连 scheme 都没有）', '/console'],
    // —— 解析臂 ——
    ['通配 `*`（等价于「谁来都能嵌」）', '*'],
    ['空串（缺必填）', ''],
    // —— 「只许 origin」臂（**这几条**才是「带路径/查询/片段」的用例；上面 `/console` 红在 scheme 臂，
    //    别拿它当这一臂的证据）——
    ['带路径（`https://console.example/path`）', 'https://console.example/path'],
    ['带查询（`?x=1`）', 'https://console.example?x=1'],
    ['带片段（`#f`）', 'https://console.example#f'],
    ['带凭据（`user:pass@`）', 'https://user:pass@console.example'],
  ]

  it.each(bad)('%s ⇒ 启动期抛（fail-closed，不放它进运行态）', (_label, value) => {
    expect(() => loadProxyConfig({ ...base, MB_PROXY_CONSOLE_ORIGIN: value })).toThrow()
  })

  it('正向对照（哨兵）：合法值必须**通过**，否则上面的 it.each 可能是被别的错拒的', () => {
    expect(loadProxyConfig({ ...base, MB_PROXY_CONSOLE_ORIGIN: 'https://x.example' }).consoleOrigin)
      .toBe('https://x.example')
  })

  it('其它必填项缺失仍在启动期抛（原有口径未回退）', () => {
    expect(() => loadProxyConfig({ ...base, PORT: '' })).toThrow()
    expect(() => loadProxyConfig({ ...base, PLATFORM_SESSION_SECRET: 'short' })).toThrow()
    expect(() => loadProxyConfig({ ...base, DATA_METABASE_API_KEY: '' })).toThrow()
  })
})
