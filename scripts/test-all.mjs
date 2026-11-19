// @ts-nocheck —— CLI 薄壳（同 scope-preflight.mjs）：pg 经 createRequire 从 apps/server 取，
//   typecheck:scripts 的 checkJs 推不出类型；逻辑是进程编排，无可单测的纯核。
//
// test-all.mjs —— 跑全部 workspace 包的测试，**每个包一套独立数据库**。
//
// 为什么（2026-11-19，#2524 的根因）：`pnpm -r --if-present test` 让最多 4 个包**并发**打同一台
// PG。迁移执行器的 advisory lock 键是**全库唯一**的（apps/server/src/migrate.ts 文件头 / #310），
// 于是 A 包在跑迁移时 B 包的 beforeAll 只能排队；共享库还会让 TRUNCATE 一类清理互相踩。
// 缩短取锁间隔只是把「放大倍数」调小，**共享状态本身没消除**——真正隔离是每个包一个库。
//
// 行为：
//   · 有 DATABASE_URL ⇒ 按包名派生 `<base 库名>_<slug>`，不存在就建；每包用自己那条连接串
//   · 没有 DATABASE_URL ⇒ 逐字退回今天的行为（不加 DATABASE_URL，包自己跳过 DB 用例）
//   · 并发 4（与 pnpm -r 默认一致）；单包失败**单独回放它的输出**，不淹没在交错日志里
//
// 用法：node scripts/test-all.mjs
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')
const CONCURRENCY = Number(process.env.TEST_CONCURRENCY || 4)
const PKG_TIMEOUT_MS = Number(process.env.TEST_PKG_TIMEOUT_MS || 20 * 60_000)

function discoverPackages() {
  const globs = ['apps/*', 'packages/*', 'modules/*', 'modules/*/*']
  const fs = createRequire(import.meta.url)('node:fs')
  const dirs = []
  for (const g of globs) {
    // node:fs.globSync 需要 Node 22+；本仓 CI 是 22。取不到就退回手写一层/两层目录扫描。
    if (typeof fs.globSync === 'function') {
      dirs.push(...fs.globSync(g, { cwd: ROOT }))
      continue
    }
    const [parent, child] = g.split('/')
    const tops = fs.readdirSync(path.join(ROOT, parent), { withFileTypes: true }).filter((d) => d.isDirectory())
    if (!child) dirs.push(...tops.map((d) => path.join(parent, d.name)))
    else {
      for (const t of tops) {
        const sub = path.join(ROOT, parent, t.name)
        if (!existsSync(sub)) continue
        for (const d of fs.readdirSync(sub, { withFileTypes: true })) {
          if (d.isDirectory()) dirs.push(path.join(parent, t.name, d.name))
        }
      }
    }
  }
  const out = []
  for (const d of [...new Set(dirs)]) {
    const pj = path.join(ROOT, d, 'package.json')
    if (!existsSync(pj)) continue
    const pkg = JSON.parse(readFileSync(pj, 'utf8'))
    if (!pkg.scripts?.test) continue
    out.push({ dir: d, name: pkg.name })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function slugOf(name) {
  return name
    .replace(/^@/, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .slice(0, 40)
}

function withDbName(url, dbName) {
  const u = new URL(url)
  u.pathname = `/${dbName}`
  return u.toString()
}

async function ensureDatabases(pkgs, baseUrl) {
  const require = createRequire(path.join(ROOT, 'apps/server/package.json'))
  const { Client } = require('pg')
  const admin = new URL(baseUrl)
  const adminUrl = withDbName(baseUrl, admin.pathname.replace(/^\//, '') || 'postgres')
  const client = new Client({ connectionString: adminUrl })
  await client.connect()
  const mapping = new Map()
  try {
    for (const p of pkgs) {
      const db = `${(admin.pathname.replace(/^\//, '') || 'platform')}_${slugOf(p.name)}`
      // 建库不是幂等 DDL：先查 pg_database，避免每次靠吞异常
      const exists = (await client.query('select 1 from pg_database where datname = $1', [db])).rowCount > 0
      if (!exists) await client.query(`create database "${db}"`)
      mapping.set(p.name, withDbName(baseUrl, db))
    }
  } finally {
    await client.end()
  }
  return mapping
}

function runPackage(p, env) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = execFile(
      'pnpm',
      ['--filter', p.name, 'test'],
      { cwd: ROOT, env, timeout: PKG_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          name: p.name,
          ok: !err,
          ms: Date.now() - started,
          output: `${stdout || ''}${stderr || ''}`,
          timedOut: Boolean(err?.killed),
        })
      },
    )
    child.on('error', () => {}) // execFile 的回调已覆盖
  })
}

async function pool(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await worker(items[i])
    }
  })
  await Promise.all(runners)
  return results
}

const pkgs = discoverPackages()
if (pkgs.length === 0) {
  console.error('test-all: 没发现任何带 test 脚本的包——判据失效，显式失败而不是静默通过')
  process.exit(1)
}

const baseUrl = process.env.DATABASE_URL
let dbMap = new Map()
if (baseUrl) {
  try {
    dbMap = await ensureDatabases(pkgs, baseUrl)
    console.log(`test-all: 每包独立库（${pkgs.length} 个）`)
  } catch (e) {
    console.error(`test-all: 建独立库失败（${e.message}）⇒ 退回共享库跑（仍可判红，但失去隔离）`)
  }
}

const results = await pool(pkgs, CONCURRENCY, (p) => {
  const env = { ...process.env }
  const own = dbMap.get(p.name)
  if (own) env.DATABASE_URL = own
  return runPackage(p, env)
})

let failed = 0
for (const r of results) {
  const tag = r.ok ? '✓' : '✗'
  console.log(`${tag} ${r.name.padEnd(28)} ${(r.ms / 1000).toFixed(1)}s${r.timedOut ? ' (超时被杀)' : ''}`)
  if (!r.ok) failed += 1
}
if (failed > 0) {
  for (const r of results.filter((x) => !x.ok)) {
    console.log(`\n===== ${r.name} 输出 =====`)
    console.log(r.output.slice(-8000))
  }
  console.error(`\ntest-all: ${failed}/${results.length} 个包失败`)
  process.exit(1)
}
console.log(`\ntest-all: ${results.length} 个包全绿`)
