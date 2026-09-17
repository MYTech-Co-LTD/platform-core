// loader.test.ts — 模块装载器（TDD）：扫描/manifest 校验/迁移/权限 upsert/挂载/enabledFor
//
// 真 PG（本地 docker platform-pg，同 migrate.test.ts 约定）+ MockCasdoor（真实 HTTP）：
// 未提供 DATABASE_URL 时整体跳过。fixture 模块写在【仓库内】临时目录
// apps/server/.tmp-loader-fixtures/——index.ts 裸导入 '@platform/sdk'/'hono' 靠
// apps/server/node_modules walk-up 解析（/tmp 下裸导入解析不到）；目录随机名 +
// afterEach 清理，不污染工作树。
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { Pool } from 'pg'
import { CasdoorClient } from '@platform/auth-core'
import { MockCasdoor } from '@platform/auth-core/src/test-util/mock-casdoor'
import { probeAnonymous } from '@platform/sdk/test-util/anonymous-probe'
import type { Identity } from '@platform/sdk'
import { runMigrations } from './migrate'
import { seedDemo } from './seed'
import { loadModules, provisionModulePermissions } from './loader'
import type { TenantRow } from './tenant'

const dbUrl = process.env.DATABASE_URL
const serverMigrationsDir = fileURLToPath(new URL('./migrations', import.meta.url))
// apps/server/ 下的 fixture 根（URL('..') 从 src/ 退一级）
const fixtureRootBase = path.join(fileURLToPath(new URL('..', import.meta.url)), '.tmp-loader-fixtures')

describe.skipIf(!dbUrl)('loadModules', () => {
  let pool: Pool
  const mock = new MockCasdoor()

  const tmpRunDirs: string[] = []
  const cleanupSqls: string[] = []
  const cleanupModules: string[] = []

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    // platform schema（tenant_module 等）+ acme/beta 种子（enabledFor 用例取 acme id）
    await runMigrations(pool, 'platform', serverMigrationsDir)
    await seedDemo(pool)
    await mock.start()
    await mkdir(fixtureRootBase, { recursive: true })
  })
  afterAll(async () => {
    await rm(fixtureRootBase, { recursive: true, force: true })
    await mock.stop()
    await pool.end()
  })
  afterEach(async () => {
    for (const sql of cleanupSqls.splice(0)) await pool.query(sql)
    for (const m of cleanupModules.splice(0)) {
      await pool.query('delete from platform.schema_migrations where module = $1', [m])
      await pool.query('delete from platform.tenant_module where module_id = $1', [m])
    }
    for (const d of tmpRunDirs.splice(0)) await rm(d, { recursive: true, force: true })
  })

  // ---- fixture 工厂 ----

  /** 新建一次隔离的 modules/ 目录（每个用例独立，动态 import 缓存按路径天然隔离） */
  async function newModulesDir(): Promise<string> {
    const runDir = await mkdtemp(path.join(fixtureRootBase, 'run-'))
    tmpRunDirs.push(runDir)
    const modulesDir = path.join(runDir, 'modules')
    await mkdir(modulesDir)
    return modulesDir
  }

  async function writeModule(
    modulesDir: string,
    dirName: string,
    files: Record<string, string>,
  ): Promise<string> {
    const dir = path.join(modulesDir, dirName)
    for (const [rel, content] of Object.entries(files)) {
      const target = path.join(dir, rel)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, content)
    }
    return dir
  }

  /** fixture 模块入口：真协议（defineModule），不再手写 requireScope——声明在 manifest 里 */
  function indexTs(id: string, permCode: string): string {
    return [
      "import { Hono } from 'hono'",
      "import { defineModule } from '@platform/sdk'",
      '',
      'export default defineModule({',
      `  manifest: {`,
      `    id: '${id}', name: '${id} 模块', version: '1.0.0', platform: '>=0.1.0',`,
      `    permissions: [{ code: '${permCode}', name: '${id} 查看' }],`,
      `    api: { internal: [{ method: 'GET', path: '/ping', scope: '${permCode}' }] },`,
      '  },',
      '  createRouter: (ctx) => {',
      '    const app = new Hono()',
      `    app.get('/ping', (c) =>`,
      `      c.json({ module: '${id}', hasPool: !!ctx.pool }))`,
      '    return app',
      '  },',
      '})',
      '',
    ].join('\n')
  }

  /** fixture manifest.yaml 的 api 段默认值：与 indexTs 注册的 GET /ping 逐条对齐（新协议：
   *  未声明 = 不可达 ⇒ 默认声明必须跟着 fixture 的代码走，否则既有用例集体装载失败）。
   *  第三参：null = 不写 api 段（"未声明但已注册"负例）；字符串 = 自定义声明（幽灵声明负例）。 */
  function manifestYaml(
    id: string,
    extra = '',
    apiYaml: string | null = `api:\n  internal:\n    - { method: GET, path: /ping, scope: ${id}:view }`,
  ): string {
    return [
      `id: ${id}`,
      `name: ${id} 模块`,
      'version: 1.0.0',
      'platform: ">=0.1.0"',
      'permissions:',
      `  - code: ${id}:view`,
      `    name: ${id} 查看`,
      ...(apiYaml ? [apiYaml] : []),
      ...(extra ? [extra] : []),
      '',
    ].join('\n')
  }

  /** M3c 存储投影的 fixture：storagemod（manifest.yaml 声明 storage）+ plainmod（同 handler、不声明）。
   *  handler 把 context 键**原样回显**——唯一能证明「宿主真的 set 了」的证据面（断言模块内部变量
   *  只能证明它自己算出来的东西）。两组**共用同一份 handler 源码**，唯一差别是 manifest.yaml
   *  声明不声明 storage ⇒ 排除「handler 写法不同」这个第三变量。
   *  ⚠️ 声明必须写在 **manifest.yaml**：装载器读的是它（apps/server/src/loader.ts:280），
   *     index.ts 里的内联 manifest 不参与装载。 */
  async function writeStorageFixtures(modulesDir: string): Promise<void> {
    const echoIndexTs = (id: string): string => [
      "import { Hono } from 'hono'",
      "import { TENANT_STORAGE, defineModule } from '@platform/sdk'",
      '',
      'export default defineModule({',
      '  manifest: {',
      `    id: '${id}', name: '${id}', version: '1.0.0', platform: '>=0.1.0',`,
      `    permissions: [{ code: '${id}:view', name: '查看' }],`,
      `    api: { internal: [{ method: 'GET', path: '/ping', scope: '${id}:view' }] },`,
      '  },',
      '  createRouter: () => {',
      '    const app = new Hono()',
      "    app.get('/ping', (c) => c.json({ storage: c.get(TENANT_STORAGE) ?? null }))",
      '    return app',
      '  },',
      '})',
      '',
    ].join('\n')
    await writeModule(modulesDir, 'storagemod', {
      'manifest.yaml': manifestYaml('storagemod', 'storage: { kind: s3 }'),
      'index.ts': echoIndexTs('storagemod'),
    })
    await writeModule(modulesDir, 'plainmod', {
      'manifest.yaml': manifestYaml('plainmod'),
      'index.ts': echoIndexTs('plainmod'),
    })
  }

  /** 按 org 返回 client 的工厂（与宿主 app.ts 的 casdoorFactory 同形状） */
  function casdoorFactoryFor(): (org: string) => CasdoorClient {
    const cache = new Map<string, CasdoorClient>()
    return (org) => {
      let c = cache.get(org)
      if (!c) {
        c = new CasdoorClient({
          origin: mock.origin,
          clientId: 'test-client',
          clientSecret: '',
          org,
          adminUser: 'admin',
          adminPwd: 'pw',
        })
        cache.set(org, c)
      }
      return c
    }
  }

  /** 宿主侧 identity 注入中间件的替身（真实链路 = 租户解析→会话中间件，Task 16 装配） */
  type TestEnv = { Variables: { identity: Identity; tenant: TenantRow } }
  const injectIdentity = (scopes: string[]) =>
    createMiddleware<TestEnv>(async (c, next) => {
      c.set('identity', {
        userId: 'fixture-user',
        orgId: 'mock-org',
        displayName: 'Fixture User',
        scopes,
        hasScope: (code) => scopes.includes(code),
      })
      await next()
    })

  /** 宿主侧租户注入的替身（真实链路 = tenant.ts 的 resolveTenantMiddleware）。
   *  启用闸门按【租户】判定，故闸门用例必须注入租户；只注入 identity 的既有用例**不受影响**
   *  （无租户 ⇒ 闸门不在自己职责内，放行给后续层——与真实链路一致：那条链上租户中间件先跑，
   *  未命中 Host 早已 404/抛错，闸门见到的请求必带租户）。 */
  const injectTenant = (row: TenantRow) =>
    createMiddleware<TestEnv>(async (c, next) => {
      c.set('tenant', row)
      await next()
    })

  /** 取 seed 的 acme 租户整行（闸门只读 id，但注入的是真实形状的行，不做窄化替身） */
  async function acmeTenant(): Promise<TenantRow> {
    const { rows } = await pool.query<TenantRow>(
      "select * from platform.tenant where slug = 'acme'",
    )
    return rows[0]!
  }

  // ---- 用例 ----

  it('happy path：装载 1 模块 + 迁移记账 + 权限 upsert + mount 后 /ping 通', async () => {
    cleanupModules.push('fixturemod')
    cleanupSqls.push('drop schema if exists fixturemod cascade')
    const modulesDir = await newModulesDir()
    await writeModule(modulesDir, 'fixturemod', {
      'manifest.yaml': manifestYaml('fixturemod', 'migrations:\n  dir: migrations'),
      'index.ts': indexTs('fixturemod', 'fixturemod:view'),
      'migrations/001_init.sql':
        'create schema if not exists fixturemod;\ncreate table fixturemod.note(id int primary key);\n',
    })

    const runtime = await loadModules(modulesDir, { pool, casdoorFor: casdoorFactoryFor() })

    // ① 装载数量与 manifest
    expect(runtime.modules).toHaveLength(1)
    expect(runtime.modules[0]!.manifest.id).toBe('fixturemod')

    // ② 迁移已记账（module='fixturemod'）
    const mig = await pool.query<{ version: string }>(
      "select version from platform.schema_migrations where module = 'fixturemod'",
    )
    expect(mig.rows.map((r) => r.version)).toEqual(['001_init'])

    // ③ 权限码供给到 platform.tenant 的每个租户 org（acme/beta 由 beforeAll 的 seedDemo 种下）
    expect(mock.permissionsIn('acme').flatMap((p) => p.resources ?? [])).toContain('fixturemod:view')
    expect(mock.permissionsIn('beta').flatMap((p) => p.resources ?? [])).toContain('fixturemod:view')

    // ④ mount 后模块路由可达（identity 注入中间件模拟宿主会话层）
    const app = new Hono<TestEnv>()
    app.use('*', injectIdentity(['fixturemod:view']))
    runtime.mount(app)
    const res = await app.request('/api/modules/fixturemod/ping')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ module: 'fixturemod', hasPool: true })
  })

  it('坏 manifest：抛错信息含绝对路径（宿主启动 fail-fast）', async () => {
    const modulesDir = await newModulesDir()
    const dir = await writeModule(modulesDir, 'badmod', {
      'manifest.yaml': 'id: BAD\nname: x\nversion: 1.0.0\nplatform: ">=0.1.0"\npermissions: []\n',
    })
    const err = await loadModules(modulesDir, { pool }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain(path.join(dir, 'manifest.yaml'))
  })

  it('YAML 语法错误：抛错信息含绝对路径（Task 15 评审 M-1）', async () => {
    const modulesDir = await newModulesDir()
    const dir = await writeModule(modulesDir, 'yamlmod', {
      // 缩进坏行 + 未闭合引号——yaml.parse 抛 YAMLParseError（消息只有行列号）
      'manifest.yaml': 'id: yamlmod\nname: "unclosed\n  bad-indent: [\n',
    })
    const err = await loadModules(modulesDir, { pool }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain(path.join(dir, 'manifest.yaml'))
    // 是包装错误（含 cause）而非裸 YAMLParseError
    expect((err as Error).cause).toBeInstanceOf(Error)
  })

  it('重复模块 id：抛错并列出两个冲突目录', async () => {
    const modulesDir = await newModulesDir()
    const first = await writeModule(modulesDir, 'first', {
      'manifest.yaml': manifestYaml('dupmod'),
      'index.ts': indexTs('dupmod', 'dupmod:view'),
    })
    const second = await writeModule(modulesDir, 'second', {
      'manifest.yaml': manifestYaml('dupmod'),
    })
    const err = await loadModules(modulesDir, { pool }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('dupmod')
    expect((err as Error).message).toContain(first)
    expect((err as Error).message).toContain(second)
  })

  it('无 migrations 目录：静默跳过、不记账、不炸', async () => {
    cleanupModules.push('nodbmod')
    const modulesDir = await newModulesDir()
    await writeModule(modulesDir, 'nodbmod', {
      'manifest.yaml': manifestYaml('nodbmod'),
      'index.ts': indexTs('nodbmod', 'nodbmod:view'),
    })
    const runtime = await loadModules(modulesDir, { pool })
    expect(runtime.modules.map((m) => m.manifest.id)).toEqual(['nodbmod'])
    const rows = await pool.query<{ n: number }>(
      "select count(*)::int as n from platform.schema_migrations where module = 'nodbmod'",
    )
    expect(rows.rows[0]!.n).toBe(0)
  })

  it('userApp 静态目录存在：mount 挂 serveStatic 到 manifest.mount 路径', async () => {
    cleanupModules.push('staticmod')
    const modulesDir = await newModulesDir()
    await writeModule(modulesDir, 'staticmod', {
      'manifest.yaml': manifestYaml(
        'staticmod',
        'frontend:\n  userApp:\n    mount: /apps/staticmod\n    dist: web/dist',
      ),
      'index.ts': indexTs('staticmod', 'staticmod:view'),
      'web/dist/hello.txt': 'hello from staticmod dist\n',
    })
    const runtime = await loadModules(modulesDir, { pool, casdoorFor: casdoorFactoryFor() })
    const app = new Hono()
    runtime.mount(app)

    const res = await app.request('/apps/staticmod/hello.txt')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('hello from staticmod dist')
  })

  it('userApp 深链回**本模块的** SPA 壳（挂载点 SPA 兜底，M3b-2 I1）', async () => {
    cleanupModules.push('spamod')
    const modulesDir = await newModulesDir()
    await writeModule(modulesDir, 'spamod', {
      'manifest.yaml': manifestYaml(
        'spamod',
        'frontend:\n  userApp:\n    mount: /apps/spamod\n    dist: web/dist',
      ),
      'index.ts': indexTs('spamod', 'spamod:view'),
      'web/dist/index.html': '<html>spamod shell</html>',
      'web/dist/assets/app.js': 'console.log(1)',
    })
    const runtime = await loadModules(modulesDir, { pool, casdoorFor: casdoorFactoryFor() })
    const app = new Hono()
    runtime.mount(app)

    // ① 入口（带尾斜杠）
    const root = await app.request('/apps/spamod/')
    expect(root.status).toBe(200)
    expect(await root.text()).toContain('spamod shell')

    // ② 入口（不带尾斜杠）——客户端路由的 base 就是这个形状
    const bare = await app.request('/apps/spamod')
    expect(bare.status).toBe(200)
    expect(await bare.text()).toContain('spamod shell')

    // ③ **深链**：这条是本次修的核心。修之前它 404（本 Hono 实例没有全局兜底），
    //    而在真宿主里它更糟——会被 app.ts 的 app.get('*') 兜成 **web 的** index.html，
    //    也就是「刷新移动端页 ⇒ 打开 React 控制台壳」。
    const deep = await app.request('/apps/spamod/register')
    expect(deep.status).toBe(200)
    expect(await deep.text()).toContain('spamod shell')

    // ④ 产物文件仍走静态本体（兜底不能把 assets 也吞掉）
    const asset = await app.request('/apps/spamod/assets/app.js')
    expect(asset.status).toBe(200)
    expect(await asset.text()).toBe('console.log(1)')
  })

  it('userApp dist 不存在：跳过静态挂载不炸（请求 404）', async () => {
    cleanupModules.push('ghostapp')
    const modulesDir = await newModulesDir()
    await writeModule(modulesDir, 'ghostapp', {
      'manifest.yaml': manifestYaml(
        'ghostapp',
        'frontend:\n  userApp:\n    mount: /apps/ghostapp\n    dist: web/missing',
      ),
      'index.ts': indexTs('ghostapp', 'ghostapp:view'),
    })
    const runtime = await loadModules(modulesDir, { pool })
    const app = new Hono()
    expect(() => runtime.mount(app)).not.toThrow()
    const res = await app.request('/apps/ghostapp/hello.txt')
    expect(res.status).toBe(404)
  })

  it('enabledFor：无行=默认启用；enabled=false 行=不含该模块；只看已装载模块', async () => {
    cleanupModules.push('fixturemod')
    cleanupSqls.push('drop schema if exists fixturemod cascade')
    const acme = await pool.query<{ id: number }>(
      "select id from platform.tenant where slug = 'acme'",
    )
    const tenantId = acme.rows[0]!.id

    const modulesDir = await newModulesDir()
    await writeModule(modulesDir, 'fixturemod', {
      'manifest.yaml': manifestYaml('fixturemod', 'migrations:\n  dir: migrations'),
      'index.ts': indexTs('fixturemod', 'fixturemod:view'),
      'migrations/001_init.sql':
        'create schema if not exists fixturemod;\ncreate table fixturemod.note(id int primary key);\n',
    })
    const runtime = await loadModules(modulesDir, { pool, casdoorFor: casdoorFactoryFor() })

    // 无行 → 默认启用；seed 的 demo 行（enabled=true）不在装载集 → 不出现
    expect([...(await runtime.enabledFor(tenantId))].sort()).toEqual(['fixturemod'])

    // 关闸：enabled=false → 不含
    await pool.query(
      `insert into platform.tenant_module(tenant_id, module_id, enabled)
       values ($1, 'fixturemod', false)
       on conflict (tenant_id, module_id) do update set enabled = false`,
      [tenantId],
    )
    expect((await runtime.enabledFor(tenantId)).has('fixturemod')).toBe(false)
  })

  it('权限码供给到每个租户各自的 org（写侧遍历 platform.tenant，不依赖任何 env）', async () => {
    cleanupModules.push('orgmod')
    const modulesDir = await newModulesDir()
    await writeModule(modulesDir, 'orgmod', {
      'manifest.yaml': manifestYaml('orgmod'),
      'index.ts': indexTs('orgmod', 'orgmod:view'),
    })

    const runtime = await loadModules(modulesDir, { pool, casdoorFor: casdoorFactoryFor() })
    expect(runtime.modules.map((m) => m.manifest.id)).toEqual(['orgmod'])

    // 修复前：写侧只落单个 org ⇒ beta 恒空，而读侧按 beta 读 ⇒ 该租户用户全线 403
    expect(mock.permissionsIn('acme').flatMap((p) => p.resources ?? [])).toContain('orgmod:view')
    expect(mock.permissionsIn('beta').flatMap((p) => p.resources ?? [])).toContain('orgmod:view')
  })

  it('零租户：不供给、不抛错（全新库尚未 seed 是正常分支，不是异常）', async () => {
    const requested: string[] = []
    const emptyPool = { query: async () => ({ rows: [] }) } as unknown as Pool
    const orgs = await provisionModulePermissions(
      emptyPool,
      (org) => { requested.push(org); throw new Error('零租户时不应取 client') },
      [{ code: 'x:y', name: 'X' }],
    )
    expect(orgs).toEqual([])
    expect(requested).toEqual([])
  })

  it('无 casdoorFor：跳过供给、不抛错，且该模块的码不存在于任何 org', async () => {
    cleanupModules.push('nofacmod')
    const modulesDir = await newModulesDir()
    await writeModule(modulesDir, 'nofacmod', {
      'manifest.yaml': manifestYaml('nofacmod'),
      'index.ts': indexTs('nofacmod', 'nofacmod:view'),
    })

    const runtime = await loadModules(modulesDir, { pool })
    expect(runtime.modules.map((m) => m.manifest.id)).toEqual(['nofacmod'])
    const all = [...mock.permissionsIn('acme'), ...mock.permissionsIn('beta')]
    expect(all.flatMap((p) => p.resources ?? [])).not.toContain('nofacmod:view')
  })

  it('重跑不重复建码：第二次走 update 分支，add-permission 调用数不增', async () => {
    cleanupModules.push('idemmod')
    const modulesDir = await newModulesDir()
    await writeModule(modulesDir, 'idemmod', {
      'manifest.yaml': manifestYaml('idemmod'),
      'index.ts': indexTs('idemmod', 'idemmod:view'),
    })

    await loadModules(modulesDir, { pool, casdoorFor: casdoorFactoryFor() })
    const afterFirst = mock.addPermissionCalls.length
    // 先证明第一次真的建了码——否则下面的「不增」是空转（修复前该断言恒真，测不出任何东西）
    expect(afterFirst).toBeGreaterThan(0)
    await loadModules(modulesDir, { pool, casdoorFor: casdoorFactoryFor() })
    expect(mock.addPermissionCalls.length).toBe(afterFirst) // 查重命中 ⇒ 走 update，不再 add
  })

  // ---- R2：声明即授权（包裹层门卫 + 装载期双向核对）----

  it('★ 负例：模块注册了未声明的路由 ⇒ 装载失败（fail-fast，绝不半挂）', async () => {
    cleanupModules.push('undeclaredmod')
    const modulesDir = await newModulesDir()
    await writeModule(modulesDir, 'undeclaredmod', {
      'manifest.yaml': manifestYaml('undeclaredmod', '', null),
      // manifest 没有 api 段，index 却注册了 /ping
      'index.ts': [
        "import { Hono } from 'hono'",
        "import { defineModule } from '@platform/sdk'",
        'export default defineModule({',
        "  manifest: { id: 'undeclaredmod', name: 'm', version: '1.0.0', platform: '>=0.1.0',",
        "    permissions: [{ code: 'undeclaredmod:view', name: 'x' }] },",
        '  createRouter: () => { const a = new Hono(); a.get(\'/ping\', (c) => c.json({})); return a },',
        '})',
        '',
      ].join('\n'),
    })
    await expect(loadModules(modulesDir, { pool })).rejects.toThrow(/未声明/)
  })

  it('★ 负例：声明了模块未注册的路径（幽灵声明）⇒ 装载失败', async () => {
    cleanupModules.push('phantommod')
    const modulesDir = await newModulesDir()
    await writeModule(modulesDir, 'phantommod', {
      'manifest.yaml': manifestYaml(
        'phantommod',
        '',
        'api:\n  internal:\n    - { method: GET, path: /ghost, scope: phantommod:view }',
      ),
      'index.ts': indexTs('phantommod', 'phantommod:view'),
    })
    await expect(loadModules(modulesDir, { pool })).rejects.toThrow(/幽灵|未注册|声明/)
  })

  it('声明齐备 ⇒ 装载通过；匿名 401、scope 不符 403、scope 命中 200', async () => {
    cleanupModules.push('guardedmod')
    const modulesDir = await newModulesDir()
    await writeModule(modulesDir, 'guardedmod', {
      'manifest.yaml': manifestYaml('guardedmod'),
      'index.ts': indexTs('guardedmod', 'guardedmod:view'),
    })
    const runtime = await loadModules(modulesDir, { pool })
    const probe = new Hono()
    runtime.mount(probe)
    // 匿名：宿主真实链路里 identity 由会话中间件注入，此处不注入 = 未登录
    const anon = await probe.request('/api/modules/guardedmod/ping')
    expect(anon.status).toBe(401)
    expect(await anon.json()).toEqual({ error: 'UNAUTHENTICATED' })

    const wrong = new Hono()
    wrong.use('*', injectIdentity(['other:scope']))
    runtime.mount(wrong)
    const forbidden = await wrong.request('/api/modules/guardedmod/ping')
    expect(forbidden.status).toBe(403)
    expect(await forbidden.json()).toEqual({ error: 'FORBIDDEN', need: 'guardedmod:view' })

    const right = new Hono()
    right.use('*', injectIdentity(['guardedmod:view']))
    runtime.mount(right)
    expect((await right.request('/api/modules/guardedmod/ping')).status).toBe(200)
  })

  it('匿名探测回归网：装载出的模块每条路由都不可匿名到达', async () => {
    cleanupModules.push('probemod')
    const modulesDir = await newModulesDir()
    await writeModule(modulesDir, 'probemod', {
      'manifest.yaml': manifestYaml('probemod'),
      'index.ts': indexTs('probemod', 'probemod:view'),
    })
    const runtime = await loadModules(modulesDir, { pool })
    const probe = new Hono()
    runtime.mount(probe)
    const results = await probeAnonymous(probe)
    const apiRoutes = results.filter((r) => r.path.startsWith('/api/modules/probemod'))
    expect(apiRoutes.length).toBeGreaterThan(0)
    // R4 补记：mount() 现在还会挂一条**启用闸门中间件**（`base/*`）。它在 router.routes 里
    // 同样表现为 ALL 条目，被 probeAnonymous 一并探测（探测网刻意不跳过 ALL，见
    // anonymous-probe.ts）——但它是**中间件**、不是端点：无租户上下文时不在闸门职责内，
    // 放行给后续层，最终由「没有对应路由」的 404 收尾。故按两类分开断言：端点那类**强度不变**，
    // 另把闸门那类的行为一并钉住（放行 ≠ 自己造响应）。
    // 已知放松：本网因此对「闸门被误注册成端点」不再敏感——那不是安全洞（中间件不会 200），
    // 且闸门自身的语义由下方 R4 用例（停用 404 / 启用 200）逐条覆盖。
    //
    // 二分过滤条件（R4 评审 S6）：闸门恒是**中间件** ⇒ 恒记 `method === 'ALL'`，路径之外必须
    // **同时**按 method 判别。旧写法只按路径 —— 若某个模块把自己的端点声明在**自身 base**
    // 上（`app.get('/api/modules/<id>')` 这类，base 本就是它的相对根），那条真端点会被误判成
    // 闸门、从"匿名一律 401"的断言里被排除掉 ⇒ 一个 fixture 耦合的盲区。加上 method 条件后，
    // 只有「路径命中 AND 是 ALL」才算闸门。
    const isGate = (r: { path: string; method: string }) =>
      r.path === '/api/modules/probemod/*' && r.method === 'ALL'
    const endpoints = apiRoutes.filter((r) => !isGate(r))
    const gates = apiRoutes.filter(isGate)
    // ① 端点（含模块自己声明的 ALL 端点，R1 的教训）：匿名一律 401
    expect(endpoints.length).toBeGreaterThan(0)
    expect(endpoints.every((r) => r.status === 401)).toBe(true)
    // ② 闸门中间件：只此一条（`base/*` 已覆盖裸 base —— R4 评审 S4 删掉了冗余的精确那条），
    //    且匿名不可达（无租户 ⇒ 放行 ⇒ 无路由 ⇒ 404）
    expect(gates).toHaveLength(1)
    expect(gates.every((r) => r.status === 404)).toBe(true)
  })

  // ---- R1（PR#5 评审）：ALL ≠ 一定是中间件 ----

  /** 装载一个给定的 index.ts（createRouter 体由调用方写），返回装载结果或抛出的错。
   *  manifest 默认声明 GET /ping（与 routerBody 里必写的 a.get('/ping') 对齐）。 */
  async function loadWithIndex(
    id: string,
    routerBody: string[],
  ): Promise<{ runtime?: Awaited<ReturnType<typeof loadModules>>; err?: Error }> {
    const modulesDir = await newModulesDir()
    await writeModule(modulesDir, id, {
      'manifest.yaml': manifestYaml(id),
      'index.ts': [
        "import { Hono } from 'hono'",
        "import { defineModule } from '@platform/sdk'",
        'export default defineModule({',
        `  manifest: {`,
        `    id: '${id}', name: '${id} 模块', version: '1.0.0', platform: '>=0.1.0',`,
        `    permissions: [{ code: '${id}:view', name: '${id} 查看' }],`,
        `    api: { internal: [{ method: 'GET', path: '/ping', scope: '${id}:view' }] },`,
        '  },',
        '  createRouter: () => {',
        '    const a = new Hono()',
        ...routerBody,
        '    return a',
        '  },',
        '})',
        '',
      ].join('\n'),
    })
    return loadModules(modulesDir, { pool }).then(
      (runtime) => ({ runtime }),
      (e: unknown) => ({ err: e as Error }),
    )
  }

  it('★ 负例：未声明的 app.all() 多方法端点 ⇒ 装载失败（旧实现当中间件滤掉 ⇒ 匿名 200）', async () => {
    const { err } = await loadWithIndex('allmod', [
      "    a.all('/secret', (c) => c.json({ leaked: 'ALL' }))",
      "    a.get('/ping', (c) => c.json({ pong: true }))",
    ])
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain('ALL /secret')
    expect(err!.message).toContain('未声明的多方法端点')
  })

  it('★ 负例：未声明的 use(路径, 终结 handler) ⇒ 装载失败（同一条缝的另一种写法）', async () => {
    const { err } = await loadWithIndex('backdoormod', [
      "    a.use('/backdoor', (c) => c.json({ leaked: 'use' }))",
      "    a.get('/ping', (c) => c.json({ pong: true }))",
    ])
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain('ALL /backdoor')
  })

  it('已声明的 app.all(路径) ⇒ 装载通过且行为自洽：匿名 401、声明 method 放行、未声明 method 403', async () => {
    const id = 'declaredallmod'
    cleanupModules.push(id)
    const modulesDir = await newModulesDir()
    await writeModule(modulesDir, id, {
      'manifest.yaml': manifestYaml(
        id,
        '',
        `api:\n  internal:\n`
          + `    - { method: GET, path: /ping, scope: ${id}:view }\n`
          + `    - { method: GET, path: /multi, scope: ${id}:view }\n`
          + `    - { method: POST, path: /multi, scope: ${id}:view }`,
      ),
      'index.ts': [
        "import { Hono } from 'hono'",
        "import { defineModule } from '@platform/sdk'",
        'export default defineModule({',
        `  manifest: { id: '${id}', name: 'm', version: '1.0.0', platform: '>=0.1.0',`,
        `    permissions: [{ code: '${id}:view', name: 'x' }],`,
        '  },',
        '  createRouter: () => {',
        '    const a = new Hono()',
        "    a.all('/multi', (c) => c.json({ method: c.req.method }))",
        "    a.get('/ping', (c) => c.json({ pong: true }))",
        '    return a',
        '  },',
        '})',
        '',
      ].join('\n'),
    })
    const runtime = await loadModules(modulesDir, { pool })
    const anon = new Hono()
    runtime.mount(anon)
    expect((await anon.request(`/api/modules/${id}/multi`)).status).toBe(401)

    const scoped = new Hono()
    scoped.use('*', injectIdentity([`${id}:view`]))
    runtime.mount(scoped)
    expect((await scoped.request(`/api/modules/${id}/multi`)).status).toBe(200)
    expect((await scoped.request(`/api/modules/${id}/multi`, { method: 'POST' })).status).toBe(200)
    // 未声明的 method 打到 ALL 端点上 ⇒ 门卫逐条判定 ⇒ 403（fail-closed，不会漏进 handler）
    expect((await scoped.request(`/api/modules/${id}/multi`, { method: 'DELETE' })).status).toBe(403)
  })

  // PR#5 评审 R2（建议改 6）：phantom 的 ALL 出口把「声明 ⟺ 实现」放松了一格。这条**已知放松**
  // 在此钉死——不是"修好了"，是"改坏了会红"。为什么钉行为而不是加装载期 warn：装载器**无法
  // 区分** `app.all('/x', h)`（终结，上面刚测过的合法写法）与 `use('/x', mw)`（非终结）——两者
  // 在 router.routes 里是同一条 'ALL' 记录。加 warn 会对合法写法误报 ⇒ 一条总在叫的告警等于
  // 没有告警。故只在文档（docs/module-protocol.md「已知放松」）里写明，并用本例把行为冻结。
  // 反证：把 phantom 的 `!allExact.has(d.path)` 出口删掉（回到只看逐 method 注册）⇒ 这里装载
  // 阶段就抛错（两条声明都被判成幽灵）⇒ 本用例红，说明"放松"这件事本身是可测的。
  it('★ 已知放松：非终结 use(路径, mw) 也能满足逐 method 声明（装载通过、运行期 404；无装载期 warn）', async () => {
    const id = 'phantomrelaxmod'
    cleanupModules.push(id)
    const modulesDir = await newModulesDir()
    await writeModule(modulesDir, id, {
      'manifest.yaml': manifestYaml(
        id,
        '',
        `api:\n  internal:\n`
          + `    - { method: GET, path: /x, scope: ${id}:view }\n`
          + `    - { method: POST, path: /x, scope: ${id}:view }`,
      ),
      'index.ts': [
        "import { Hono } from 'hono'",
        "import { defineModule } from '@platform/sdk'",
        'export default defineModule({',
        `  manifest: { id: '${id}', name: 'm', version: '1.0.0', platform: '>=0.1.0',`,
        `    permissions: [{ code: '${id}:view', name: 'x' }],`,
        '  },',
        '  createRouter: () => {',
        '    const a = new Hono()',
        // 非终结：只把请求交给下游，自己没有任何 handler
        "    a.use('/x', async (c, next) => { await next() })",
        '    return a',
        '  },',
        '})',
        '',
      ].join('\n'),
    })
    const runtime = await loadModules(modulesDir, { pool }) // 装载期不抛（这就是那条放松）
    const scoped = new Hono()
    scoped.use('*', injectIdentity([`${id}:view`]))
    runtime.mount(scoped)
    // 运行期：两条声明都兑现不了（404）。门卫照常挂在 /x 上（不是安全洞，是可达性洞）
    expect((await scoped.request(`/api/modules/${id}/x`)).status).toBe(404)
    expect((await scoped.request(`/api/modules/${id}/x`, { method: 'POST' })).status).toBe(404)
  })

  it('通配 ALL（app.all("/files/*")）覆盖面大于声明面 ⇒ 未声明的子路径不再匿名可达', async () => {
    const id = 'wildmod'
    cleanupModules.push(id)
    const { runtime, err } = await loadWithIndex(id, [
      "    a.all('/files/*', (c) => c.json({ leaked: 'wildcard' }))",
      "    a.get('/ping', (c) => c.json({ pong: true }))",
    ])
    expect(err).toBeUndefined()
    const anon = new Hono()
    runtime!.mount(anon)
    expect((await anon.request(`/api/modules/${id}/files/b`)).status).toBe(401)
    const scoped = new Hono()
    scoped.use('*', injectIdentity([`${id}:view`]))
    runtime!.mount(scoped)
    // 有身份也不放行：这条子路径谁都没声明过（fail-closed）
    expect((await scoped.request(`/api/modules/${id}/files/b`)).status).toBe(403)
    // 声明过的那条照常可达
    expect((await scoped.request(`/api/modules/${id}/ping`)).status).toBe(200)
  })

  it('合法中间件形态不被误伤：use("*") / use("/prefix/*") 下声明路径照常放行、匿名照常 401', async () => {
    const id = 'mwmod'
    cleanupModules.push(id)
    const modulesDir = await newModulesDir()
    await writeModule(modulesDir, id, {
      'manifest.yaml': manifestYaml(
        id,
        '',
        `api:\n  internal:\n`
          + `    - { method: GET, path: /ping, scope: ${id}:view }\n`
          + `    - { method: GET, path: /prefix/notes, scope: ${id}:view }`,
      ),
      'index.ts': [
        "import { Hono } from 'hono'",
        "import { defineModule } from '@platform/sdk'",
        'export default defineModule({',
        `  manifest: { id: '${id}', name: 'm', version: '1.0.0', platform: '>=0.1.0',`,
        `    permissions: [{ code: '${id}:view', name: 'x' }],`,
        '  },',
        '  createRouter: () => {',
        '    const a = new Hono()',
        '    const seen: string[] = []',
        "    a.use('*', async (c, next) => { seen.push('global'); await next() })",
        "    a.use('/prefix/*', async (c, next) => { seen.push('prefix'); await next() })",
        // splice(0) = 取走并清空：每条响应只报【本次请求】的中间件轨迹（闭包数组跨请求累积）
        "    a.get('/ping', (c) => c.json({ pong: true, seen: seen.splice(0) }))",
        "    a.get('/prefix/notes', (c) => c.json({ notes: [], seen: seen.splice(0) }))",
        '    return a',
        '  },',
        '})',
        '',
      ].join('\n'),
    })
    const runtime = await loadModules(modulesDir, { pool })

    const anon = new Hono()
    runtime.mount(anon)
    expect((await anon.request(`/api/modules/${id}/ping`)).status).toBe(401)

    const scoped = new Hono()
    scoped.use('*', injectIdentity([`${id}:view`]))
    runtime.mount(scoped)
    const ping = await scoped.request(`/api/modules/${id}/ping`)
    expect(ping.status).toBe(200)
    expect((await ping.json()) as { seen: string[] }).toMatchObject({ seen: ['global'] })
    const notes = await scoped.request(`/api/modules/${id}/prefix/notes`)
    expect(notes.status).toBe(200)
    expect((await notes.json()) as { seen: string[] }).toMatchObject({ seen: ['global', 'prefix'] })
  })

  // ---- R4：停用语义落地（enabledFor 不只是 /config 的清单闸门，也是 API 闸门）----

  /** 装载一个 fixture 模块并显式停用/启用某个租户的可见性 */
  async function loadWithTenantState(
    id: string,
    tenant: TenantRow,
    enabled: boolean | null,
  ): Promise<Awaited<ReturnType<typeof loadModules>>> {
    cleanupModules.push(id)
    const modulesDir = await newModulesDir()
    await writeModule(modulesDir, id, {
      'manifest.yaml': manifestYaml(id),
      'index.ts': indexTs(id, `${id}:view`),
    })
    const runtime = await loadModules(modulesDir, { pool })
    if (enabled !== null) {
      await pool.query(
        `insert into platform.tenant_module(tenant_id, module_id, enabled)
         values ($1, $2, $3)
         on conflict (tenant_id, module_id) do update set enabled = excluded.enabled`,
        [tenant.id, id, enabled],
      )
    }
    return runtime
  }

  it('★ 负例：租户停用了某模块 ⇒ 该模块 API 返 404（此前只影响 /config 清单，API 照常可达）', async () => {
    const tenant = await acmeTenant()
    // 显式停用（enabled=false 行）
    const runtime = await loadWithTenantState('disabledmod', tenant, false)

    const app = new Hono<TestEnv>()
    app.use('*', injectTenant(tenant))
    app.use('*', injectIdentity(['disabledmod:view']))
    runtime.mount(app)

    // ① 子树路径：/api/modules/<id>/ping（声明过的端点、scope 也够 ⇒ 修复前 200）
    const sub = await app.request('/api/modules/disabledmod/ping')
    expect(sub.status).toBe(404)
    // 形状与宿主 /api 未命中兜底一致（app.ts 的 notFound）
    expect(await sub.json()).toEqual({ error: 'NOT_FOUND' })

    // ② 精确路径：/api/modules/<id> 本身也必须被闸住——**只靠 `base/*` 这一条**（R4 评审 S4
    //    删掉了冗余的精确 `use(base)`）。判别依据是**响应体**：闸门回 JSON {error:'NOT_FOUND'}，
    //    而"根本没挂闸门"时这里落进 Hono 默认 notFound ⇒ 纯文本 '404 Not Found'（res.json()
    //    会抛）——故 JSON 断言即证明请求确实经过了闸门，而不是恰好也没路由。这条用例因此同时
    //    是「`/*` 已覆盖裸 base」的活证据：精确那条被删掉后它照旧绿。
    const exact = await app.request('/api/modules/disabledmod')
    expect(exact.status).toBe(404)
    expect(await exact.json()).toEqual({ error: 'NOT_FOUND' })
  })

  it('对照：未停用的模块照常 200（证明上一条不是"闸门把所有模块都关了"）', async () => {
    const tenant = await acmeTenant()
    const runtime = await loadWithTenantState('enabledmod', tenant, null) // 无行 = 默认启用

    const app = new Hono<TestEnv>()
    app.use('*', injectTenant(tenant))
    app.use('*', injectIdentity(['enabledmod:view']))
    runtime.mount(app)
    expect((await app.request('/api/modules/enabledmod/ping')).status).toBe(200)
  })

  it('对照：停用的是【另一个】租户 ⇒ 本租户照常 200（闸门按租户判定，不是全局开关）', async () => {
    const acme = await acmeTenant()
    const beta = (await pool.query<TenantRow>(
      "select * from platform.tenant where slug = 'beta'",
    )).rows[0]!
    // 停用只落在 beta 头上（无行时默认启用）
    const runtime = await loadWithTenantState('permode', beta, false)

    const asAcme = new Hono<TestEnv>()
    asAcme.use('*', injectTenant(acme))
    asAcme.use('*', injectIdentity(['permode:view']))
    runtime.mount(asAcme)
    expect((await asAcme.request('/api/modules/permode/ping')).status).toBe(200)

    const asBeta = new Hono<TestEnv>()
    asBeta.use('*', injectTenant(beta))
    asBeta.use('*', injectIdentity(['permode:view']))
    runtime.mount(asBeta)
    expect((await asBeta.request('/api/modules/permode/ping')).status).toBe(404)
  })

  // ---- R4 评审 S5（协调者裁定）：匿名请求不落闸门，直接放行给模块自身门卫 ----

  it('★ 匿名（有租户、无 identity）：停用模块与启用模块**响应逐字相同** ⇒ 停用不可枚举', async () => {
    // 闸门挂在模块自身门卫**之前**：若匿名也走闸门，就等于按"模块是否停用"给出两种响应，
    // 而匿名请求本就拿不到任何模块数据（门卫一律 401）——那是一次白费的 DB 往返 + 一条
    // 可枚举信号。放行后两条路径都落到门卫的 401，**逐字相同**：
    const tenant = await acmeTenant()
    const disabled = await loadWithTenantState('anondisabled', tenant, false)
    const enabled = await loadWithTenantState('anonenabled', tenant, null)

    const anonApp = (runtime: Awaited<ReturnType<typeof loadModules>>) => {
      const a = new Hono<TestEnv>()
      a.use('*', injectTenant(tenant)) // 只注入租户，**不注入 identity**（匿名）
      runtime.mount(a)
      return a
    }
    const a1 = await anonApp(disabled).request('/api/modules/anondisabled/ping')
    const a2 = await anonApp(enabled).request('/api/modules/anonenabled/ping')
    expect(a1.status).toBe(401) // 停用模块：匿名拿到的是门卫的 401，**不是**闸门的 404
    expect(a2.status).toBe(401)
    expect(await a1.json()).toEqual({ error: 'UNAUTHENTICATED' })
    expect(await a2.json()).toEqual({ error: 'UNAUTHENTICATED' })
  })

  it('对照：已登录用户仍拿 404（匿名放行没有把停用闸门一起放掉）', async () => {
    const tenant = await acmeTenant()
    const runtime = await loadWithTenantState('autheddisabled', tenant, false)
    const authed = new Hono<TestEnv>()
    authed.use('*', injectTenant(tenant))
    authed.use('*', injectIdentity(['autheddisabled:view']))
    runtime.mount(authed)
    const res = await authed.request('/api/modules/autheddisabled/ping')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'NOT_FOUND' })
  })

  it('闸门只可能更严不会更宽：显式停用后 404，显式改回 enabled=true 后恢复 200', async () => {
    const tenant = await acmeTenant()
    const runtime = await loadWithTenantState('flipmod', tenant, false)

    const app = new Hono<TestEnv>()
    app.use('*', injectTenant(tenant))
    app.use('*', injectIdentity(['flipmod:view']))
    runtime.mount(app)
    expect((await app.request('/api/modules/flipmod/ping')).status).toBe(404)

    // 刻意不做缓存：改回启用后**下一个请求**即恢复（没有隐式生效窗口）
    await pool.query(
      `update platform.tenant_module set enabled = true where tenant_id = $1 and module_id = 'flipmod'`,
      [tenant.id],
    )
    expect((await app.request('/api/modules/flipmod/ping')).status).toBe(200)
  })

  // ---- 售后 M1：userApp 停用闸门（休眠缺口收口）+ guest 码发放 ----

  it('userApp 静态吃启用闸门：停用 ⇒ 404（与 API 面同形）；启用 ⇒ 200（匿名可载壳）', async () => {
    cleanupModules.push('userappmod')
    cleanupSqls.push('drop schema if exists userappmod cascade')
    const modulesDir = await newModulesDir()
    // apiYaml 传 null：extra 从 permissions 序列的下一个列表项接起（先补 guest 码，再写 api/guest/frontend）
    await writeModule(modulesDir, 'userappmod', {
      'manifest.yaml': manifestYaml(
        'userappmod',
        [
          '  - { code: userappmod:guest, name: 访客 }',
          'api:',
          '  internal:',
          '    - { method: GET, path: /ping, scope: userappmod:view }',
          'guest: { scope: userappmod:guest }',
          'frontend:',
          '  userApp: { mount: /m-userappmod, dist: dist }',
        ].join('\n'),
        null,
      ),
      'index.ts': indexTs('userappmod', 'userappmod:view'),
      'dist/index.html': '<html>shell</html>',
    })
    const tenant = await acmeTenant()
    // 显式停用（enabled=false 行）
    await pool.query(
      `insert into platform.tenant_module(tenant_id, module_id, enabled)
       values ($1, 'userappmod', false)
       on conflict (tenant_id, module_id) do update set enabled = false`,
      [tenant.id],
    )
    const runtime = await loadModules(modulesDir, { pool })

    // ① 停用 ⇒ 静态与 API 均 404 同形（已登录视角；闸门按租户判定，形状与宿主 notFound 一致）
    const authed = new Hono<TestEnv>()
    authed.use('*', injectTenant(tenant))
    authed.use('*', injectIdentity(['userappmod:view']))
    runtime.mount(authed)
    const spa = await authed.request('/m-userappmod/')
    expect(spa.status).toBe(404)
    expect(await spa.json()).toEqual({ error: 'NOT_FOUND' })
    const api = await authed.request('/api/modules/userappmod/ping')
    expect(api.status).toBe(404)
    expect(await api.json()).toEqual({ error: 'NOT_FOUND' })

    // ③ 停用 ⇒ 无访客码可发放
    expect(await runtime.enabledGuestScopes(tenant.id)).toEqual([])

    // 改回启用（闸门刻意无缓存 ⇒ 下一个请求即恢复）
    await pool.query(
      `update platform.tenant_module set enabled = true where tenant_id = $1 and module_id = 'userappmod'`,
      [tenant.id],
    )

    // ② 启用 ⇒ 静态 200——**匿名不带 cookie**（不注入 identity；SPA 壳登录前必须可载）
    const anon = new Hono<TestEnv>()
    anon.use('*', injectTenant(tenant)) // 只注入租户，不注入 identity = 匿名
    runtime.mount(anon)
    const shell = await anon.request('/m-userappmod/')
    expect(shell.status).toBe(200)
    expect(await shell.text()).toContain('shell')

    // ③ 启用 ⇒ 按已启用模块发放访客码
    expect(await runtime.enabledGuestScopes(tenant.id)).toEqual(['userappmod:guest'])
  })

  // ---- M3c：租户存储投影中间件（正典「租户级配置注入」）----

  it('声明 storage 的模块：投影中间件把平台默认注入模块 API 子树（未声明则恒 undefined）', async () => {
    cleanupModules.push('storagemod', 'plainmod')
    const modulesDir = await newModulesDir()
    await writeStorageFixtures(modulesDir)

    const runtime = await loadModules(modulesDir, { pool, casdoorFor: casdoorFactoryFor() })
    const app = new Hono<TestEnv>()
    // 门卫按 manifest 声明施加：identity 必须带这两个码，否则请求在门卫处就 403、到不了 handler。
    // （本用例验的是**注入**不是授权 ⇒ 码给全，让请求真的落到模块 handler 上。）
    app.use('*', injectIdentity(['storagemod:view', 'plainmod:view']))
    runtime.mount(app)

    // ① 平台 env 完整 ⇒ 注入（且**只有五个键**，没有 TenantRow 的任何别的字段）
    const saved = { ...process.env }
    process.env.AFTERSALES_ZOS_ENDPOINT = 'zos.xinan1.ctyun.cn'
    process.env.AFTERSALES_ZOS_REGION = 'xinan1'
    process.env.AFTERSALES_ZOS_BUCKET = 'platform-bucket'
    process.env.AFTERSALES_ZOS_ACCESS_KEY = 'AKIAPLAT'
    process.env.AFTERSALES_ZOS_SECRET = 'sk-platform'
    try {
      const on = await app.request('/api/modules/storagemod/ping')
      expect(await on.json()).toEqual({
        storage: {
          kind: 's3',
          endpoint: 'https://zos.xinan1.ctyun.cn',
          region: 'xinan1',
          bucket: 'platform-bucket',
          accessKeyId: 'AKIAPLAT',
          secretAccessKey: 'sk-platform',
        },
      })
      // ② 未声明 storage 的模块：同一个 handler 拿不到（「不声明 = 拿不到」，与未声明路径不可达同构）
      const off = await app.request('/api/modules/plainmod/ping')
      expect(await off.json()).toEqual({ storage: null })
    } finally {
      for (const k of ['ENDPOINT', 'REGION', 'BUCKET', 'ACCESS_KEY', 'SECRET']) {
        if (saved[`AFTERSALES_ZOS_${k}`] === undefined) delete process.env[`AFTERSALES_ZOS_${k}`]
        else process.env[`AFTERSALES_ZOS_${k}`] = saved[`AFTERSALES_ZOS_${k}`]
      }
      // ③ env 缺任一 ⇒ 不 set（声明了也拿不到 —— 「没有平台默认」是确定状态）
      delete process.env.AFTERSALES_ZOS_BUCKET
      const incomplete = await app.request('/api/modules/storagemod/ping')
      expect(await incomplete.json()).toEqual({ storage: null })
    }
  })
})

// ---- D9：平台内置码 tenant:admin 随装载扇出（M3，issue #46） ----
describe.skipIf(!dbUrl)('平台内置权限码（D9）', () => {
  let pool: Pool
  const mock = new MockCasdoor()
  const fixtureRoot = path.join(fileURLToPath(new URL('..', import.meta.url)), '.tmp-loader-fixtures-d9')
  const tmpRunDirs: string[] = []

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    await runMigrations(pool, 'platform', serverMigrationsDir)
    await seedDemo(pool)
    await mock.start()
    await mkdir(fixtureRoot, { recursive: true })
  })
  afterAll(async () => {
    await rm(fixtureRoot, { recursive: true, force: true })
    await mock.stop()
    await pool.end()
  })
  afterEach(async () => {
    for (const d of tmpRunDirs.splice(0)) await rm(d, { recursive: true, force: true })
  })

  function casdoorFactoryFor(): (org: string) => CasdoorClient {
    const cache = new Map<string, CasdoorClient>()
    return (org) => {
      let c = cache.get(org)
      if (!c) {
        c = new CasdoorClient({
          origin: mock.origin, clientId: 'test-client', clientSecret: '', org,
          adminUser: 'admin', adminPwd: 'pw',
        })
        cache.set(org, c)
      }
      return c
    }
  }

  it('零模块也供给 tenant:admin 到每个租户 org（内置码在前，管理员门禁不依赖业务模块）', async () => {
    const runDir = await mkdtemp(path.join(fixtureRoot, 'run-'))
    tmpRunDirs.push(runDir)
    const modulesDir = path.join(runDir, 'modules')
    await mkdir(modulesDir) // 空 modules/
    await loadModules(modulesDir, { pool, casdoorFor: casdoorFactoryFor() })
    expect(mock.permissionsIn('acme').flatMap((p) => p.resources ?? [])).toContain('tenant:admin')
    expect(mock.permissionsIn('beta').flatMap((p) => p.resources ?? [])).toContain('tenant:admin')
  })

  it('模块码与内置码一起扇出（同一次装载）', async () => {
    const runDir = await mkdtemp(path.join(fixtureRoot, 'run-'))
    tmpRunDirs.push(runDir)
    const modulesDir = path.join(runDir, 'modules')
    await mkdir(path.join(modulesDir, 'somemod'), { recursive: true })
    await writeFile(path.join(modulesDir, 'somemod', 'manifest.yaml'), [
      'id: somemod', 'name: somemod 模块', 'version: 1.0.0', 'platform: ">=0.1.0"',
      'permissions:', '  - { code: somemod:view, name: somemod 查看 }',
      '', '',
    ].join('\n'))
    // 无 index.ts ⇒ 装载失败会抛——补最小入口（无 api 声明即可，api 段可缺省）
    await writeFile(path.join(modulesDir, 'somemod', 'index.ts'), [
      "import { Hono } from 'hono'",
      "import { defineModule } from '@platform/sdk'",
      'export default defineModule({',
      "  manifest: { id: 'somemod', name: 'somemod 模块', version: '1.0.0', platform: '>=0.1.0', permissions: [{ code: 'somemod:view', name: 'somemod 查看' }] },",
      '  createRouter: () => new Hono(),',
      '})',
      '', '',
    ].join('\n'))
    await loadModules(modulesDir, { pool, casdoorFor: casdoorFactoryFor() })
    const codes = mock.permissionsIn('acme').flatMap((p) => p.resources ?? [])
    expect(codes).toContain('somemod:view')
    expect(codes).toContain('tenant:admin')
    await pool.query("delete from platform.schema_migrations where module = 'somemod'")
  })
})
