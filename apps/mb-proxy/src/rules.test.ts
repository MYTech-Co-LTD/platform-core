import { describe, expect, it } from 'vitest'
import { decide, normalizePath } from './rules'

const ctx = { did: 7, cards: new Set([70, 71]) }
const allowed = [
  ['GET', '/'],
  ['GET', '/favicon.ico'],
  ['GET', '/app/dist/main.js'],
  ['GET', '/static/app-main.js'],
  ['GET', `/dashboard/${ctx.did}`],
  ['GET', `/api/dashboard/${ctx.did}`],
  ['GET', `/api/dashboard/${ctx.did}/dashcard/3/card/70/query`],
  ['POST', `/api/card/70/query`],
  ['GET', '/api/session/properties'],
] as const
const denied = [
  // ① 枚举面（spec §3⑦ ③：封掉「列出全站」的口子）
  ['GET', '/api/search'],
  ['GET', '/api/collection/1/items'],
  ['GET', '/api/collection/root/items'],
  ['GET', '/api/table'],
  ['GET', '/api/database'],
  ['GET', '/api/user'],
  ['GET', '/api/setting'],
  ['GET', '/api/permissions/group'],
  // ② 任意查询面（「用编辑页自己写 SQL 查任意数据」的口子）
  ['POST', '/api/dataset'],
  ['POST', '/api/dataset/csv'],
  // ③ 别的对象（本票据只授权这一张）
  ['GET', '/dashboard/8'],
  ['GET', '/api/dashboard/8'],
  ['GET', '/question/99'],
  ['GET', '/api/card/99/query'],
  ['GET', '/api/card/70'],          // 卡片**内容**面：只放行它的 query，不放行卡片本身（避免改查询）
  // ④ 页面壳也要判（非白名单路径一律拒）
  ['GET', '/collection/1'],
  ['GET', '/admin/settings'],
] as const

describe('deny-by-default 规则表', () => {
  it.each(allowed)('放行 %s %s', (m, p) => expect(decide(p, m, ctx)).toBe('allow'))
  it.each(denied)('拒绝 %s %s', (m, p) => expect(decide(p, m, ctx)).toBe('deny'))
  it('未知路径一律 deny（兜底）', () => {
    expect(decide('/whatever/unknown', 'GET', ctx)).toBe('deny')
  })
})

// —— 归一化层（brief 未列；**加它的理由**见 rules.ts `normalizePath` 头注：不加这条，
//    `/app/..%2f..%2fapi/search` 会命中 `/app/` 前缀被**放行**，上游再解一层 `%2f` 就成枚举面。
//    即上面那张放行表要真的成立，必须先归一化。）——
describe('★ 路径归一化（判的路径必须与上行的路径同源）', () => {
  it('放行面里的正常路径：归一化是恒等（不误伤）', () => {
    for (const p of ['/', '/index.html', '/favicon.ico', '/api/session/properties',
      '/app/dist/main.js', '/static/app-main.js', '/assets/x.css',
      '/dashboard/7', '/api/dashboard/7', '/api/dashboard/7/dashcard/3/card/70/query']) {
      expect(normalizePath(p), p).toBe(p)
    }
  })

  it('★ 封掉编码分隔符绕过：`%2f` 解出来再判定 ⇒ 落回枚举面', () => {
    // 这是空转测试会漏掉的那条：Hono 的 c.req.path 不解 `%2f`（decodeURI），原样带 `/app/` 前缀
    expect(normalizePath('/app/..%2f..%2fapi/search')).toBe('/api/search')
    expect(decide(normalizePath('/app/..%2f..%2fapi/search') ?? '/', 'GET', ctx)).toBe('deny')
    // 嵌套一层编码（`%252f`）同样要解开
    expect(normalizePath('/app/..%252f..%252fapi/search')).toBe('/api/search')
    // 反斜杠也是分隔符（WHATWG 特殊 scheme）
    expect(normalizePath('/app/..%5c..%5capi/search')).toBe('/api/search')
    // 大小写不同的转义一视同仁
    expect(normalizePath('/app/..%2F..%2Fapi/search')).toBe('/api/search')
  })

  it('字面量 `..` 段也折掉（不能靠上游替我们折）', () => {
    expect(normalizePath('/app/../api/search')).toBe('/api/search')
    expect(normalizePath('/dashboard/7/../../api/search')).toBe('/api/search')
  })

  it('不可信 ⇒ null（调用方 deny）：畸形转义 / 解不干净 / 相对路径', () => {
    expect(normalizePath('/a%zz')).toBeNull()
    expect(normalizePath('/a%')).toBeNull()
    // 4 轮解不完的深层嵌套
    expect(normalizePath('/app/..%252525252f..%252525252fapi/search')).toBeNull()
    expect(normalizePath('dashboard/7')).toBeNull()
    expect(normalizePath('')).toBeNull()
  })
})
