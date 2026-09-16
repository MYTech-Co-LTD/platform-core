#!/usr/bin/env node
// smoke-load.mjs — 装载冒烟（M0 计划 Task 21；测试门禁 C1 的「加载冒烟」形态机检化）。
//
// 用法：DATABASE_URL=postgres://… tsx scripts/smoke-load.mjs
//   前置：① 可连的 PG（CI 是 service，本地是 deploy/docker-compose.yml 的 platform-pg）；
//         ② 已构建 web（`pnpm --filter @platform/web build`）——静态托管断言取 dist 真产物。
//
// 与「单元测试」的分工：单元测试用 testClient 在进程内直调 app，覆盖不到【真进程 + 真端口 +
// 真 HTTP】这一层。本脚本起真实宿主子进程（apps/server/src/index.ts，tsx 运行）、经 socket 发
// 真实请求，覆盖单测结构性覆盖不到的三类：
//   ① 启动期装配（loadConfig → 迁移 → 装载 → 种子）能真跑通并监听；
//   ② 租户解析依赖的 Host 头在真实 HTTP 栈上的语义（fetch 会静默丢弃 Host，见下）；
//   ③ 静态托管：/assets/* 必须吐构建产物本体——Task 19 浏览器白屏事故的机检化（见 H3 段）。
//
// 双形态（C1）：multi（Host 解析租户）+ single（PLATFORM_ORG 唯一租户），各起一次子进程。
// 两个子进程端口不同（BASE_PORT / BASE_PORT+1），互不干扰、也不受上一进程 TIME_WAIT 影响。
//
// 实现判断（都留在这里，避免后来者当成疏漏）：
//   ① 不用 fetch 而用 node:http：Node 的 fetch（undici）会【静默丢弃】显式传入的 Host 头
//      （实测 `{headers:{host:'acme.test'}}` 发出后服务端仍看到 127.0.0.1:port）。multi 形态
//      的租户解析完全依赖 Host——用 fetch 就只能靠 /etc/hosts 造假域名（CI 需 sudo、且把
//      「冒烟依赖机器 hosts 配置」这种隐式前提引进门禁），不如直接用 node:http 自持 Host 头。
//      副产品：能拿到未经 fetch 解码的原始字节，H3 的「与磁盘产物逐字节相同」断言才有依据。
//   ② 环境变量常量（端口 / PUBLIC_ORIGIN / 会话密钥 / Casdoor 管理员凭据）全部由本脚本持有，
//      CI 只注入 DATABASE_URL（service 地址，环境相关、无法内联）。单一事实源在这里——
//      改端口只改本文件，YAML 无需跟着改，杜绝两边各写各的漂移。
//   ③ 子进程 detached + 杀进程组：tsx CLI 可能再 fork 一个 node 子进程跑 entry，只杀 tsx
//      会留下孤儿进程占着端口；按进程组发信号才是真收尸。
//   ④ 断言失败立即打印【响应状态 + body】并 exit 1：冒烟失败时最贵的成本是「只看到一个
//      布尔，不知道服务端到底回了什么」——宁可多打一行。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createServer, request as nodeHttpRequest } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MockCasdoor } from '../packages/auth-core/src/test-util/mock-casdoor.ts'
// 权限的 name 不等于码（真 Casdoor 禁冒号 ⇒ 建码时净化过，见 safePermissionName / issue #25）——
// 按名字引用权限的地方必须用同一个函数，否则会 404 "permission not found"
import { safePermissionName } from '../packages/auth-core/src/casdoor-client.ts'
// 限速阈值走真源码常量：写死 5 就是第二个事实源，改了 rate-limit.ts 这里不会跟着动。
import { USER_FAIL_LIMIT } from '../apps/server/src/rate-limit.ts'

// ---- 路径解析（一律按本文件位置，与 cwd 无关） ----
const scriptsDir = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = path.resolve(scriptsDir, '..')
const serverDir = path.join(repoRoot, 'apps', 'server')
const webDistDir = path.join(repoRoot, 'apps', 'web', 'dist')

// ---- 常量：本脚本是这些值的唯一事实源（见头注判断②） ----
/**
 * 端口：默认向内核要两个空闲端口（multi / single 各一个，同一时刻占用故必不相同）。
 * 不写死 13000 的理由——冒烟与 `pnpm dev` 的默认 PORT 撞车是【本地高频场景】，写死会让
 * 「开着 dev server 跑冒烟」直接 EADDRINUSE 起不来（本地首次跑就撞上了）。CI 里没这个
 * 问题，但把「先关掉 dev server」这种隐性前提写进门禁不值得。
 * SMOKE_PORT 显式指定时用它作基端口（+1 给 single），便于人工 curl 复现。
 */
const SMOKE_PORT_ENV = process.env.SMOKE_PORT
const SESSION_SECRET = 'smoke-secret-smoke-secret-smoke!!' // ≥32 字符（config.ts 强校验）
const CASDOOR_CLIENT_ID = 'smoke-client'
/** MockCasdoor 内置 admin（构造器保证存在，除非种子给了同名用户）——getUser/getPermissions 要它 */
const CASDOOR_ADMIN_USER = 'admin'
const CASDOOR_ADMIN_PWD = 'pw'
const READY_TIMEOUT_MS = 30_000
const TENANT_HOST = 'acme.test'
const BETA_HOST = 'beta.test' // 第二个租户：其余租户恒 403 的观测面（issue #3 第二节成因③）
const UNKNOWN_HOST = 'unknown.test'
/** demo 种子的品牌名（apps/server/src/seed.ts）——断言 branding 命中的锚点 */
const ACME_PRODUCT_NAME = 'Acme 工单'
const BETA_PRODUCT_NAME = 'Beta 平台'
/**
 * multi 形态的 PLATFORM_ORG【诱饵值】：故意指向不存在的租户 org。
 *
 * 它能排除的是**一件具体的事**：供给 org 退回取 `config.platformOrg`（修复前 app.ts 的形状）。
 * 这条绊线是活的——config 并未在 multi 下强制清空该值，所以诱饵确实能到达 config.platformOrg。
 *
 * 它【不能】排除：① 供给 org 取 platform.tenant 里的任意单条（那是下面 beta 那条断言的活）；
 * ② 任何读侧问题。对这个 env 回退形状，beta 断言同样会红 ⇒ 两者冗余，本条只赢在更早、
 * 更直指原因。别把它当"写读同源"的完整证明——同源由「beta 码存在」+「beta scopes 缺失」
 * 两条合起来证。
 */
const DECOY_PLATFORM_ORG = 'NOT-ACME-ORG'

const USER_PASSWORD = 'pw'
const ADMIN1 = 'admin1' // 有 demo:view + demo:note
const VIEWER1 = 'viewer1' // 无任何 demo 权限——403 路径的唯一端到端证据
/**
 * beta 租户自己的管理员。**必须有第二个用户**：Casdoor 的用户按 owner 归属，
 * `get-user?id=beta/admin1` 对 acme 的 admin1 回 ok+null（真机实测 shanhai/admin ⇒ ok+null，
 * 评审 S3）⇒ 拿 admin1 登 beta 会 502。旧开冒烟能过只是因为 mock 忽略 org 段。
 */
const BETA_ADMIN1 = 'beta-admin1'

// ---- 类型别名（.mjs 的类型书写面就是 JSDoc；根 tsconfig 的 checkJs 按 strict 查本文件） ----
/** @typedef {import('node:http').IncomingHttpHeaders} IncomingHttpHeaders */
/** @typedef {import('node:child_process').ChildProcess} ChildProcess */

/**
 * @typedef {object} HttpResponse
 * @property {number} status
 * @property {IncomingHttpHeaders} headers
 * @property {Buffer} body 原始字节（H3 的逐字节比对依赖它，故不经 fetch 解码）
 * @property {string} text body 的 utf8 视图
 */

/**
 * @typedef {object} RequestOptions
 * @property {number} port
 * @property {string} path
 * @property {string} [method]
 * @property {string} [host] 显式 Host 头（multi 形态靠它解析租户）
 * @property {string} [cookie]
 * @property {Record<string, string>} [headers]
 * @property {string} [body]
 */

/**
 * @typedef {object} CallOptions
 * @property {string} [cookie]
 * @property {Record<string, string>} [headers]
 */

/**
 * 一个形态的请求入口：固定 port/host，只暴露 get/head/post。
 * @typedef {object} PhaseBase
 * @property {number} port
 * @property {string | undefined} host
 * @property {(p: string, opts?: CallOptions) => Promise<HttpResponse>} get
 * @property {(p: string, opts?: CallOptions) => Promise<HttpResponse>} head
 * @property {(p: string, body: unknown, opts?: CallOptions) => Promise<HttpResponse>} post
 */

// ---- 断言 / 输出 ----

/**
 * 断言失败：立即打印标签 + 上下文，然后**抛错**而非 process.exit(1)。
 * 为什么要抛：main() 的 finally 负责收尸（杀子进程组 + 停 mock）。在 check 里直接
 * process.exit 会绕过 finally，失败一次就在本机留下一个占着端口的宿主进程和一枚 mock
 * ——而「冒烟失败」恰恰是最常被反复跑的场景。抛错仍满足「立即打印 body + 最终 exit 1」：
 * 打印是同步发生的，退出码由顶层 catch 统一给。
 */
class SmokeFailure extends Error {}

/**
 * @param {boolean} cond @param {string} label @param {unknown} [detail]
 */
function check(cond, label, detail) {
  if (cond) {
    console.log(`    ✓ ${label}`)
    return
  }
  console.error(`    ✗ ${label}`)
  if (detail !== undefined) {
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)
    console.error(text.split('\n').map((l) => `      ${l}`).join('\n'))
  }
  throw new SmokeFailure(label)
}

/** @param {string} label */
function step(label) {
  console.log(`\n== ${label}`)
}

/**
 * 请求摘要 + 响应体：断言失败时打印这个（「服务端到底回了什么」）
 * @param {HttpResponse} res @param {Record<string, unknown>} [extra]
 */
function describe(res, extra = {}) {
  return {
    ...extra,
    status: res.status,
    'content-type': res.headers['content-type'] ?? null,
    body: res.text.length > 2000 ? `${res.text.slice(0, 2000)}…(truncated)` : res.text,
  }
}

/** @param {HttpResponse} res @returns {any} 解析失败回 null（调用方自行判空） */
function json(res) {
  try {
    return JSON.parse(res.text)
  } catch {
    return null
  }
}

// ---- 极简 HTTP 客户端（node:http；见头注判断①） ----

/**
 * 发一个请求。host 显式指定（multi 形态靠它解析租户）；body 为字符串时按 JSON 发。
 * @param {RequestOptions} opts
 * @returns {Promise<HttpResponse>}
 */
function httpRequest({ port, method = 'GET', path: reqPath, host, cookie, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = nodeHttpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path: reqPath,
        headers: {
          ...(host ? { Host: host } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body !== undefined
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            : {}),
          ...headers,
        },
      },
      (res) => {
        /** @type {Buffer[]} */
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks)
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: raw, text: raw.toString('utf8') })
        })
      },
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/** 会话 cookie 罐：按浏览器语义应用 Set-Cookie（Max-Age=0 / 空值 = 删除）。 */
class CookieJar {
  #cookies = new Map()

  /** @param {HttpResponse} res */
  apply(res) {
    for (const raw of res.headers['set-cookie'] ?? []) {
      const pair = raw.split(';')[0] ?? ''
      const eq = pair.indexOf('=')
      if (eq < 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (value === '' || /max-age\s*=\s*0\b/i.test(raw)) this.#cookies.delete(name)
      else this.#cookies.set(name, value)
    }
  }

  header() {
    return [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  /** @param {string} name */
  has(name) {
    return this.#cookies.has(name)
  }
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 取 n 个互不相同的空闲端口：同时 bind 全部（不先关再要，避免两次探测拿到同一端口），
 * 拿到后统一释放。不指定 host = 绑全部接口，与宿主 `serve()` 的绑定面一致。
 * 释放到子进程 listen 之间存在极小的 TOCTOU 窗口——冒烟场景可接受。
 */
/** @param {number} n @returns {Promise<number[]>} */
async function freePorts(n) {
  /** @type {import('node:net').Server[]} */
  const servers = []
  /** @type {number[]} */
  const ports = []
  try {
    for (let i = 0; i < n; i++) {
      const srv = createServer()
      await new Promise((resolve, reject) => {
        srv.once('error', reject)
        srv.listen(0, () => resolve(undefined))
      })
      servers.push(srv)
      const addr = srv.address()
      // listen(0) 后 address() 必为 AddressInfo（不会是 unix socket 路径）；类型上仍要收窄
      if (addr === null || typeof addr === 'string') throw new Error('freePorts: 未拿到端口')
      ports.push(addr.port)
    }
  } finally {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r(undefined)))))
  }
  return ports
}

// ---- 宿主子进程 ----

/** tsx 入口：优先 pnpm 装的 .bin shim，缺失时回落 node 直跑 tsx/cli 出口 */
function tsxRunner() {
  const shim = path.join(repoRoot, 'node_modules', '.bin', 'tsx')
  if (existsSync(shim)) return { cmd: shim, args: [] }
  return { cmd: process.execPath, args: [fileURLToPath(import.meta.resolve('tsx/cli'))] }
}

/**
 * 起宿主子进程。日志（stdout+stderr）一律透传到本进程 stderr：stdout 留给冒烟自己的
 * 断言输出，排障时 CI 日志里能直接看到宿主启动期的 warn/报错。
 * @param {Record<string, string>} env @param {string} label
 * @returns {ChildProcess}
 */
function startServer(env, label) {
  const tsx = tsxRunner()
  const child = spawn(tsx.cmd, [...tsx.args, 'src/index.ts'], {
    cwd: serverDir, // modules/ 按 cwd/../../modules 解析（app.ts）——必须是 apps/server
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // 头注判断③：杀进程组
  })
  /** @param {unknown} buf */
  const relay = (buf) => process.stderr.write(String(buf).replace(/^/gm, `[server:${label}] `))
  child.stdout.on('data', relay)
  child.stderr.on('data', relay)
  return child
}

/**
 * 轮询 /healthz 直到 200；子进程提前退出即立刻失败（不等满超时）
 * @param {ChildProcess} child @param {number} port @param {string} label
 * @returns {Promise<void>}
 */
async function waitReady(child, port, label) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`[${label}] 宿主提前退出，code=${child.exitCode}`)
    try {
      const res = await httpRequest({ port, path: '/healthz' })
      if (res.status === 200) return
    } catch {
      // 尚未监听：继续等
    }
    await sleep(200)
  }
  throw new Error(`[${label}] 宿主未在 ${READY_TIMEOUT_MS}ms 内就绪（/healthz 未回 200）`)
}

/**
 * 优雅停：SIGTERM 整组 → 宽限 5s → SIGKILL 整组
 * @param {ChildProcess | undefined} child @param {string} label
 * @returns {Promise<void>}
 */
async function stopServer(child, label) {
  if (!child || child.exitCode !== null || child.pid === undefined) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM') // 进程组已消失（或平台不支持负 pid）：退回单进程信号
  }
  const ok = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)])
  if (!ok) {
    console.error(`[server:${label}] SIGTERM 后 5s 未退出，SIGKILL`)
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
    await Promise.race([exited, sleep(2000)])
  }
}

// ---- 场景复用的小流程 ----

/**
 * 每个子进程对应一套 { port, host } 基址（host 为 multi 的租户域；single 传 undefined）
 * @param {number} port @param {string} [host]
 * @returns {PhaseBase}
 */
function base(port, host) {
  return {
    port,
    host,
    /** @param {string} p @param {CallOptions} [opts] */
    get: (p, opts = {}) => httpRequest({ port, host, method: 'GET', path: p, ...opts }),
    /**
     * HEAD 探针：issue #7——Hono 把 HEAD 按 GET 派发，但 `c.req.method` 仍是 'HEAD'，
     * 声明门卫不归一就会对**已声明的 GET 端点**恒回 403。这里保留 end-to-end 观测面。
     * @param {string} p @param {CallOptions} [opts]
     */
    head: (p, opts = {}) => httpRequest({ port, host, method: 'HEAD', path: p, ...opts }),
    /**
     * @param {string} p @param {unknown} body @param {CallOptions} [opts]
     */
    post: (p, body, opts = {}) => httpRequest({ port, host, method: 'POST', path: p, body: JSON.stringify(body), ...opts }),
  }
}

/**
 * 账密登录：成功断言 200 + 会话 cookie 入 jar
 * @param {PhaseBase} b @param {CookieJar} jar @param {string} username @param {string} label
 * @returns {Promise<HttpResponse>}
 */
async function login(b, jar, username, label) {
  const res = await b.post('/api/platform/auth/login', { username, password: USER_PASSWORD }, { cookie: jar.header() })
  jar.apply(res)
  check(res.status === 200, `${label}：POST /api/platform/auth/login 200`, describe(res, { username }))
  check(jar.has('platform_session'), `${label}：登录响应下发 platform_session cookie`, describe(res, { username }))
  return res
}

/**
 * MockCasdoor 的 admin 会话 cookie（管理端点门禁；凭据走 JSON body）。
 * @param {MockCasdoor} mock @returns {Promise<string>}
 */
async function mockAdminCookie(mock) {
  const res = await httpRequest({
    port: mock.port,
    path: '/api/login',
    method: 'POST',
    body: JSON.stringify({ username: CASDOOR_ADMIN_USER, password: CASDOOR_ADMIN_PWD }),
  })
  check(res.status === 200, 'MockCasdoor：admin 登录 200（授权前置）', describe(res))
  const hit = /casdoor_session_id=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''))
  // check() 抛错但不参与 TS 收窄（参数是复合表达式，asserts 也无能为力），故这里显式把关：
  // 拿不到管理会话就没法授权，必须当场炸而不是拼出一个空 cookie 让后续断言以假象通过
  if (!hit) throw new SmokeFailure('MockCasdoor：admin 登录响应未带 casdoor_session_id')
  return `casdoor_session_id=${hit[1]}`
}

/**
 * 以租户管理员身份把权限码授予用户。
 * 走真 HTTP 是刻意的：这是真实租户管理员的路径（POST /api/update-permission，POST 非 PUT）。
 * ⚠️ 权限的 **name 不等于 code**：真 Casdoor 的 name 禁 `"/?:#&%=+;"`，而码形如 `demo:view`
 * ⇒ `CasdoorClient` 建码时把 name **净化**成 `demo-view`（`safePermissionName`，issue #25）。
 * 所以这里引用权限必须走同一个函数；写成 `org/permCode` 会 404 "permission not found"
 * （2026-09-13 CI 实测踩到）。manifest 里的中文名落在 displayName。
 * @param {MockCasdoor} mock @param {string} cookie
 * @param {string} org @param {string} permCode @param {string[]} users
 * @returns {Promise<void>}
 */
async function grantPermission(mock, cookie, org, permCode, users) {
  const res = await httpRequest({
    port: mock.port,
    method: 'POST',
    cookie,
    path: `/api/update-permission?id=${encodeURIComponent(`${org}/${safePermissionName(permCode)}`)}`,
    body: JSON.stringify({ users }),
  })
  check(
    res.status === 200 && json(res)?.status === 'ok',
    `租户管理员把 ${org} 的 ${permCode} 授予 [${users.join(',')}]`,
    describe(res),
  )
}

/**
 * H3：静态托管回归——/assets/* 必须吐构建产物本体（Task 19 白屏事故的机检化）
 * @param {PhaseBase} b
 * @returns {Promise<void>}
 */
async function assertStaticServing(b) {
  step('H3 静态托管：/assets/* 返回构建产物本体（不是 SPA 兜底 index.html）')
  const assetsDir = path.join(webDistDir, 'assets')
  check(existsSync(assetsDir), `web 构建产物存在：${path.relative(repoRoot, assetsDir)}（先跑 pnpm --filter @platform/web build）`)
  const assets = readdirSync(assetsDir).filter((f) => /\.(js|css)$/.test(f))
  check(assets.length > 0, `${path.relative(repoRoot, assetsDir)} 下有 js/css 产物`)

  const indexPath = path.join(webDistDir, 'index.html')
  const indexBytes = readFileSync(indexPath)
  for (const name of assets) {
    const onDisk = readFileSync(path.join(assetsDir, name))
    const res = await b.get(`/assets/${name}`)
    check(res.status === 200, `GET /assets/${name} 200`, describe(res, { asset: name }))
    const ctype = String(res.headers['content-type'] ?? '')
    const want = name.endsWith('.css') ? ctype.includes('css') : /javascript|ecmascript/.test(ctype)
    check(want, `GET /assets/${name} content-type 是本体类型（实际 ${ctype || '(空)'}）`, describe(res, { asset: name }))
    // 逐字节比对磁盘产物：这比「不是 HTML」更强——serveStatic 被摘掉时这里拿到 index.html，
    // 与构建产物长度/内容都不同，必红；同时排除了「回了个别的 200」这类假绿
    check(
      res.body.length === onDisk.length && res.body.equals(onDisk),
      `GET /assets/${name} 与磁盘产物逐字节相同（${onDisk.length}B）`,
      describe(res, { asset: name, onDiskBytes: onDisk.length, servedBytes: res.body.length, equalsIndexHtml: res.body.equals(indexBytes) }),
    )
    // 缓存档（R5 修复轮 S4）：带内容哈希的产物必须 immutable。
    // **为什么要在这一层加**：那四条缓存断言全跑在**注入的 fixture dist** 上（app.test.ts——
    // CI 的 unit job 不构建 web），真产物 + 真进程这条路径上**一条 Cache-Control 断言都没有**，
    // 谁把中间件摘了、或让它在真 dist 上不生效，单测全绿而线上退化成启发式缓存。
    const cc = String(res.headers['cache-control'] ?? '')
    check(
      cc.includes('immutable') && cc.includes('max-age=31536000'),
      `GET /assets/${name} Cache-Control 是 immutable 长缓存（实际 ${cc || '(空)'}）`,
      describe(res, { asset: name }),
    )
  }
  // 对照组：SPA 兜底仍要工作（/ 返回 index.html 本体）——两条路径各自证明自己，不是「全都回 index」
  const spa = await b.get('/')
  check(spa.status === 200 && spa.body.equals(indexBytes), 'GET / 回 SPA index.html 本体（对照组）', describe(spa))
  // 缓存档（R5 修复轮 S4）：SPA 入口必须**可重验**，不得长缓存——发版后用户拿到旧壳去请求
  // 已删除的旧 assets 就是白屏事故本身（app.ts 顶部注释的取舍依据）
  const spaCc = String(spa.headers['cache-control'] ?? '')
  check(
    spaCc.includes('no-cache') && !spaCc.includes('immutable'),
    `GET / Cache-Control 是可重验档（实际 ${spaCc || '(空)'}）`,
    describe(spa),
  )

  // 负例（R5 修复轮 S5）：**认证/接口类端点不得被打上 Cache-Control**。
  // 今天这靠一个隐式事实成立：缓存中间件用 `app.use('*')` 注册在静态托管之前，而 Hono 的
  // 中间件只对其后注册的路由生效——所有 /api/* 与 /healthz 都在它之前注册完。将来有人把它
  // 上移成"真全局"，就会**覆盖路由自己设的头**：认证类端点若设 `no-store` 被改写成
  // `no-cache`，就是静默的安全弱化。单测那侧已有一条同口径的断言（进程内 app.request），
  // 这里再钉一次**真进程 + 真 HTTP** 这一层——两层都覆盖，才防得住"只在某一层成立"。
  for (const [p, why] of [['/healthz', '探活'], ['/api/platform/config', '平台接口']]) {
    const r = await b.get(p)
    check(r.status === 200, `GET ${p} 200（${why}）`, describe(r))
    const h = r.headers['cache-control']
    check(h === undefined, `GET ${p} 不带 Cache-Control（实际 ${h ?? '(无)'}）`, describe(r))
  }
}

/** 移动端 userApp 的挂载点（manifest 的 frontend.userApp.mount；改这里也要改那儿） */
const MOBILE_MOUNT = '/app/aftersales'
const MOBILE_DIST = path.join(repoRoot, 'modules', 'aftersales', 'mobile', 'dist')

/**
 * H6：userApp 静态**真的挂上了**（M3b-2；spec §3.2 的两条机检）。
 *
 * 为什么必须有这一条：`loader.ts` 的 `if (!existsSync(dist)) continue` 是**静默跳过** ——
 * 「构建没跑」表现为「API 照常、移动端 404」，整条流水线全绿。这正是本仓反复批的
 * 「静默失败 = 绿」，所以它必须在**真进程 + 真 HTTP** 这层被钉住。
 *
 * 三条断言各自防一件事：
 *   ① 入口回 SPA 壳而不是 404  → 防「没构建 / 路径写错」被静默跳过；
 *   ② 深链也回**移动端的**壳   → 防 loader 缺 SPA 兜底时被 app.ts 的全局兜底吞成 console 壳；
 *   ③ 产物引用带挂载点前缀     → 防 vite 的 base 没设，assets 与 console 的撞车。
 * @param {PhaseBase} b
 */
async function assertUserAppServing(b) {
  step('H6 移动端 userApp：入口与深链都回 SPA 壳，产物引用带挂载点前缀')
  check(
    existsSync(path.join(MOBILE_DIST, 'index.html')),
    `移动端构建产物存在：${path.relative(repoRoot, MOBILE_DIST)}（先跑 pnpm --filter @aftersales/mobile build）`,
  )

  const shell = readFileSync(path.join(MOBILE_DIST, 'index.html'))
  const webShell = readFileSync(path.join(webDistDir, 'index.html'))

  for (const p of [`${MOBILE_MOUNT}/`, MOBILE_MOUNT, `${MOBILE_MOUNT}/register`]) {
    const res = await b.get(p)
    check(res.status === 200, `GET ${p} 200`, describe(res))
    check(
      res.body.equals(shell),
      `GET ${p} 回的是**移动端**的 SPA 壳（不是 console 的、也不是 404）`,
      describe(res, { equalsWebShell: res.body.equals(webShell), bytes: res.body.length }),
    )
    check(
      String(res.headers['content-type'] ?? '').includes('text/html'),
      `GET ${p} content-type 是 html（实际 ${res.headers['content-type'] ?? '(空)'}）`,
      describe(res),
    )
  }

  // 产物路径前缀：index.html 里引的 assets 必须是挂载点前缀（vite 的 base 生效）
  const html = shell.toString('utf8')
  check(
    !/["'(]\/assets\//.test(html),
    'index.html 里**没有**裸 /assets/ 引用（有 ⇒ vite base 没设，会与 console 的产物撞路径）',
    html.slice(0, 800),
  )
  check(
    new RegExp(`["'(]${MOBILE_MOUNT}/assets/`).test(html),
    `index.html 里的产物引用带 ${MOBILE_MOUNT}/ 前缀`,
    html.slice(0, 800),
  )

  // 负例对照：不存在的子路径**落到 SPA 壳**正是对的——前端路由接管未命中的路径是 SPA 的
  // 正常行为，两套壳在这里**都**该吐自己的 index.html。这条真正要防的是它「吐了别的东西」：
  // 比如串到另一套壳的产物上（静态托管挂错根），那才是两套壳互相污染的症状。
  // （原文写的是「不该被假装成有内容」，与下面的断言正好相反，2026-09-16 订正。）
  const missing = await b.get(`${MOBILE_MOUNT}/definitely-not-a-real-asset.js`)
  check(
    missing.body.equals(shell),
    '深链落到 SPA 壳（同上，负例：非产物路径不吐别的东西）',
    describe(missing),
  )
}

// ---- 形态 1：multi（Host → 租户） ----

/** @param {ChildProcess} child @param {number} port @param {MockCasdoor} mock @returns {Promise<void>} */
async function runMulti(child, port, mock) {
  const b = base(port, TENANT_HOST)
  await waitReady(child, port, 'multi')

  step('multi：探活与租户解析')
  const health = await httpRequest({ port, path: '/healthz' }) // 探活不带租户 Host（LB/容器探针形状）
  check(health.status === 200 && json(health)?.ok === true, 'GET /healthz（无租户 Host）200 {ok:true}', describe(health))

  const branding = await b.get('/api/platform/branding')
  check(branding.status === 200, `GET /api/platform/branding（Host ${TENANT_HOST}）200`, describe(branding))
  check(json(branding)?.productName === ACME_PRODUCT_NAME, `branding 命中 acme（productName=${ACME_PRODUCT_NAME}）`, describe(branding))

  const config = await b.get('/api/platform/config')
  check(config.status === 200 && json(config)?.tenant?.slug === 'acme', 'config 的 tenant.slug = acme', describe(config))

  const unknown = await httpRequest({ port, host: UNKNOWN_HOST, path: '/api/platform/branding' })
  check(
    unknown.status === 404 && json(unknown)?.error === 'UNKNOWN_TENANT',
    `未注册 Host（${UNKNOWN_HOST}）→ 404 UNKNOWN_TENANT（无默认租户后门）`,
    describe(unknown),
  )

  await assertStaticServing(b)
  await assertUserAppServing(b)

  step('multi：权限码供给落到每个租户各自的 org（issue #3 第一节回归锁）')
  const mockCookie = await mockAdminCookie(mock)
  const acmeCodes = mock.permissionsIn('acme').flatMap((p) => p.resources ?? [])
  const betaCodes = mock.permissionsIn('beta').flatMap((p) => p.resources ?? [])
  // 先断【机制】再断【后果】——机制那条先红时，failure 直接指向"哪几个 org 被建了码"，
  // 比从"beta 缺码"反推快一步。
  //
  // 断言 org【集合】而不是调用【次数】：demo 恰好 2 条码、租户恰好 2 个 ⇒ 正常态 4 次、
  // 单 org 缺陷态 2 次，`count >= 2` 在两者下都为真（即它抓不住自己声称要抓的缺陷）。
  // 集合断言随租户/码数增长自然收紧，且直接表达"每个租户各自的 org 都被建了码"
  const provisionedOrgs = [...new Set(mock.addPermissionCalls.map((c) => c.owner))].sort()
  check(
    provisionedOrgs.join(',') === 'acme,beta',
    `装载器经 add-permission 建码覆盖两个租户 org（实际 [${provisionedOrgs.join(', ')}]）`,
    { provisionedOrgs, addPermissionCalls: mock.addPermissionCalls },
  )
  check(
    acmeCodes.includes('demo:view') && acmeCodes.includes('demo:note'),
    'acme org 内已建出 demo:view + demo:note',
    { acmeCodes, decoyPlatformOrg: DECOY_PLATFORM_ORG },
  )
  check(
    betaCodes.includes('demo:view') && betaCodes.includes('demo:note'),
    'beta org 内同样建出两条码 —— 修复前此处置空（写侧只落一个 org ⇒ 其余租户恒 403）',
    { betaCodes },
  )

  // 授予用户是租户管理员的事，与装载器建码分开：只授 acme，beta 刻意不授（下面用它证 403 在拦）
  await grantPermission(mock, mockCookie, 'acme', 'demo:view', [ADMIN1])
  await grantPermission(mock, mockCookie, 'acme', 'demo:note', [ADMIN1])

  step('multi：登录 / 授权 / 登出 全链路')
  const adminJar = new CookieJar()
  await login(b, adminJar, ADMIN1, 'admin1')
  const adminSession = await b.get('/api/platform/auth/session', { cookie: adminJar.header() })
  check(
    adminSession.status === 200 && json(adminSession)?.user?.name === ADMIN1,
    `GET /api/platform/auth/session 200（user=${ADMIN1}）`,
    describe(adminSession),
  )
  const scopes = json(adminSession)?.scopes ?? []
  check(scopes.includes('demo:view') && scopes.includes('demo:note'), `admin1 会话 scopes 含 demo:view+demo:note`, { scopes })

  // H4 正向对照：有权限 → 200（证明 403 是「授权在拦」，不是路由不存在/登录没生效）
  const pingOk = await b.get('/api/modules/demo/ping', { cookie: adminJar.header() })
  check(pingOk.status === 200 && json(pingOk)?.pong === true, 'admin1 GET /api/modules/demo/ping 200 {pong:true}', describe(pingOk))

  // issue #7：已声明的 GET 端点，HEAD 应与 GET 同权（探活/监控/CDN 预检都发 HEAD）。
  // 修复前此处恒 403（“资源存在却说没有”），与下面 viewer1 的 403 语义完全不同——
  // 这两个断言并列，才能把“归一后仍按 scope 拦”与“未声明即不可达”区分开。
  const pingHead = await b.head('/api/modules/demo/ping', { cookie: adminJar.header() })
  check(pingHead.status === 200, 'admin1 HEAD /api/modules/demo/ping 200（与 GET 同权，issue #7）', describe(pingHead))

  // H4 反向：viewer1 无 demo:view → 403（权限平面「授权真的在拦」的唯一端到端证据）
  const viewerJar = new CookieJar()
  await login(b, viewerJar, VIEWER1, 'viewer1')
  const pingDenied = await b.get('/api/modules/demo/ping', { cookie: viewerJar.header() })
  check(
    pingDenied.status === 403 && json(pingDenied)?.error === 'FORBIDDEN',
    `viewer1 GET /api/modules/demo/ping 403 FORBIDDEN（need=demo:view）`,
    describe(pingDenied),
  )
  check(
    !(json(await b.get('/api/platform/auth/session', { cookie: viewerJar.header() }))?.scopes ?? []).includes('demo:view'),
    'viewer1 会话 scopes 不含 demo:view（403 的原因可核实，而非泛化拒绝）',
  )
  const pingHeadDenied = await b.head('/api/modules/demo/ping', { cookie: viewerJar.header() })
  check(
    pingHeadDenied.status === 403,
    'viewer1 HEAD /api/modules/demo/ping 403（HEAD 归一后仍按 scope 拦，不因归一放宽授权）',
    describe(pingHeadDenied),
  )

  step('multi：登出（CSRF）→ 会话失效')
  const csrf = json(adminSession)?.csrfToken
  check(typeof csrf === 'string' && csrf.length > 0, '会话自画像带 csrfToken', { csrfToken: csrf })
  const logout = await b.post('/api/platform/auth/logout', {}, { cookie: adminJar.header(), headers: { 'x-csrf-token': csrf } })
  adminJar.apply(logout)
  check(logout.status === 200 && json(logout)?.ok === true, 'POST /api/platform/auth/logout 200', describe(logout))
  check(!adminJar.has('platform_session'), '登出响应清除了 platform_session cookie', { setCookie: logout.headers['set-cookie'] ?? null })

  const afterLogout = await b.get('/api/platform/auth/session', { cookie: adminJar.header() })
  check(
    afterLogout.status === 401 && json(afterLogout)?.error === 'UNAUTHENTICATED',
    '登出后 GET /api/platform/auth/session 401',
    describe(afterLogout),
  )

  // 对照：viewer1 的会话不受影响（登出只作用于自己的 cookie）
  const viewerStill = await b.get('/api/platform/auth/session', { cookie: viewerJar.header() })
  check(viewerStill.status === 200, 'viewer1 会话不受 admin1 登出影响（200）', describe(viewerStill))

  step('multi：beta 租户 —— 码在、授权不在 ⇒ 403（issue #3 第二节成因③）')
  const betaBase = base(port, BETA_HOST)
  const betaBranding = await betaBase.get('/api/platform/branding')
  check(
    betaBranding.status === 200 && json(betaBranding)?.productName === BETA_PRODUCT_NAME,
    `beta.test 解析到 beta 租户（productName=${BETA_PRODUCT_NAME}）`,
    describe(betaBranding),
  )
  const betaJar = new CookieJar()
  // 用 beta **自己的**用户：Casdoor 用户按 owner 归属，acme 的 admin1 在 beta 下查无此人
  // ⇒ 拿 admin1 登 beta 会被平台拒（替身拓扑下是 502；真机落点见下面那条负例的前提标注）
  await login(betaBase, betaJar, BETA_ADMIN1, 'beta')
  const betaSession = await betaBase.get('/api/platform/auth/session', { cookie: betaJar.header() })
  check(
    !((json(betaSession)?.scopes ?? []).includes('demo:view')),
    'beta 下 beta-admin1 的 scopes 不含 demo:view（授权只给了 acme）',
    { scopes: json(betaSession)?.scopes },
  )
  const betaPing = await betaBase.get('/api/modules/demo/ping', { cookie: betaJar.header() })
  check(
    betaPing.status === 403 && json(betaPing)?.error === 'FORBIDDEN',
    'beta 下 GET /api/modules/demo/ping 403 FORBIDDEN —— 码存在但未授权，403 是授权在拦',
    describe(betaPing),
  )
  // 负例：**跨 org 的用户不该能在本租户拿到会话** —— 这条是 org 归属语义的机检面：
  // 旧 mock 忽略 org 段，acme 的 admin1 能登进 beta 且拿到 200，本断言那时必红
  //
  // ⚠️ **前提依赖（评审 S3）：这条 502 押在 mock 的登录拓扑上，真机落点未验证。**
  // mock 的 /api/login 只按 name+password 查（**忽略 application**），故本场景在替身里是
  // "登录成功 ⇒ 再按 org=beta 查 get-user 无此人 ⇒ 502"。真机 /api/login 却是**按
  // application 定位 org** 的，而平台全租户共用同一个 CASDOOR_APPLICATION
  // （apps/server/src/app.ts）⇒ 真机更可能在**登录步**就回 200+status:error
  // （⇒ 401 BAD_CREDENTIALS），根本走不到 get-user 那一步。
  // 只读 GET 判不了真机的落点（要判定就得跨 org 发写探针——未获授权，不做）。
  // ⇒ 本断言钉住的是**平台侧对"跨 org 用户"的处置**（绝不放行跨 org 会话），**不是**真机
  //    登录步的确切响应码；换到真机拓扑时，这里的 502 可能要改判成 401，改前先按上述前提复核。
  const crossBase = base(port, BETA_HOST)
  const crossRes = await crossBase.post('/api/platform/auth/login', { username: ADMIN1, password: USER_PASSWORD })
  check(
    crossRes.status === 502 && json(crossRes)?.error === 'CASDOOR_UNAVAILABLE',
    'acme 的 admin1 在 beta 下登录 502（密码验过但 beta org 里查无此人 = 上游不一致）',
    describe(crossRes),
  )

  step('multi：模块 API 匿名不可达（声明即授权 —— 身份门卫在拦）')
  const anonPing = await httpRequest({
    port,
    host: TENANT_HOST,
    path: '/api/modules/demo/ping',
  })
  check(
    anonPing.status === 401 && json(anonPing)?.error === 'UNAUTHENTICATED',
    '匿名 GET /api/modules/demo/ping → 401 UNAUTHENTICATED（未声明 = 不可达的另一面：没身份就没门）',
    describe(anonPing),
  )

  // 上一条只证了「彻底没门」（没身份 ⇒ 401）。声明门卫与旧的模块手写 requireScope 在 401
  // 分支上逐字节一致，故它区分不出两者。下面这条打 declaredScopeGate 独有的 `!hit` 分支：
  // 【已声明路径 + 未声明 method】——GET /ping 在 manifest 里，POST /ping 不在。
  // 旧形态下模块压根没注册 POST /ping，落到 Hono 是 404；声明门卫则包在 router 外层、
  // 按声明比对（method 不匹配即 !hit），先于 router 一律 403。403 与 404 之别即「声明即授权」。
  // 断言必须同时钉住【无 need 字段】：带 need 的 403 是 scope 分支；无 need 才是 !hit 分支。
  // 会话用 viewerJar（登出段之后 adminJar 已失效，见上）；
  // viewer1 本就无 demo:view，仍拿到无 need 的 403，正说明 !hit 判在 hasScope 之前（fail-closed）。
  step('multi：已登录打「已声明路径的未声明 method」⇒ 403 无 need（declaredScopeGate 独有分支）')
  const undeclaredMethod = await httpRequest({
    port,
    host: TENANT_HOST,
    method: 'POST',
    path: '/api/modules/demo/ping',
    cookie: viewerJar.header(),
  })
  const undeclaredBody = json(undeclaredMethod)
  const noNeedField = undeclaredBody !== null && !('need' in undeclaredBody)
  check(
    undeclaredMethod.status === 403 && undeclaredBody?.error === 'FORBIDDEN' && noNeedField,
    'POST /api/modules/demo/ping（只声明了 GET）→ 403 无 need 字段（= 未声明 method 分支）',
    describe(undeclaredMethod),
  )

  step('multi：登录限速（连续失败达阈值 ⇒ 429，含 Retry-After）')
  // 专用用户名：本进程的限速器是幂等的内存状态，用 admin1 会把后续用例的登录一起拦掉。
  // 该段必须排在 runMulti 最后：限速状态一旦落进本进程，任何在此之后复用该用户名的登录都会被拦。
  const RL_USER = 'ratelimit-probe'
  const rlPost = () => httpRequest({
    port,
    host: TENANT_HOST,
    method: 'POST',
    path: '/api/platform/auth/login',
    body: JSON.stringify({ username: RL_USER, password: 'wrong' }),
  })
  // 阈值内每一次都无条件断言——不能写成「先看见 429 就 break」：那样第一个请求若被判 429，
  // 整段零条 401 断言会被求值，「阈值恰好是 N」这个事实就只剩运行结果佐证、没有被钉住。
  for (let i = 0; i < USER_FAIL_LIMIT; i++) {
    const res = await rlPost()
    check(res.status === 401, `第 ${i + 1} 次坏凭据登录 401（尚未达阈值）`, describe(res))
  }
  // 第 N+1 次才该被拦。check() 是前置判定（count >= USER_FAIL_LIMIT 即拒），
  // 故第 1..N 次皆 401，第 N+1 次起 429。
  const rlRes = await rlPost()
  check(
    rlRes.status === 429 && json(rlRes)?.error === 'TOO_MANY_REQUESTS',
    '连续失败达阈值后返回 429 TOO_MANY_REQUESTS',
    describe(rlRes),
  )
  check(
    Number(rlRes.headers['retry-after']) > 0,
    `429 带 Retry-After 头（实际 ${rlRes.headers['retry-after']}）`,
    { headers: rlRes.headers },
  )
}

// ---- 形态 2：single（PLATFORM_ORG 唯一租户） ----

/** @param {ChildProcess} child @param {number} port @param {MockCasdoor} mock @returns {Promise<void>} */
async function runSingle(child, port, mock) {
  const b = base(port, undefined) // 不带 Host：默认 127.0.0.1——single 模式 host 完全被忽略
  await waitReady(child, port, 'single')

  // single 与 multi 共用同一枚 mock（进程内单例），但本函数自持授权，不依赖 multi 先跑过——
  // 两个形态各自是一份可独立理解的验收
  const singleCookie = await mockAdminCookie(mock)
  await grantPermission(mock, singleCookie, 'acme', 'demo:view', [ADMIN1])
  await grantPermission(mock, singleCookie, 'acme', 'demo:note', [ADMIN1])

  step('single：无 Host 头也按 PLATFORM_ORG 命中')
  const branding = await b.get('/api/platform/branding')
  check(branding.status === 200, 'GET /api/platform/branding（默认 Host 127.0.0.1）200', describe(branding))
  check(
    json(branding)?.productName === ACME_PRODUCT_NAME,
    `branding 命中 PLATFORM_ORG=acme（productName=${ACME_PRODUCT_NAME}）`,
    describe(branding),
  )

  step('single：登录 → 模块 API 链路')
  const jar = new CookieJar()
  await login(b, jar, ADMIN1, 'admin1')
  const ping = await b.get('/api/modules/demo/ping', { cookie: jar.header() })
  check(ping.status === 200 && json(ping)?.pong === true, 'admin1 GET /api/modules/demo/ping 200 {pong:true}', describe(ping))
}

// ---- 主流程 ----

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error(
      'smoke-load: 缺少 DATABASE_URL。\n'
        + '  CI：job 需挂 postgres service 并注入 DATABASE_URL（见 .github/workflows/ci.yml 的 smoke job）；\n'
        + '  本地：docker compose -f deploy/docker-compose.yml up -d postgres，'
        + '然后 DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform tsx scripts/smoke-load.mjs',
    )
    process.exit(1)
  }
  if (!existsSync(serverDir)) {
    console.error(`smoke-load: 找不到宿主目录 ${serverDir}`)
    process.exit(1)
  }
  let [multiPort, singlePort] = SMOKE_PORT_ENV
    ? [Number(SMOKE_PORT_ENV), Number(SMOKE_PORT_ENV) + 1]
    : await freePorts(2)
  if (!Number.isInteger(multiPort) || multiPort < 1 || multiPort > 65534) {
    console.error(`smoke-load: SMOKE_PORT 不可用：${SMOKE_PORT_ENV}`)
    process.exit(1)
  }

  // MockCasdoor：multi 与 single 共用一枚（两次启动子进程，CASDOOR_URL 指向同一 mock）
  const mock = new MockCasdoor({
    // owner = 用户归属的 org（真机语义）：ACME 的两人归 acme，beta 那位归 beta。
    // 不标 owner 会落进 MOCK_ORG ⇒ `get-user?id=acme/admin1` 不命中 ⇒ 登录 502
    users: [
      { name: ADMIN1, password: USER_PASSWORD, displayName: 'Admin One', owner: 'acme' },
      { name: VIEWER1, password: USER_PASSWORD, displayName: 'Viewer One', owner: 'acme' },
      { name: BETA_ADMIN1, password: USER_PASSWORD, displayName: 'Beta Admin One', owner: 'beta' },
    ],
    // 刻意【不预种任何权限码】：预种会让装载器的 upsert 查重必命中、add-permission 全程零调用，
    // 于是「装载器真的建过码」这件事在门禁里不可见（issue #3 第二节成因②）。
    // 用户授权改由 grantPermission() 以租户管理员身份走 HTTP 完成——装载器建码、管理员授权是两件事
  })

  /**
   * 子进程公共 env：Casdoor 指向 mock；SEED_DEMO=1 种 acme/beta；secret/PUBLIC_ORIGIN 随本脚本
   * @param {number} port @param {string} tenantMode @param {string} platformOrg
   * @returns {Record<string, string>}
   */
  const commonEnv = (port, tenantMode, platformOrg) => ({
    DATABASE_URL: databaseUrl,
    CASDOOR_URL: mock.origin,
    CASDOOR_CLIENT_ID,
    CASDOOR_CLIENT_SECRET: '',
    CASDOOR_ADMIN_USER,
    CASDOOR_ADMIN_PWD,
    CASDOOR_APPLICATION: 'app-built-in',
    PLATFORM_SESSION_SECRET: SESSION_SECRET,
    PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
    PORT: String(port),
    TENANT_MODE: tenantMode,
    PLATFORM_ORG: platformOrg,
    SEED_DEMO: '1',
  })

  let multiChild
  let singleChild
  await mock.start()
  console.log(`smoke-load: MockCasdoor 就绪 ${mock.origin}`)
  console.log(`smoke-load: DATABASE_URL 已注入；multi=:${multiPort} single=:${singlePort}`)

  try {
    // 形态 1：multi —— PLATFORM_ORG 刻意设为【诱饵】（不指向任何租户）：供给必须由
    // platform.tenant 驱动，这个值不该在任何一处起作用（issue #3 第二节回归锁）
    multiChild = startServer(commonEnv(multiPort, 'multi', DECOY_PLATFORM_ORG), 'multi')
    await runMulti(multiChild, multiPort, mock)
    await stopServer(multiChild, 'multi')
    multiChild = undefined

    // 形态 2：single —— PLATFORM_ORG=acme，走「无 Host 头也按它命中租户」分支
    singleChild = startServer(commonEnv(singlePort, 'single', 'acme'), 'single')
    await runSingle(singleChild, singlePort, mock)
    await stopServer(singleChild, 'single')
    singleChild = undefined
  } finally {
    await stopServer(multiChild, 'multi')
    await stopServer(singleChild, 'single')
    await mock.stop()
  }

  console.log('\nsmoke-load: OK（multi + single 双形态全通过）')
  process.exit(0)
}

try {
  await main()
} catch (err) {
  // 断言失败（SmokeFailure）：标签已就地打印过，这里只补一行收束，不打无用的栈；
  // 其余异常（起不来 / 连不上 / 脚本自身 bug）：栈是排障的全部信息，原样打。
  console.error(
    err instanceof SmokeFailure
      ? `\nsmoke-load: FAILED — 断言未通过：${err.message}`
      : `\nsmoke-load: FAILED — ${err instanceof Error ? err.stack : String(err)}`,
  )
  process.exit(1)
}
