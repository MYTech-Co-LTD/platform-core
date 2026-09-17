// app.test.ts — 宿主装配（Task 16）：启动期 fail-fast 传播 + /api/* 全局请求体上限。
//
// ① fail-fast：runbook「已知陷阱 2」与 spec §3.4 的机检面——**某个租户 org 的
//    upsertPermission 抛错 ⇒ 原样上抛 ⇒ 宿主起不来**（"启动期连不上 Casdoor 就起不来"）。
//    这条契约全仓只有这里直接断言：loader.test.ts 的用例只覆盖 happy path / 零租户 / 无工厂
//    三个分支，没有一条断言 upsert 失败会上抛；smoke 只跑可达 mock 的绿路径。
// ② 请求体上限：全局中间件挂在 buildApp 内部，auth.test.ts 那种手搭 makeApp 不含它 ⇒
//    必须走真装配才测得到「全局」二字。
//
// 历史（避免后来者误删）：本文件曾另有一条「未配 admin 凭据 ⇒ 只 warn 跳过、服务照常启动」
// 的用例，锁的是当时的"凭据闸门"。R2 把凭据改为 config 必填后该行为**已被否决**（缺凭据时
// 无人能登录，见 spec §3.5 的更正），那条用例与它依赖的 db.closePools 一并删除。
// 留下这条与凭据有无无关、至今成立的契约——**别再连它一起删掉**。
//
// 真 PG（同 migrate/tenant/loader.test.ts 约定）：未提供 DATABASE_URL 时整体跳过。
//
// **两个层次都要覆盖**（R4 评审 must-fix 2 的教训）：进程内 `app.request()` **没有 socket**，
// 「客户端拿不到 413、转而看到连接重置」这件事在那一层结构性地看不见 ⇒ 除了进程内那组，
// 另起一层**真 @hono/node-server + 真 socket**（见「真 HTTP」describe）。
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { Agent, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockCasdoor } from '@platform/auth-core/src/test-util/mock-casdoor'
import { buildApp, MAX_API_BODY_BYTES } from './app'
import { getPool } from './db'
import type { AppConfig } from './config'

const dbUrl = process.env.DATABASE_URL

// 池生命周期（R4 评审 S3）：本文件所有 describe 共用 db.ts 的模块级单例池（同 databaseUrl）。
// 旧写法把「关池」塞在**最后一个 describe 的 afterAll** 里，靠"文件内 describe 执行次序"耦合
// ——中间插一个新 describe、或调换顺序，池就会在后续用例之前被 end（症状是后面全红，而原因
// 看起来在别处）。改为**文件级 afterAll** 统一关池，并在关之前断言池尚未被 end：这是**可执行
// 守卫**——谁再往某个 describe 里塞一次 close，这条断言立刻红并指名原因，而不是静默地让
// 后面的用例拿到死池。
afterAll(async () => {
  if (!dbUrl) return
  const pool = getPool({ databaseUrl: dbUrl })
  expect(
    pool.ended,
    '池在文件级 afterAll 之前就被 end 了——检查各 describe 的 afterAll 是否私自关池',
  ).toBe(false)
  await pool.end().catch(() => {})
})

function configWith(casdoorUrl: string, adminPwd: string): AppConfig {
  return {
    port: 13000,
    databaseUrl: dbUrl!,
    tenantMode: 'single',
    platformOrg: 'acme',
    sessionSecret: 'test-secret-test-secret-test-secret!',
    casdoor: {
      url: casdoorUrl,
      clientId: 'test-client',
      clientSecret: '',
      application: 'app-built-in',
      adminUser: 'admin',
      adminPwd,
    },
    publicOrigin: 'http://127.0.0.1:13000',
    // 必需：platform.tenant 为空时供给循环不执行、压根不取 client，这条契约就变成空转
    // ——那正是 issue #3 第二节"结构性失明"的形状
    seedDemo: true,
  }
}

/** 真 socket 探测结果：服务端回的「状态码 + 响应体」，或**客户端侧**的错误码（ECONNRESET / EPIPE） */
type SocketOutcome = { status: number; body: string } | { err: string }

/** socket 级 error 监听器的去重标记（keep-alive 下 40 条请求共用同一个 socket，见下） */
const socketErrGuard = Symbol('socketErrGuard')

/**
 * 经**真 socket**发一个超限 POST，返回客户端实际观测到的东西。
 *
 * 用 node:http 而不是 fetch/undici：要看的就是 socket 层的错误事件本身，fetch 会把它包装成
 * 笼统的 `TypeError: fetch failed`、丢掉 `ECONNRESET`/`EPIPE` 错误码，"重置"与"别的问题"
 * 就分不开了。
 *
 * 发送形态与 T2 评审的复现脚本同形：**一次 write 写完整个 body**。这是个刻意的选择——
 * 分块慢写反而更容易抢在服务端销毁 socket 之前把 body 发完，把竞态窗口压掉、测不出来
 * （标定时实测：单次 write 40 次里 11–14 次失败，正是评审报告的 25–35%）。
 */
function postOversizedSocket(port: number, bytes: number, agent: Agent): Promise<SocketOutcome> {
  return new Promise((resolve) => {
    const body = Buffer.alloc(bytes, 0x78) // 'x'
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/platform/auth/logout',
        // **keep-alive 客户端**：与评审探针同形（undici 默认 keep-alive，浏览器亦然），也是
        // 这条回归的**正确作用域**。经标定（最小 app + bodyLimit 对照，40 次/格）：
        //   · keep-alive：不读体直接回 413（对照，无 bodyLimit）= 40/40 干净；
        //                 有 bodyLimit 但不 cancel = 26/40（**本任务引入的回归**）；
        //                 有 bodyLimit + cancel = 40/40（修好，回到对照基线）。
        //   · `Connection: close` / 每请求独占 socket：**对照本身就只有 ~70% 干净**（28/40、
        //     19/40）——那是 @hono/node-server 在"未读请求体就结束响应"下的固有行为，与本次
        //     改动无关，用它们做回归面只会把一个既存现象记到本任务头上。故这里固定 keep-alive。
        agent,
        headers: {
          host: 'acme.test',
          'content-type': 'application/json',
          'content-length': String(body.length),
        },
      },
      (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (d: string) => { raw += d })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw }))
      },
    )
    req.on('error', (e: NodeJS.ErrnoException) => resolve({ err: e.code ?? e.message }))
    // 请求已了结之后才到达的 socket 错误不会再转发给 req（Node 在响应收全后解除了转发），会
    // 冒成 vitest 的 uncaught exception 并把一条**无关**用例标红 ⇒ 挂个 no-op 监听器吃掉它。
    // 不影响判定：请求在飞时 socket 错误**先**转发到 req（上面那条 resolve 照常拿到错误码）。
    // 用 Symbol 去重：keep-alive 下 40 条请求共用同一个 socket，每条都挂一个会触发
    // MaxListenersExceededWarning。
    req.on('socket', (socket) => {
      const bag = socket as unknown as Record<symbol, boolean>
      if (bag[socketErrGuard]) return
      bag[socketErrGuard] = true
      socket.on('error', () => {})
    })
    req.end(body)
  })
}

describe.skipIf(!dbUrl)('buildApp：/api/* 全局请求体上限（MAX_API_BODY_BYTES）', () => {
  // 真 buildApp 出来的 app（全局中间件挂在 buildApp 内部，auth.test.ts 那种手搭 makeApp
  // 不含它）——这里必须走装配，否则测不到全局上限。
  //
  // 池生命周期见文件级 afterAll（本 describe 只停自己的 mock，不关池——R4 评审 S3）。
  const mock2 = new MockCasdoor()
  let app: Awaited<ReturnType<typeof buildApp>>['app']

  beforeAll(async () => {
    await mock2.start()
    const built = await buildApp({ config: configWith(mock2.origin, 'pw') })
    app = built.app
  })
  afterAll(async () => {
    await mock2.stop()
  })

  it('★ 负例：非登录路 /api/* 超过上限的请求体 ⇒ 413（此前只有登录路有上限，其余 /api/* 全无）', async () => {
    // 为什么不用 /auth/login：登录路自己就有 8192 的有界读取（readBodyBounded），超大 body
    // 在改动前就已经返 413 ⇒ 拿 login 测全局上限是**假红/恒绿**，测不到本任务的修复。
    // 换一条非登录路 /api/platform/auth/logout——它不读 body，改动前超大 body 照样走到
    // 会话层返 401；只有全局 bodyLimit 才能让它在进业务前就 413。
    const huge = 'x'.repeat(MAX_API_BODY_BYTES + 1024)
    const res = await app.request('/api/platform/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'acme.test' },
      body: JSON.stringify({ pad: huge }),
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'PAYLOAD_TOO_LARGE' })
  })

  it('对照：同一非登录路上限内的请求体照常走到业务（证明上一条不是"把 /api 全拒了"）', async () => {
    const res = await app.request('/api/platform/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'acme.test' },
      body: JSON.stringify({ pad: 'x' }),
    })
    expect(res.status).toBe(401) // 无会话：证明已进到会话门，而非被上限拦下
  })

  it('对照：登录路在上限内的坏凭据仍走业务返 401（登录路自己的 8192 上限不受影响）', async () => {
    const res = await app.request('/api/platform/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'acme.test' },
      body: JSON.stringify({ username: 'nobody', password: 'x' }),
    })
    expect(res.status).toBe(401)
  })

  // ---- R4 评审 S1：① 经 runtime.mount 注册的模块路由也吃这道全局上限；② 边界锁 `>` 而非 `>=` ----

  it('★ 负例：经 runtime.mount 注册的模块路由超限 ⇒ 413（"全局"二字的真正证据）', async () => {
    // mount 是最容易"被后来者挂错顺序"的一处：bodyLimit 挂在 ④.5、且 Hono 的中间件只对
    // **其后注册**的路由生效——模块路由是 buildApp 最后一步（⑨ runtime.mount）挂的，
    // 一旦有人把 mount 挪到 bodyLimit 之前，这条会立刻红（而别的用例都还是绿的）。
    // 该路径来自 modules/demo/manifest.yaml 的 `POST /notes`。
    const res = await app.request('/api/modules/demo/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'acme.test' },
      body: 'x'.repeat(MAX_API_BODY_BYTES + 1024),
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'PAYLOAD_TOO_LARGE' })
  })

  it('★ 边界：body 恰好 == MAX_API_BODY_BYTES 放行、== MAX+1 才 413（把 `>` 钉死，不是 `>=`）', async () => {
    // 此前没有任何用例碰过这条边界：把实现写成 `>=`（或多算一个字节）会**误拒 1 MiB 的合法
    // 请求**，而全部用例照旧全绿——上限本身就是"差一个字节"最容易出错的地方。
    const at = await app.request('/api/platform/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'acme.test' },
      body: 'x'.repeat(MAX_API_BODY_BYTES),
    })
    expect(at.status).toBe(401) // 恰好到上限 ⇒ 放行到会话门（实现改成 >= 会在这里变 413）

    const over = await app.request('/api/platform/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'acme.test' },
      body: 'x'.repeat(MAX_API_BODY_BYTES + 1),
    })
    expect(over.status).toBe(413)
  })

  // ---- R4 评审 must-fix 2：真 HTTP 下超限请求曾 25–35% 变连接重置 ----
  //
  // 为什么必须另起这一层：进程内 `app.request()` **无 socket**，onError 里 `c.json(…, 413)`
  // 一定原样变成测试看到的 413——"客户端根本收不到它、转而看到连接重置"在这层**结构性看不见**。
  // 触发条件是「访问了请求体流又弃之不用」：hono/body-limit 首行 `if (!c.req.raw.body) return next()`
  // 一旦读到 body 流却不 drain/不 cancel，@hono/node-server 结束响应时会直接销毁 socket，
  // 而客户端还在写 body ⇒ ECONNRESET/EPIPE。修法是 onError 里先 `cancel()` 再回 413。
  describe('真 HTTP（真 @hono/node-server + 真 socket）', () => {
    let server: ReturnType<typeof serve> | undefined
    let port = 0

    beforeAll(async () => {
      // port: 0 = 向内核要一个空闲端口（与 smoke-load.mjs 同款理由：不写死端口，免与 dev server 撞车）
      port = await new Promise<number>((resolve) => {
        server = serve({ fetch: app.fetch, port: 0 }, (info) => resolve(info.port))
      })
    })
    afterAll(async () => {
      // 成功的那些请求走 keep-alive（Node ≥19 的 globalAgent 默认开）⇒ 不主动断开的话
      // server.close() 会一直等这些空闲连接，vitest 报 open handle / 挂住
      //
      // `in` 收窄而不是 `?.` / 断言：`ReturnType<typeof serve>` = `ServerType` =
      // `http.Server | http2.Http2Server | http2.Http2SecureServer`（@hono/node-server 的联合），
      // 而 `closeAllConnections` 只在 `http.Server` 上（Node ≥18.2）。本套件没传 `createServer`
      // ⇒ 运行时必是 `http.Server`，但类型层仍是三选一：旧写法 `server?.closeAllConnections?.()`
      // 的可选链只挡 `undefined`，挡不住「联合里另外两个成员没有这个属性」⇒ TS2339。
      // 收窄后归 http.Server，`?.` 也不再需要（`server` 已被 truthy 判定）。
      if (server && 'closeAllConnections' in server) server.closeAllConnections()
      await new Promise<void>((resolve) => {
        if (!server) return resolve()
        server.close(() => resolve())
      })
    })

    it('★ 负例：连续 40 个超限请求，客户端每一个都必须拿到 413（一个连接重置都不许有）', async () => {
      const trials = 40
      // keep-alive agent 单列：本 test 的 40 条请求**共用一条连接**（与浏览器/undici 同形）。
      // agent 随 test 走、结束即 destroy，避免连接漏到别的用例或被 server.close 挂住
      const agent = new Agent({ keepAlive: true, maxSockets: 1 })
      const outcomes: SocketOutcome[] = []
      try {
        for (let i = 0; i < trials; i++) {
          outcomes.push(await postOversizedSocket(port, MAX_API_BODY_BYTES + 1024, agent))
        }
      } finally {
        agent.destroy()
      }
      const bad = outcomes.filter((o) => !('status' in o) || o.status !== 413)
      // 40 次独立试验：修法之前单次成功率约 65–75% ⇒ "全绿"的概率约 1e-6 量级，红是确定性的
      expect(
        bad,
        `客户端观测到的非 413 结果（${bad.length}/${trials}）：${JSON.stringify(bad)}`,
      ).toEqual([])
      // 状态码对而体丢了是另一种失败形态，一并钉住
      expect([...new Set(outcomes.map((o) => ('status' in o ? o.body : '<<reset>>')))]).toEqual([
        '{"error":"PAYLOAD_TOO_LARGE"}',
      ])
    }, 60_000)
  })
})

// ---- 静态响应的缓存策略（M1 闭债 R5）：哈希产物 immutable / 其余（含 index.html）可重验 ----
//
// **为什么注入 fixture dist，而不是用 apps/web/dist（计划 Step 1 的写法）**：CI 的 `unit` job
// 只跑 `pnpm test`、从不构建 web——凡依赖 dist 的断言都归 `smoke` job（它自己先 build，见
// ci.yml 的分工注释）。按真机产物断言 ⇒ 本文件在 CI 上整片变红或（若加 skipIf）静默休眠，
// 两条都不可接受。fixture **复刻 vite 产物的关键形状**（index.html 以站点绝对路径引用带内容
// 哈希的 /assets/*.js），被断言的语义与真机同源，且不依赖构建顺序。
//
// 真机产物那一层由 smoke 的 H3 段覆盖（/assets/* 必须吐构建产物本体）。
describe.skipIf(!dbUrl)('buildApp：静态响应 Cache-Control', () => {
  const mockStatic = new MockCasdoor()
  let distDir = ''
  let app: Awaited<ReturnType<typeof buildApp>>['app']

  beforeAll(async () => {
    await mockStatic.start()
    distDir = await mkdtemp(join(tmpdir(), 'platform-web-dist-'))
    await mkdir(join(distDir, 'assets'))
    await writeFile(join(distDir, 'assets', 'index-CIQEGtjA.js'), 'console.log("fixture")\n')
    await writeFile(join(distDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n')
    await writeFile(
      join(distDir, 'index.html'),
      [
        '<!doctype html>',
        '<html><head><title>fixture</title></head><body>',
        '<div id="root"></div>',
        '<script type="module" src="/assets/index-CIQEGtjA.js"></script>',
        '</body></html>',
        '',
      ].join('\n'),
    )
    app = (await buildApp({ config: configWith(mockStatic.origin, 'pw'), webDistDir: distDir })).app
    // 304 探测路由：**必须在这里注册**（Hono 的 matcher 在首个请求时构建，之后 `app.get` 抛
    // "Can not add a route since the matcher is already built"）。挂在缓存中间件**之后**
    // （Hono 的中间件只对其后注册的路由生效）⇒ 与静态路由同侧，走同一段中间件。
    // 路径取 `/api/…` 是因为 SPA 兜底 `app.get('*')` 只对 `/api/*` 调 next() 放行，
    // 其余路径会被它先吞掉（本轮实测踩到）。
    app.get('/api/__probe-304', () => new Response(null, { status: 304 }))
  })
  afterAll(async () => {
    await mockStatic.stop()
    await rm(distDir, { recursive: true, force: true })
  })

  it('★ 负例：/assets/* 带内容哈希 ⇒ immutable 长缓存', async () => {
    // 资产路径从**真装配产出的 index.html** 里取（不写死）：断言的正是浏览器会请求的那条 URL
    const index = await app.request('/', { headers: { host: 'acme.test' } })
    const html = await index.text()
    const m = /\/assets\/[^"']+\.js/.exec(html)
    expect(m).not.toBeNull()
    const asset = await app.request(m![0], { headers: { host: 'acme.test' } })
    // 先钉住「命中的是产物本体而非 SPA 兜底」——否则下面两条会在 "immutable 标到了 index.html 上"
    // 这种**最坏情形**下假绿（那正是本任务要防的事故：拿 immutable 的旧壳去请求已删的旧 assets）
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('javascript')
    const cc = asset.headers.get('cache-control') ?? ''
    expect(cc).toContain('immutable')
    expect(cc).toContain('max-age=31536000')
  })

  it('★ 负例：SPA 入口（/ 与深链兜底）必须可重验，不得长缓存', async () => {
    for (const p of ['/', '/login', '/console', '/console/demo']) {
      const res = await app.request(p, { headers: { host: 'acme.test' } })
      expect(res.status, `${p} 应回 SPA 入口`).toBe(200)
      expect(res.headers.get('content-type'), `${p} 应吐 index.html`).toContain('text/html')
      const cc = res.headers.get('cache-control') ?? ''
      expect(cc, `${p} 的 Cache-Control`).toContain('no-cache')
      expect(cc, `${p} 的 Cache-Control`).not.toContain('immutable')
    }
  })

  it('★ 边界：/assets/ 前缀下**未命中**的路径落 SPA 兜底 ⇒ 仍须可重验（不得按前缀误标 immutable）', async () => {
    // 分档若写成"看路径前缀"就会在这一格把 index.html 标成 immutable —— 发版后用户拿到旧壳
    const res = await app.request('/assets/gone-1a2b3c.js', { headers: { host: 'acme.test' } })
    expect(res.headers.get('content-type')).toContain('text/html') // 确系 SPA 兜底
    const cc = res.headers.get('cache-control') ?? ''
    expect(cc).toContain('no-cache')
    expect(cc).not.toContain('immutable')
  })

  it('对照：非哈希产物（/favicon.svg）也走可重验档——规则是「/assets 前缀 immutable + 其余一律可重验」', async () => {
    const res = await app.request('/favicon.svg', { headers: { host: 'acme.test' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('svg')
    expect(res.headers.get('cache-control')).toBe('no-cache')
  })

  // ---- R5 三路评审建议 3 / 4：两条改动的护栏（负例 + 边界） ----

  it('★ 负例：/healthz 与 /api/* **不**被打上 Cache-Control（R5 评审建议 3）', async () => {
    // 今天靠一个**隐式事实**成立：缓存中间件用 `app.use('*')` 注册在静态托管之前，而 Hono
    // 的中间件只对**其后注册**的路由生效 —— 所有 /api/* 与 /healthz 都在它之前注册完。
    // 一旦有人把这层中间件上移成"全局"（这念头很自然：它看起来就是个全局中间件），就会
    // 覆盖路由自己设的头 —— 认证类端点将来若设 `no-store` 被它改写成 `no-cache`，就是
    // 静默的安全弱化。这条断言把那个隐式事实钉成显式契约。
    for (const p of ['/healthz', '/api/platform/config']) {
      const res = await app.request(p, { headers: { host: 'acme.test' } })
      expect(res.status, `${p} 应可达`).toBe(200)
      expect(res.headers.get('cache-control'), `${p} 不该有 Cache-Control`).toBeNull()
    }
  })

  it('★ 边界：304 也必须带 Cache-Control —— `!res.ok` 曾把它挡在门外（R5 评审建议 4）', async () => {
    // 本栈 serveStatic 今天不发 ETag（见 app.ts 顶部注释），所以 304 只能由"将来"产生
    // （补 hono/etag 或升级 serveStatic）。beforeAll 里注册的探测路由把那个"将来"提前到了
    // 今天：`Response.ok` 是 **2xx 才为真**，304 会被 `!res?.ok` 判成 falsy 而漏设头
    // （RFC 9111 §4.3.4 要求 304 携带与对应 200 一致的 Cache-Control）。
    const res = await app.request('/api/__probe-304', { headers: { host: 'acme.test' } })
    expect(res.status).toBe(304)
    expect(res.headers.get('cache-control')).toBe('no-cache')
  })
})

describe.skipIf(!dbUrl)('buildApp：启动期 fail-fast 传播', () => {
  const mock = new MockCasdoor()

  beforeAll(async () => { await mock.start() })
  // 不在这里关池（R4 评审 S3）：池是本文件共用的模块级单例，关它属文件级职责——见顶部
  // 文件级 afterAll。本 describe 的 beforeAll 会起第二个 mock，但仍走同一个池。
  afterAll(async () => {
    await mock.stop()
  })

  it('★ 权限码供给抛错 → 原样上抛 → buildApp 拒绝（宿主起不来）', async () => {
    // admin 口令故意配错：管理会话登不上 ⇒ upsertPermission 抛 ⇒ 该错误必须一路传出 buildApp
    // （运维契约：Casdoor 不可用时容器就反复重启，见 deploy/openship-adopt.md 陷阱 2）
    //
    // 断言锁在具体错误来源上，不用裸 rejects.toThrow()：裸写法下任何原因抛错都算过，
    // 那样"seed 顺序错了 / 模块没找到"之类的无关失败会被误读成本条契约成立
    await expect(
      buildApp({ config: configWith(mock.origin, 'wrong-password') }),
    ).rejects.toThrow(/casdoor admin login failed/)
  })
})
