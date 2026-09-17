#!/usr/bin/env node
// dev-stack.mjs — 本地长驻开发栈：MockCasdoor + 宿主进程 + 本机 PG，一条命令起、Ctrl-C 收。
//
// 用法：
//   tsx scripts/dev-stack.mjs                          # → http://127.0.0.1:13100
//   DEV_STACK_PORT=13200 tsx scripts/dev-stack.mjs     # 换端口（PUBLIC_ORIGIN 跟着变）
//
// 前置：
//   ① **已构建 web** —— `pnpm --filter @platform/web build`。缺 dist 时宿主只 warn 一次就继续
//      起服务（app.ts 的「跳过静态托管」分支），表现是 /healthz 照绿而**页面全白**；把
//      这个静默降级留给人肉发现是本脚本最该拦的一类假绿，故**脚本显式拦下、直接退出**。
//   ② **可连的 PG** —— 本仓 compose 的服务名是 `postgres`：
//        docker compose -f deploy/docker-compose.yml up -d postgres
//      这一条**不预检**（脚本给不出比宿主启动日志更准的诊断）：连不上时宿主会在启动期抛错，
//      子进程提前退出，waitReady 立即失败并把宿主日志透传出来。5432 被别的实例占用时改
//      `DATABASE_URL=… pnpm dev:stack` 指过去（默认值见下）。
//
// 与 scripts/smoke-load.mjs 的分工（**别把两者合并**）：
//   smoke-load = 门禁。断言导向、跑完即杀、退出码 0/1，CI 每次 push 跑；它没有「让人打开
//     浏览器看一眼」这个使用场景。
//   dev-stack  = 人用。长驻到 Ctrl-C，宿主日志透传，启动后打印可点的 URL，供
//     docs/m0-smoke-checklist.md 的 A2（手工 curl 复现）与 C1（console 演示页浏览器验证）使用。
//   两者共用 MockCasdoor 与同一套 env 契约，但生命周期相反——合并只会给门禁加一条永不退出
//   的分支（在 CI 上就是挂死到超时）。
//
// 为什么是「脚本自持 env」而不是「读 .env」（这是本脚本存在的理由，A2 原本做不到的正是这条）：
//   原 A2 的复现路径要求人手填根 .env，**并且**另起一个未提交、被 gitignore 的 TCP 转发
//   （.tmp/mock-casdoor-net.ts）来把只绑 127.0.0.1 的 MockCasdoor 暴露给容器——克隆下来的人
//   没有那个文件，照着文档做必然卡在「容器连不上 Casdoor → upsertPermission 抛错 →
//   restart loop → 文档里的 200 永远不出现」。本脚本把这些值全部内联成常量，且**不读 .env**
//   （子进程 cwd=apps/server，dotenv 在那里也找不到根 .env），于是「克隆 + 装依赖 + 建 web +
//   起 PG」即可复现，零未跟踪前置物。
//
// 为什么默认端口是 13100 而不是 13000：13000 是 `pnpm dev` 与 compose 的默认端口——「开着
//   dev server 再跑一次验证」是本地高频动作，撞车只会制造 EADDRINUSE 噪音（smoke-load 用
//   内核随机端口是同一个理由）。这里取一个不参与任何默认值的端口，作为「人用栈」的固定入口。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MockCasdoor } from '../packages/auth-core/src/test-util/mock-casdoor.ts'

// ---- 路径解析（一律按本文件位置，与 cwd 无关） ----
const scriptsDir = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = path.resolve(scriptsDir, '..')
const serverDir = path.join(repoRoot, 'apps', 'server')
const webDistIndex = path.join(repoRoot, 'apps', 'web', 'dist', 'index.html')

// ---- 常量：本脚本是这些值的唯一事实源（与 smoke-load 同款契约，改一处即可） ----
const DEFAULT_PORT = 13100
/** 本仓 compose 的 postgres（user/pass/db 皆 platform）；宿主访问走 127.0.0.1:5432 */
const DEFAULT_DATABASE_URL = 'postgres://platform:platform@127.0.0.1:5432/platform'
/** ≥32 字符（config.ts 强校验）；仅本地 mock 用，与任何真实环境的密钥无关 */
const SESSION_SECRET = 'dev-stack-secret-dev-stack-secret!!'
const CASDOOR_CLIENT_ID = 'dev-stack-client'
/** MockCasdoor 内置 admin（构造器保证存在）；upsertPermission 的管理会话用它 */
const CASDOOR_ADMIN_USER = 'admin'
const CASDOOR_ADMIN_PWD = 'pw'
const CASDOOR_APPLICATION = 'app-built-in'
/** single 模式的唯一租户 org —— demo 种子（seed.ts）里的 acme 就是它 */
const PLATFORM_ORG = 'acme'
const USER_PASSWORD = 'pw'
/** 有 demo:view + demo:note（C1 要看的便签列表只有 demo:note 才渲染） */
const ADMIN1 = 'admin1'
/** 无任何 demo 权限——手工复现 403 路径的对照组（清单 A2 的配套对照要它） */
const VIEWER1 = 'viewer1'
const READY_TIMEOUT_MS = 30_000

/** @typedef {import('node:child_process').ChildProcess} ChildProcess */

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 建一个连得上 /healthz 的探针请求；失败（尚未监听）一律吞掉，由调用方的轮询节奏兜底。
 * @param {number} port
 * @returns {Promise<boolean>}
 */
async function healthy(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`)
    return res.status === 200
  } catch {
    return false
  }
}

/** tsx 入口：优先 pnpm 装的 .bin shim，缺失时回落 node 直跑 tsx/cli 出口 */
function tsxRunner() {
  const shim = path.join(repoRoot, 'node_modules', '.bin', 'tsx')
  if (existsSync(shim)) return { cmd: shim, args: [] }
  return { cmd: process.execPath, args: [fileURLToPath(import.meta.resolve('tsx/cli'))] }
}

/**
 * 起宿主子进程。日志（stdout+stderr）透传到本进程 stderr：排障时直接看到启动期的
 * warn/报错（「跳过静态托管」那一行就在这里）。
 * @param {Record<string, string>} env
 * @returns {ChildProcess}
 */
function startServer(env) {
  const tsx = tsxRunner()
  const child = spawn(tsx.cmd, [...tsx.args, 'src/index.ts'], {
    cwd: serverDir, // modules/ 按 cwd/../../modules 解析（app.ts）——必须是 apps/server
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // 杀进程组：tsx CLI 会再 fork 一个 node 跑 entry，只杀它会留孤儿占端口
  })
  /** @param {unknown} buf */
  const relay = (buf) => process.stderr.write(String(buf).replace(/^/gm, '[server] '))
  child.stdout.on('data', relay)
  child.stderr.on('data', relay)
  return child
}

/**
 * 轮询 /healthz 直到 200；子进程提前退出即立刻失败（不等满超时）。
 * @param {ChildProcess} child @param {number} port @returns {Promise<void>}
 */
async function waitReady(child, port) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`宿主提前退出，code=${child.exitCode}（日志见上）`)
    if (await healthy(port)) return
    await sleep(200)
  }
  throw new Error(`宿主未在 ${READY_TIMEOUT_MS}ms 内就绪（/healthz 未回 200）`)
}

/**
 * 优雅停：SIGTERM 整组 → 宽限 5s → SIGKILL 整组。
 * @param {ChildProcess | undefined} child @returns {Promise<void>}
 */
async function stopServer(child) {
  if (!child || child.exitCode !== null || child.pid === undefined) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM') // 进程组已消失（或平台不支持负 pid）：退回单进程信号
  }
  const ok = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)])
  if (ok) return
  console.error('[dev-stack] 宿主 SIGTERM 后 5s 未退出，SIGKILL')
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
  await Promise.race([exited, sleep(2000)])
}

/** 等一个终止信号；Ctrl-C / SIGTERM 都归到这里，收尸逻辑在 main 的 finally 里统一跑 */
function waitForShutdown() {
  return new Promise((resolve) => {
    process.once('SIGINT', () => resolve(undefined))
    process.once('SIGTERM', () => resolve(undefined))
  })
}

/** @param {string} url */
function banner(url) {
  console.log(
    [
      '',
      'dev-stack: 栈已就绪（MockCasdoor + 宿主；Ctrl-C 收）',
      `  登录页    ${url}/login           账号 ${ADMIN1} / ${USER_PASSWORD}`,
      `  控制台    ${url}/console`,
      `  演示页    ${url}/console/demo    ← C1：左侧菜单「演示」点进来的落点`,
      `  售后页    ${url}/console/aftersales  ← M3a：左侧菜单「售后管理」（五个页签）`,
      `  模块 API  ${url}/api/modules/demo/notes`,
      `  对照组    ${VIEWER1} / ${USER_PASSWORD}（无 demo:view → 模块 API 403）`,
      '',
      '  说明：Casdoor 侧是 MockCasdoor（真实 HTTP + 真实 CasdoorClient 代码路径）。',
      '       对着真实 Casdoor 的登录见 docs/m0-smoke-checklist.md 的 B2。',
      '',
    ].join('\n'),
  )
}

async function main() {
  const port = Number(process.env.DEV_STACK_PORT ?? DEFAULT_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`dev-stack: DEV_STACK_PORT 必须是 1-65535 的整数，当前=${JSON.stringify(process.env.DEV_STACK_PORT)}`)
    process.exit(1)
  }
  const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL

  // 前置①：缺 web 产物时**先死**——否则宿主只 warn 一行就继续起，页面全白而 /healthz 照绿
  if (!existsSync(webDistIndex)) {
    console.error(
      `dev-stack: 缺 web 构建产物 ${path.relative(repoRoot, webDistIndex)}。\n`
        + '  先跑：pnpm --filter @platform/web build\n'
        + '  （不建也能起，但宿主会跳过静态托管——页面全白、/healthz 照绿，这种假绿不在这里放行）',
    )
    process.exit(1)
  }

  const mock = new MockCasdoor({
    // owner 同权限的 owner：用户按 (org,name) 命中（评审 S3），不标 owner 会落进 MOCK_ORG
    // ⇒ `get-user?id=acme/admin1` 不命中 ⇒ 登录 502
    users: [
      { name: ADMIN1, password: USER_PASSWORD, displayName: 'Admin One', owner: 'acme' },
      { name: VIEWER1, password: USER_PASSWORD, displayName: 'Viewer One', owner: 'acme' },
    ],
    perms: [
      // owner 必须与租户 org 一致（TENANT_MODE=single, PLATFORM_ORG='acme' → 租户
      // casdoor_org='acme'）：权限按 org 分桶后，不标 owner 的种子会落进 MOCK_ORG 桶，
      // acme 的 client 读不到 ⇒ 装载器另建一枚 users 为空的码 ⇒ admin1 scopes 恒空、
      // 模块 API 全 403。docs/m0-smoke-checklist.md 的 C1 复现路径押在这里
      { owner: 'acme', name: 'p-demo-view', users: [ADMIN1], resources: ['demo:view'] },
      { owner: 'acme', name: 'p-demo-note', users: [ADMIN1], resources: ['demo:note'] },
      // 售后模块（M3a）：不种这枚码，模块 API 全 403、console 菜单条目也不出现
      // ⇒ 新模块在本地**无法验收**（`aftersales:manage` 是它的管理台唯一入口码）。
      { owner: 'acme', name: 'p-aftersales-manage', users: [ADMIN1], resources: ['aftersales:manage'] },
      // 平台内置管理码（M3c）：不种它 ⇒ 「管理」菜单组与 /console/admin/* 的 AdminGate 都进不去
      // ⇒ **存储配置页本地不可达、无法验收**（`tenant:admin` 是它的唯一入口码，与上面那条同形）。
      // 载入器会把该码供给到本租户 org；这里种的是**把码发给 admin1** 这一步（两件事）。
      { owner: 'acme', name: 'p-tenant-admin', users: [ADMIN1], resources: ['tenant:admin'] },
    ],
  })

  /** @type {ChildProcess | undefined} */
  let child
  await mock.start()
  const url = `http://127.0.0.1:${port}`

  try {
    child = startServer({
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      TENANT_MODE: 'single', // 浏览器直接开 127.0.0.1 即可——single 模式不按 Host 解析租户
      PLATFORM_ORG,
      PLATFORM_SESSION_SECRET: SESSION_SECRET,
      CASDOOR_URL: mock.origin,
      CASDOOR_CLIENT_ID,
      CASDOOR_CLIENT_SECRET: '',
      CASDOOR_ADMIN_USER,
      CASDOOR_ADMIN_PWD,
      CASDOOR_APPLICATION,
      PUBLIC_ORIGIN: url,
      SEED_DEMO: '1', // 幂等种 acme/beta（含 demo 模块启用）
    })
    await waitReady(child, port)
    console.log(`dev-stack: MockCasdoor ${mock.origin} / PG ${databaseUrl}`)
    banner(url)
    child.once('exit', (code) => {
      // 宿主自己死了 = 栈没了，别让人对着一片安静的空栈猜
      console.error(`dev-stack: 宿主进程退出 code=${code}——收栈`)
      process.kill(process.pid, 'SIGTERM')
    })
    await waitForShutdown()
  } finally {
    await stopServer(child)
    await mock.stop()
    console.log('\ndev-stack: 已收栈（宿主进程组 + MockCasdoor 均已停）')
  }
}

try {
  await main()
} catch (err) {
  console.error(`dev-stack: FAILED — ${err instanceof Error ? err.stack : String(err)}`)
  process.exit(1)
}
