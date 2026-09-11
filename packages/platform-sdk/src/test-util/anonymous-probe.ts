// anonymous-probe.ts — 匿名探测：对 router 的每条已注册路由发一个【无 identity】的请求，
// 断言它被门卫拦下（401）。它测的是"门卫真的生效"这件事本身，而非"代码里写了 requireScope"
// ——与 M1 闭债 R1 的教训一致：断言必须真跑。
import type { Hono } from 'hono'

export interface AnonymousProbeResult {
  method: string
  path: string
  status: number
}

/**
 * 探测 router 的每条【已注册路由】的匿名可达性，返回每条的实测状态码。
 *
 * **`method === 'ALL'` 的条目不能被跳过**（Task 24 评审 R1）：Hono 里 `app.all('/secret', h)`
 * 与 `app.use('/backdoor', 终结 handler)` 同样记为 `'ALL'`（hono-base.js 的
 * `#addRoute(METHOD_NAME_ALL, …)`），它们是**端点**而非中间件。旧实现用
 * `filter(r => r.method !== 'ALL')` 把它们整条滤掉，与装载器 `applyDeclaredApiGate` 的过滤
 * 条件**逐字相同** —— 两边共享同一个盲区，于是"每条路由都不可匿名到达"这条回归网对 ALL 形态
 * 结构性地看不见（实测：装载器放行的 `app.all('/secret')` 匿名 200，探测网全绿）。
 *
 * ALL 条目没有单一 method 可发，用 GET 代表（可命中的最小代价请求；Hono 对 ALL 路由的匹配
 * 与具体 method 无关，非 GET 的漏网形态由路由层自己的用例覆盖）。结果里的 `method` 原样回
 * `'ALL'`，调用方据此区分"这是一个多方法端点"。
 *
 * 路径参数（/notes/:id）与通配段（*）替换为占位段后再请求（'：' 与 '*' 段换成 'probe'）。
 */
export async function probeAnonymous(router: Hono): Promise<AnonymousProbeResult[]> {
  const routes = router.routes
  const out: AnonymousProbeResult[] = []
  for (const r of routes) {
    const realPath = r.path.replace(/[:*][^/]*/g, 'probe')
    const res = await router.request(realPath, { method: r.method === 'ALL' ? 'GET' : r.method })
    out.push({ method: r.method, path: r.path, status: res.status })
  }
  return out
}
