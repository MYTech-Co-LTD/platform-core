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
 * 修复前写侧拿它当供给 org、读侧按租户 org 读 —— 两条路分叉而冒烟照样全绿（issue #3 第二节实证）。
 * 修复后供给由 platform.tenant 驱动，这个值必须【完全不起作用】：全链路仍通过 ⇒ 写读同源。
 */
const DECOY_PLATFORM_ORG = 'NOT-ACME-ORG'

const USER_PASSWORD = 'pw'
const ADMIN1 = 'admin1' // 有 demo:view + demo:note
const VIEWER1 = 'viewer1' // 无任何 demo 权限——403 路径的唯一端到端证据

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
 * 一个形态的请求入口：固定 port/host，只暴露 get/post。
 * @typedef {object} PhaseBase
 * @property {number} port
 * @property {string | undefined} host
 * @property {(p: string, opts?: CallOptions) => Promise<HttpResponse>} get
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
 * 注意权限码的 name = code（CasdoorClient.upsertPermission 建码时 name 取 code，
 * manifest 里的中文名落在 displayName）——旧冒烟预种时用的 'p-demo-view' 是虚构的。
 * @param {MockCasdoor} mock @param {string} cookie
 * @param {string} org @param {string} permCode @param {string[]} users
 * @returns {Promise<void>}
 */
async function grantPermission(mock, cookie, org, permCode, users) {
  const res = await httpRequest({
    port: mock.port,
    method: 'POST',
    cookie,
    path: `/api/update-permission?id=${encodeURIComponent(`${org}/${permCode}`)}`,
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
  }
  // 对照组：SPA 兜底仍要工作（/ 返回 index.html 本体）——两条路径各自证明自己，不是「全都回 index」
  const spa = await b.get('/')
  check(spa.status === 200 && spa.body.equals(indexBytes), 'GET / 回 SPA index.html 本体（对照组）', describe(spa))
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

  step('multi：权限码供给落到每个租户各自的 org（issue #3 第一节回归锁）')
  const mockCookie = await mockAdminCookie(mock)
  const acmeCodes = mock.permissionsIn('acme').flatMap((p) => p.resources ?? [])
  const betaCodes = mock.permissionsIn('beta').flatMap((p) => p.resources ?? [])
  check(
    acmeCodes.includes('demo:view') && acmeCodes.includes('demo:note'),
    `acme org 内已建出 demo:view + demo:note（PLATFORM_ORG=${DECOY_PLATFORM_ORG} 是诱饵，供给不该依赖它）`,
    { acmeCodes, decoyPlatformOrg: DECOY_PLATFORM_ORG },
  )
  check(
    betaCodes.includes('demo:view') && betaCodes.includes('demo:note'),
    'beta org 内同样建出两条码 —— 修复前此处置空（写侧只落一个 org ⇒ 其余租户恒 403）',
    { betaCodes },
  )
  check(
    mock.addPermissionCalls.length >= 2,
    `装载器确实经 add-permission 建码（${mock.addPermissionCalls.length} 次）——修复前该调用数恒为 0`,
    { addPermissionCalls: mock.addPermissionCalls },
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
  await login(betaBase, betaJar, ADMIN1, 'beta')
  const betaSession = await betaBase.get('/api/platform/auth/session', { cookie: betaJar.header() })
  check(
    !((json(betaSession)?.scopes ?? []).includes('demo:view')),
    'beta 下 admin1 的 scopes 不含 demo:view（授权只给了 acme）',
    { scopes: json(betaSession)?.scopes },
  )
  const betaPing = await betaBase.get('/api/modules/demo/ping', { cookie: betaJar.header() })
  check(
    betaPing.status === 403 && json(betaPing)?.error === 'FORBIDDEN',
    'beta 下 GET /api/modules/demo/ping 403 FORBIDDEN —— 码存在但未授权，403 是授权在拦',
    describe(betaPing),
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
    users: [
      { name: ADMIN1, password: USER_PASSWORD, displayName: 'Admin One' },
      { name: VIEWER1, password: USER_PASSWORD, displayName: 'Viewer One' },
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
