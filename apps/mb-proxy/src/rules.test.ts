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
  // 壳/静态是**读**面：HEAD 按读算（Hono 把 HEAD 派发给 GET，本项目 AGENTS.md 硬约束 4）
  ['HEAD', '/'],
  ['HEAD', '/app/dist/main.js'],
  ['HEAD', '/api/session/properties'],
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
  // ⑤ **归一化收口**（订正记录 2026-09-29，评审实测）：这些路径的**原始串都满足 `/app/` 前缀**，
  //    只折精确 `..` 段是拦不住的 —— 拦截发生在**归一化那一层**（`normalizePath` ⇒ null）。
  //    ⚠️ 故本列断言走 `gate()`（归一化 → decide，与中间件同构）。**若照字面把本列喂给裸 `decide`**：
  //    这几条实测返回 **allow**（`/app/` 前缀命中）⇒ 断言会**恒红（测试直接失败）**，不是恒绿。
  //    更要命的是：`decide` **不做归一化** ⇒ 放宽 `SEG_RE` 这个变异**不会**让任何裸-decide 断言变红，
  //    收口破没破就再也测不出来。本列必须走 `gate()`，理由在这两处，别把它们当成等价写法。
  ['GET', '/app/..%2f..%2fapi/search'],      // 编码分隔符（实施轮已修）
  ['GET', '/app/..;/api/search'],            // `;`（Jetty 的 path-param canonicalization 不可控）
  ['GET', '/app/..%3b..%3bapi/search'],      // `%3b` = `;`（decodeURI 不解保留字 ⇒ 原样到达）
  ['GET', '/app/..%20/api/search'],          // 空白
  ['GET', '/app/..%00/api/search'],          // NUL
  // ⑥ dashcard 路径的**卡片归属**（订正记录 ②）：did 对但 cid 不在本 dashboard 的卡片集合里
  ['GET', `/api/dashboard/${ctx.did}/dashcard/3/card/999/query`],
  // ⑦ 壳/静态**只读**（订正记录 2026-09-29 评审轮 Minor ①）：写方法一律不放行
  ['PUT', '/app/dist/main.js'],
  ['DELETE', '/static/app-main.js'],
  ['PUT', '/api/session/properties'],
  ['POST', '/api/session/properties'],
  ['DELETE', `/dashboard/${ctx.did}`],
  ['PUT', `/api/dashboard/${ctx.did}`],
  // ⑧ 取舍：**含白名单外字符的路径一律拒**（含 `%`）——合法路径里几乎不出现，
  //    换来的是「上游 canonicalization 不再是我方安全的依赖」
  ['GET', '/app/dist/main%20.js'],
] as const

/** 与 `app.ts` 的中间件链**同构**：先归一化（归不了 ⇒ 直接 deny），再进规则表。 */
const gate = (p: string, m: string): 'allow' | 'deny' => {
  const n = normalizePath(p)
  return n === null ? 'deny' : decide(n, m, ctx)
}

describe('deny-by-default 规则表', () => {
  it.each(allowed)('放行 %s %s', (m, p) => expect(gate(p, m)).toBe('allow'))
  it.each(denied)('拒绝 %s %s', (m, p) => expect(gate(p, m)).toBe('deny'))
  it('未知路径一律 deny（兜底）', () => {
    expect(gate('/whatever/unknown', 'GET')).toBe('deny')
  })
})

// —— 归一化层（brief 未列；**加它的理由**见 rules.ts 头注：不加这条，`/app/..%2f..%2fapi/search`
//    一类路径会命中 `/app/` 前缀被**放行**，上游再 canonicalize 一次就成枚举面。
//    即上面那张放行表要真的成立，必须先归一化收口。）——
describe('★ 路径归一化（判的路径必须与上行的路径同源）', () => {
  it('放行面里的正常路径：归一化是恒等（不误伤）', () => {
    for (const p of ['/', '/index.html', '/favicon.ico', '/api/session/properties',
      '/app/dist/main.js', '/static/app-main.js', '/assets/x.css',
      '/dashboard/7', '/api/dashboard/7', '/api/dashboard/7/dashcard/3/card/70/query',
      '/api/card/70/query']) {
      expect(normalizePath(p), p).toBe(p)
    }
  })

  it('段白名单是唯一判据：`;` / 编码 `%` / 空白 / NUL / 非 ASCII 任一出现 ⇒ 整条 null', () => {
    // ⚠️ 这几条**不是**「折掉 `..` 就好了」的那类：它们的 `..` 后面挂着别的字符，
    //    只折精确 `..` 段时它们会**原样通过**（实测原串都满足 `/app/` 前缀）。
    for (const p of [
      '/app/..;/api/search', '/app/..%3b..%3bapi/search', '/app/..%20/api/search',
      '/app/..%00/api/search', '/app/..%2f..%2fapi/search', '/app/..%5c..%5capi/search',
      '/app/dist%2fmain.js', '/app/dist/main%20.js', '/app/x%00.js', '/app/中文.js', '/a%zz',
    ]) {
      expect(normalizePath(p), p).toBeNull()
    }
  })

  it('精确的 `.` / `..` 段照常归约（栈式）', () => {
    expect(normalizePath('/app/../api/search')).toBe('/api/search')
    expect(normalizePath('/dashboard/7/../../api/search')).toBe('/api/search')
    expect(normalizePath('/app/./dist/./x.js')).toBe('/app/dist/x.js')
    expect(normalizePath('/app/dist//x.js')).toBe('/app/dist/x.js')   // 空段跳过
    expect(normalizePath('/')).toBe('/')
  })

  it('栈空还弹 ⇒ null（`/..` 不许逃到根以外）', () => {
    expect(normalizePath('/..')).toBeNull()
    expect(normalizePath('/../x')).toBeNull()
    expect(normalizePath('/app/../../x')).toBeNull()
  })

  it('`...` / `..x` 是**普通段**、不是上跳（不误判）', () => {
    // `.`/`..` 之外的点开头段按字面量走白名单（点本身在白名单里）——避免「见了点就紧张」的假拒
    expect(normalizePath('/app/.../x')).toBe('/app/.../x')
    expect(normalizePath('/app/..x/y')).toBe('/app/..x/y')
  })
})
