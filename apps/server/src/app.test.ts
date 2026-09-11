// app.test.ts — 宿主装配（Task 16）的启动期行为。
//
// 本文件目前只锁一件事，但它是一个**曾经只在文档里存在**的分支：
// 「未配 CASDOOR_ADMIN_USER/_PWD ⇒ 权限码供给只 warn 跳过、服务照常启动」。
// M1 闭债轮里 app.ts 无条件把工厂传给装载器，该分支从 buildApp 根本走不到——真实行为是
// CasdoorClient 抛「adminUser/adminPwd not configured」→ buildApp 抛 → 进程起不来，而
// 文档（spec §3.5 / openship-adopt.md / CHANGELOG）都写着"只 warn 跳过"。
// 全仓唯一能跑出这条路径的地方就是这里：冒烟与 dev:stack 都带 admin 凭据。
//
// 两条用例是一对，缺一不可：只测"没凭据能起"，一个"永远不供给"的实现也能过；
// 只测"有凭据会供给"，则漏掉被修的那条路径。
//
// 真 PG（同 migrate/tenant/loader.test.ts 约定）：未提供 DATABASE_URL 时整体跳过。
import { afterAll, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app'
import { closePools } from './db'
import type { AppConfig, CasdoorConfig } from './config'

const dbUrl = process.env.DATABASE_URL

/** 不可达的 Casdoor：凭据齐全时供给必抛，凭据缺失时压根不该发请求（对照就建立在这上面） */
const UNREACHABLE_CASDOOR = 'http://127.0.0.1:1'

function configWith(casdoor: CasdoorConfig): AppConfig {
  return {
    port: 13000,
    databaseUrl: dbUrl!,
    tenantMode: 'single',
    platformOrg: 'acme',
    sessionSecret: 'test-secret-test-secret-test-secret!',
    casdoor,
    publicOrigin: 'http://127.0.0.1:13000',
    seedDemo: true, // 让租户表非空，warn 才能点名租户 org
  }
}

const baseCasdoor: CasdoorConfig = {
  url: UNREACHABLE_CASDOOR,
  clientId: 'test-client',
  clientSecret: '',
  application: 'app-built-in',
}

describe.skipIf(!dbUrl)('buildApp：权限码供给的凭据闸门', () => {
  afterAll(async () => {
    // 池是模块级缓存的单例：不关掉会把进程挂住（vitest 报 open handle）
    await closePools()
  })

  it('★ 未配 admin 凭据：不抛错、正常装配，且 warn 点名哪些租户将全线 403', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // 修复前这里会抛 CasdoorClient: adminUser/adminPwd not configured
      const { app, modules } = await buildApp({ config: configWith(baseCasdoor) })
      expect(app).toBeDefined()
      expect(modules.modules.length).toBeGreaterThan(0) // demo 模块照常装载

      const lines = warn.mock.calls.map((c) => String(c[0]))
      expect(lines.some((l) => l.includes('跳过权限码供给'))).toBe(true)
      // 点名胜过泛泛一句"跳过了"——403 的归因成本全在排障者身上
      expect(lines.some((l) => l.includes('403') && l.includes('acme'))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it('配了 admin 凭据：确实去供给（同样的不可达 url 下改为抛错）', async () => {
    // 与上一条只差凭据：url 完全一样。上一条安然装配 ⇒ 证明没发请求；这一条必须抛。
    // 断言不锁具体错误文案：连不上时抛的是 fetch failed / ECONNREFUSED（不是 casdoor 文案），
    // 锁文案会锁到 undici 的实现细节上。真正的判据是"没走跳过分支"——那由下面这条覆盖
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(
        buildApp({ config: configWith({ ...baseCasdoor, adminUser: 'admin', adminPwd: 'pw' }) }),
      ).rejects.toThrow()
      const lines = warn.mock.calls.map((c) => String(c[0]))
      expect(lines.some((l) => l.includes('跳过权限码供给'))).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })
})
