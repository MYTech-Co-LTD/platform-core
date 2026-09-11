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
 * 探测 router 的每条【非中间件】路由（method !== 'ALL'）的匿名可达性。
 * 返回每条的实测状态码，由调用方断言（通常：全部 === 401）。
 * 路径参数（/notes/:id）替换为占位段后再请求（'：' 与 '*' 段换成 'probe'）。
 */
export async function probeAnonymous(router: Hono): Promise<AnonymousProbeResult[]> {
  const routes = router.routes.filter((r) => r.method !== 'ALL')
  const out: AnonymousProbeResult[] = []
  for (const r of routes) {
    const realPath = r.path.replace(/[:*][^/]*/g, 'probe')
    const res = await router.request(realPath, { method: r.method })
    out.push({ method: r.method, path: r.path, status: res.status })
  }
  return out
}
