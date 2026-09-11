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
import type { Identity } from '@platform/sdk'
import { runMigrations } from './migrate'
import { seedDemo } from './seed'
import { loadModules, provisionModulePermissions } from './loader'

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

  /** fixture 模块入口：真协议（defineModule + requireScope），非 mock */
  function indexTs(id: string, permCode: string): string {
    return [
      "import { Hono } from 'hono'",
      "import { defineModule, requireScope } from '@platform/sdk'",
      '',
      'export default defineModule({',
      `  manifest: {`,
      `    id: '${id}', name: '${id} 模块', version: '1.0.0', platform: '>=0.1.0',`,
      `    permissions: [{ code: '${permCode}', name: '${id} 查看' }],`,
      '  },',
      '  createRouter: (ctx) => {',
      '    const app = new Hono()',
      `    app.get('/ping', requireScope('${permCode}'), (c) =>`,
      `      c.json({ module: '${id}', hasPool: !!ctx.pool }))`,
      '    return app',
      '  },',
      '})',
      '',
    ].join('\n')
  }

  function manifestYaml(id: string, extra = ''): string {
    return [
      `id: ${id}`,
      `name: ${id} 模块`,
      'version: 1.0.0',
      'platform: ">=0.1.0"',
      'permissions:',
      `  - code: ${id}:view`,
      `    name: ${id} 查看`,
      ...(extra ? [extra] : []),
      '',
    ].join('\n')
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
  type TestEnv = { Variables: { identity: Identity } }
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
})
