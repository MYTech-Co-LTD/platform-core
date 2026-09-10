// tenant.test.ts — 租户解析中间件 + /api/platform/branding|config + seedDemo 语义钉死。
// 真 PG（本地 docker platform-pg，同 migrate.test.ts 约定）：未提供 DATABASE_URL 时整体跳过。
// 幂等收敛：seedDemo 重跑 N 次状态一致；中途改库的用例自行 re-seed 还原，跨会话零污染。
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { Hono } from 'hono'
import { testClient } from 'hono/testing'
import { fileURLToPath } from 'node:url'
import { runMigrations } from './migrate'
import {
  getTenantByHost,
  resetTenantOrgCache,
  resolveTenantMiddleware,
  type TenantEnv,
} from './tenant'
import { platformRoutes, type PlatformRoutesDeps } from './routes/platform'
import { seedDemo } from './seed'

const dbUrl = process.env.DATABASE_URL
const serverMigrationsDir = fileURLToPath(new URL('./migrations', import.meta.url))

// 客户端类型（makeApp 返回值）：testClient 对 Hono<TenantEnv> 的推断产物
type AppClient = ReturnType<
  typeof testClient<ReturnType<typeof makeBareApp>>
>

function makeBareApp() {
  return new Hono<TenantEnv>()
}

describe.skipIf(!dbUrl)('租户解析 + platform 路由 + seed', () => {
  let pool: Pool

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    await runMigrations(pool, 'platform', serverMigrationsDir)
    await seedDemo(pool)
  })

  beforeEach(() => {
    resetTenantOrgCache() // single 模式 org 缓存跨用例隔离
  })

  function makeApp(
    mode: 'multi' | 'single',
    platformOrg = '',
    deps?: PlatformRoutesDeps,
  ): AppClient {
    const app = makeBareApp()
    app.use('*', resolveTenantMiddleware({ pool, mode, platformOrg }))
    app.route('/api/platform', platformRoutes(deps ?? { pool }))
    return testClient(app)
  }

  // —— getTenantByHost 直测 ——

  it('multi：去端口 + 大小写归一后命中；未知域返回 null', async () => {
    const hit = await getTenantByHost(pool, 'acme.test:8443', 'multi', '')
    expect(hit?.slug).toBe('acme')
    expect(hit?.product_name).toBe('Acme 工单')
    expect(await getTenantByHost(pool, 'ACME.test', 'multi', '')).not.toBeNull()
    expect(await getTenantByHost(pool, 'unknown.test', 'multi', '')).toBeNull()
  })

  it('single：忽略 host、按 platformOrg 命中', async () => {
    const row = await getTenantByHost(pool, 'whatever.test', 'single', 'acme')
    expect(row?.slug).toBe('acme')
  })

  it('single：60s 内存缓存——缓存期内改库不见新值，reset 后自愈；multi 无缓存即时可见', async () => {
    // 首查入缓存
    expect((await getTenantByHost(pool, 'a.test', 'single', 'acme'))?.product_name).toBe('Acme 工单')
    // 改库
    await pool.query("update platform.tenant set product_name='Acme 改' where slug='acme'")
    // single：60s 内仍回缓存旧值（请求期不查库）
    expect((await getTenantByHost(pool, 'b.test', 'single', 'acme'))?.product_name).toBe('Acme 工单')
    // multi：不走缓存，立即可见
    expect((await getTenantByHost(pool, 'acme.test', 'multi', ''))?.product_name).toBe('Acme 改')
    // reset 缓存后 single 见新值
    resetTenantOrgCache()
    expect((await getTenantByHost(pool, 'c.test', 'single', 'acme'))?.product_name).toBe('Acme 改')
    // 还原 demo 状态
    await seedDemo(pool)
  })

  // —— 中间件（经端到端请求钉死）——

  it('multi：Host=acme.test → 命中 acme（branding 透出 product_name）', async () => {
    const client = makeApp('multi')
    const res = await client.api.platform.branding.$get(undefined, {
      headers: { host: 'acme.test' },
    })
    expect(res.status).toBe(200)
    expect((await res.json()).productName).toBe('Acme 工单')
  })

  it('multi：未注册 Host → 404 {"error":"UNKNOWN_TENANT"}（不留后门）', async () => {
    const client = makeApp('multi')
    const res = await client.api.platform.branding.$get(undefined, {
      headers: { host: 'unknown.test' },
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'UNKNOWN_TENANT' })
  })

  it('single：任意 Host（含 beta.test）都得 acme', async () => {
    const client = makeApp('single', 'acme')
    for (const host of ['whatever.example', 'beta.test', 'acme.test:13000']) {
      const res = await client.api.platform.branding.$get(undefined, {
        headers: { host },
      })
      expect(res.status).toBe(200)
      expect((await res.json()).productName).toBe('Acme 工单')
    }
  })

  it('single：org 查不到 → 中间件抛错（500，启动级问题不静默 404）', async () => {
    const client = makeApp('single', 'no-such-org')
    const res = await client.api.platform.branding.$get(undefined, {
      headers: { host: 'acme.test' },
    })
    expect(res.status).toBe(500)
  })

  // —— /api/platform/branding ——

  it('branding：tenant 行 → 驼峰全映射；acme 回 wecomCorpId、beta（无企微方法）不回该键', async () => {
    const client = makeApp('multi')
    const acme = await (
      await client.api.platform.branding.$get(undefined, { headers: { host: 'acme.test' } })
    ).json()
    expect(acme).toEqual({
      productName: 'Acme 工单',
      logo: null,
      primaryColor: '#1890ff',
      background: 'default',
      loginMethods: ['password', 'wecom-qr'],
      wecomCorpId: 'ww_demo_corp',
    })
    const betaRes = await client.api.platform.branding.$get(undefined, {
      headers: { host: 'beta.test' },
    })
    const beta = await betaRes.json()
    expect(beta).toEqual({
      productName: 'Beta 平台',
      logo: null,
      primaryColor: '#1890ff',
      background: 'default',
      loginMethods: ['password'],
    })
    expect(beta).not.toHaveProperty('wecomCorpId')
  })

  it('branding：企微方法开了但 wecom_corp_id 空 → 仍不回 wecomCorpId', async () => {
    await pool.query("update platform.tenant set login_methods='{wecom-silent}' where slug='beta'")
    const client = makeApp('multi')
    const res = await client.api.platform.branding.$get(undefined, {
      headers: { host: 'beta.test' },
    })
    expect(await res.json()).not.toHaveProperty('wecomCorpId')
    await seedDemo(pool) // 收敛还原
  })

  // —— /api/platform/config ——

  it('config：modules 经 enabledFor 过滤 + 空 console 剔除；tenant 回 slug/org', async () => {
    const ids = await pool.query<{ id: number; slug: string }>(
      "select id, slug from platform.tenant where slug in ('acme','beta')",
    )
    const idBySlug = new Map(ids.rows.map((r) => [r.slug, r.id]))
    const acmeId = idBySlug.get('acme')!
    const client = makeApp('multi', '', {
      pool,
      modules: () => [
        {
          id: 'demo',
          name: 'Demo',
          console: [
            { path: '/demo', title: 'Demo 页', icon: 'smile', scope: 'demo:view' },
            { path: '/demo/other', title: 'Other', scope: 'demo:view' }, // icon 缺省原样透传
          ],
        },
        { id: 'ghost', name: 'Ghost', console: [{ path: '/ghost', title: 'Ghost', scope: 'ghost:view' }] },
        { id: 'empty', name: 'Empty', console: [] }, // 启用了但无 console → 不回
      ],
      enabledFor: async (tenantId) =>
        new Set(tenantId === acmeId ? ['demo', 'empty'] : []),
    })
    const res = await client.api.platform.config.$get(undefined, {
      headers: { host: 'acme.test' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      tenant: { slug: 'acme', org: 'acme' },
      modules: [
        {
          id: 'demo',
          name: 'Demo',
          console: [
            { path: '/demo', title: 'Demo 页', icon: 'smile', scope: 'demo:view' },
            { path: '/demo/other', title: 'Other', scope: 'demo:view' },
          ],
        },
      ],
    })
    // beta：enabledFor 空集 → modules 空
    const betaRes = await client.api.platform.config.$get(undefined, {
      headers: { host: 'beta.test' },
    })
    expect((await betaRes.json()).modules).toEqual([])
  })

  it('config：deps 缺省（modules/enabledFor 空实现）→ modules 空数组', async () => {
    const client = makeApp('multi')
    const res = await client.api.platform.config.$get(undefined, {
      headers: { host: 'acme.test' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.tenant).toEqual({ slug: 'acme', org: 'acme' })
    expect(body.modules).toEqual([])
  })

  // —— seedDemo ——

  it('seedDemo：幂等收敛——两租户/两域名/demo 模块两行 enabled，重跑不变', async () => {
    await seedDemo(pool)
    await seedDemo(pool) // 重跑即幂等验证
    const tenants = await pool.query<{ slug: string }>(
      "select slug from platform.tenant where slug in ('acme','beta') order by slug",
    )
    expect(tenants.rows.map((r) => r.slug)).toEqual(['acme', 'beta'])
    const domains = await pool.query<{ domain: string }>(
      'select domain from platform.tenant_domain order by domain',
    )
    expect(domains.rows.map((r) => r.domain)).toEqual(['acme.test', 'beta.test'])
    const mods = await pool.query<{ n: number }>(
      "select count(*)::int as n from platform.tenant_module where module_id='demo' and enabled",
    )
    expect(mods.rows[0].n).toBe(2)
  })

  it('seedDemo：清掉租户名下的历史脏域名（收敛到目标集）', async () => {
    await pool.query(
      "insert into platform.tenant_domain(tenant_id, domain) select id, 'stale.acme.test' from platform.tenant where slug='acme'",
    )
    await seedDemo(pool)
    const stale = await pool.query<{ n: number }>(
      "select count(*)::int as n from platform.tenant_domain where domain='stale.acme.test'",
    )
    expect(stale.rows[0].n).toBe(0)
  })
})
