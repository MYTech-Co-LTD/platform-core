// scripts/lint-architecture.test.ts — Task 20 门禁脚本的 fixtures 测试。
//
// 覆盖三个脚本：lint-architecture（B1/B2/B8）、check-compose（B7）、check-env-example（B9）。
// 全部黑盒：spawn 脚本 CLI、断言退出码与输出行——门禁的对外契约就是这两样；且 scripts/ 不属于
// 任何 workspace 包，import .mjs 还要额外声明类型，不如直接测真实入口。
//
// 每个脚本的第一个位置参数是 rootDir（默认仓库根），fixtures 因此可以落在系统临时目录里，
// 与真实仓库完全隔离；最后一组用例反过来钉住「真实仓库必须干净」（exit 0）。
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const scriptsDir = join(repoRoot, 'scripts')

interface RunResult {
  status: number
  stdout: string
  stderr: string
}

const tmpRoots: string[] = []

/** 建一个临时 fixture 根目录（files: 相对路径 → 内容），用完在 afterAll 统一删除。 */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'platform-guard-border-'))
  tmpRoots.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

/** 跑脚本（node 入口，与 `tsx scripts/<x>.mjs` 同一入口：都是纯 ESM）。 */
function run(script: string, root: string): RunResult {
  try {
    // stderr 走管道（不直通终端）：违规输出由断言消费，测试运行时不留噪音
    const stdout = execFileSync(process.execPath, [join(scriptsDir, script), root], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    if (typeof err.status !== 'number') throw e
    return { status: err.status, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

const out = (r: RunResult): string => r.stdout + r.stderr

/** 干净：exit 0、无 stderr、stdout 一行 `<name>: OK`（与既有 scripts/check-manifests.mjs 同风格）。 */
function expectClean(r: RunResult): void {
  expect(r.stderr).toBe('')
  expect(r.stdout).toContain('OK')
  expect(r.status).toBe(0)
}

afterAll(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('lint-architecture: B1 跨 schema 引用', () => {
  it('平台代码（apps/、packages/）只许 platform schema', () => {
    const ok = fixture({
      'apps/server/src/ok.ts': "await pool.query('select version from platform.schema_migrations')\n",
    })
    expect(run('lint-architecture.mjs', ok).status).toBe(0)

    const bad = fixture({
      'apps/server/src/bad.ts': "await pool.query('select * from tenant.user')\n",
    })
    const r = run('lint-architecture.mjs', bad)
    expect(r.status).toBe(1)
    expect(out(r)).toContain('apps/server/src/bad.ts:1')
    expect(out(r)).toContain('[B1]')
    expect(out(r)).toContain('tenant')
  })

  it('模块只许引用自身 id 的 schema', () => {
    const own = fixture({
      'modules/demo/index.ts': "pool.query('insert into demo.note(body) values ($1)')\n",
    })
    expect(run('lint-architecture.mjs', own).status).toBe(0)

    const other = fixture({
      'modules/demo/index.ts': "pool.query('select id from platform.tenant')\n",
    })
    const r = run('lint-architecture.mjs', other)
    expect(r.status).toBe(1)
    expect(out(r)).toContain('modules/demo/index.ts:1')
    expect(out(r)).toContain('[B1]')
    expect(out(r)).toContain('platform')
  })

  it('模块的 schema 白名单取 manifest.yaml 的 id（三同：id = DB schema）', () => {
    const r = run(
      'lint-architecture.mjs',
      fixture({
        'modules/dirname-not-id/manifest.yaml': 'id: realmod\nname: x\n',
        'modules/dirname-not-id/index.ts': "pool.query('select * from realmod.t')\n",
      }),
    )
    expect(r.status).toBe(0)
  })

  it('跳过 *.test.* 与 *.gen.*（测试/生成物不是边界纪律的适用对象）', () => {
    const r = run(
      'lint-architecture.mjs',
      fixture({
        'apps/server/src/x.test.ts': "pool.query('select * from tenant.user')\n",
        'apps/server/src/y.gen.ts': "pool.query('select * from tenant.user')\n",
      }),
    )
    expect(r.status).toBe(0)
  })
})

describe('lint-architecture: B2 认证代码唯一', () => {
  it('jose / casdoor 只许出现在 packages/auth-core/**', () => {
    const ok = fixture({
      'packages/auth-core/src/session.ts': "import { SignJWT } from 'jose'\n",
      'packages/auth-core/src/public.ts': "export { CasdoorClient } from './casdoor-client'\n",
    })
    expect(run('lint-architecture.mjs', ok).status).toBe(0)

    const bad = fixture({
      'apps/web/src/api.ts': "import { SignJWT } from 'jose'\n",
      'modules/demo/index.ts': "import x from './casdoor-client'\n",
    })
    const r = run('lint-architecture.mjs', bad)
    expect(r.status).toBe(1)
    expect(out(r)).toContain('apps/web/src/api.ts:1')
    expect(out(r)).toContain('modules/demo/index.ts:1')
    expect(out(r)).toContain('[B2]')
  })

  it('@platform/auth-core 只许 apps/server 引（web/sdk 连类型都不许）', () => {
    const ok = fixture({
      'apps/server/src/app.ts': "import type { CasdoorClient } from '@platform/auth-core'\n",
    })
    expect(run('lint-architecture.mjs', ok).status).toBe(0)

    const bad = fixture({
      'apps/web/src/api.ts': "import type { Session } from '@platform/auth-core'\n",
      'packages/platform-sdk/src/index.ts': "import type { Session } from '@platform/auth-core'\n",
    })
    const r = run('lint-architecture.mjs', bad)
    expect(r.status).toBe(1)
    expect(out(r)).toContain('apps/web/src/api.ts:1')
    expect(out(r)).toContain('packages/platform-sdk/src/index.ts:1')
  })
})

describe('lint-architecture: B8 硬编码禁令', () => {
  it('hookflow.cn 与公网 IPv4 违规，127.0.0.1 白名单', () => {
    const bad = fixture({
      'apps/server/src/a.ts': "const u = 'https://woke.hookflow.cn/api'\n",
      'apps/server/src/b.ts': "const h = '10.1.2.3'\n",
    })
    const r = run('lint-architecture.mjs', bad)
    expect(r.status).toBe(1)
    expect(out(r)).toContain('apps/server/src/a.ts:1')
    expect(out(r)).toContain('apps/server/src/b.ts:1')
    expect(out(r)).toContain('[B8]')

    const ok = fixture({
      'apps/server/src/a.ts': "const u = 'http://127.0.0.1:13000'\nconst h = '127.0.0.1'\n",
    })
    expect(run('lint-architecture.mjs', ok).status).toBe(0)
  })

  it('注释里提到禁区字面量不算违规，但字符串里的照样查出（注释掩码不吞字符串）', () => {
    const commentOnly = fixture({
      'apps/server/src/a.ts': "// 本仓禁止写 hookflow.cn / 10.1.2.3 之类的字面量\nconst x = 1\n",
    })
    expect(run('lint-architecture.mjs', commentOnly).status).toBe(0)

    const withComment = fixture({
      'apps/server/src/a.ts': "const u = 'https://a.hookflow.cn' // 生产域名\n",
    })
    const r = run('lint-architecture.mjs', withComment)
    expect(r.status).toBe(1)
    expect(out(r)).toContain('apps/server/src/a.ts:1')
  })

  it('正则字面量不制造两种失步：代码位 `//` 不吃掉同行的真实字面量，正则里的引号不解除注释遮罩', () => {
    // 方向一（假阴性）：正则字面量结尾的 `//`（/^https?:\/\//）曾被当成注释起点吃掉整行，
    // 于是同一行里、`//` 之后的真实违规字符串一条都查不出。
    const afterRegex = fixture({
      'apps/server/src/a.ts':
        "const re = /^https?:\\/\\//; const u = 'https://a.hookflow.cn'\nconst h = '10.1.2.3'\n",
    })
    const r1 = run('lint-architecture.mjs', afterRegex)
    expect(r1.status).toBe(1)
    expect(out(r1)).toContain('apps/server/src/a.ts:1')
    expect(out(r1)).toContain('apps/server/src/a.ts:2')

    // 方向二（假阳性）：正则字面量里的引号（/['"]/）曾把状态机带进字符串态且再未闭合，
    // 此后真注释不再被遮罩 —— 一个只含注释提及 hookflow.cn、没有任何字面量的文件会误报。
    const quotedRegex = fixture({
      'apps/server/src/a.ts': "const q = /['\"]/\n// 本仓禁止 hookflow.cn\nconst x = 1\n",
    })
    expect(run('lint-architecture.mjs', quotedRegex).status).toBe(0)

    // 回归钉：识别正则不能把除号也吃掉（否则除号之后的行内注释不再被遮罩 → 假阳性）
    const division = fixture({
      'apps/server/src/a.ts':
        "const half = n / 2 // 本仓禁止 hookflow.cn\nconst p = (a + b) / 2 // 同样禁止 hookflow.cn\n",
    })
    expect(run('lint-architecture.mjs', division).status).toBe(0)

    // 回归钉：JSX 的 `</div>` 不能被判成正则（`<` 曾在我的「正则位置」字符表里，`</` 会一路吃到
    // 同行第一个 `/`，把紧随的 `// 注释` 的第一根斜杠吃掉 → 注释里的禁区字面量误报）
    const jsx = fixture({
      'apps/web/src/a.tsx': "export const A = () => (\n  <div> </div> // 本仓禁止 hookflow.cn\n)\n",
    })
    expect(run('lint-architecture.mjs', jsx).status).toBe(0)
  })
})

describe('lint-architecture: 真实仓库', () => {
  it('对当前仓跑必须干净（Step 2 硬要求）', () => {
    const r = run('lint-architecture.mjs', repoRoot)
    expectClean(r)
  })
})

describe('check-compose: B7 全仓唯一 compose', () => {
  it('只允许 deploy/docker-compose.yml', () => {
    const ok = fixture({
      'deploy/docker-compose.yml': 'services: {}\n',
      'deploy/README.md': '# deploy\n',
    })
    const r = run('check-compose.mjs', ok)
    expectClean(r)

    const second = fixture({
      'deploy/docker-compose.yml': 'services: {}\n',
      'apps/server/docker-compose.yml': 'services: {}\n',
    })
    const r2 = run('check-compose.mjs', second)
    expect(r2.status).toBe(1)
    expect(out(r2)).toContain('apps/server/docker-compose.yml')
    expect(out(r2)).toContain('[B7]')
  })

  it('compose fragment 一律违规；node_modules 不扫', () => {
    const fragment = run('check-compose.mjs', fixture({ 'deploy/compose.fragment.yml': 'services: {}\n' }))
    expect(fragment.status).toBe(1)
    expect(out(fragment)).toContain('compose.fragment.yml')

    const inNodeModules = run(
      'check-compose.mjs',
      fixture({ 'node_modules/pkg/docker-compose.yml': 'services: {}\n' }),
    )
    expect(inNodeModules.status).toBe(0)
  })

  it('对当前仓跑必须干净（Step 2 硬要求）', () => {
    const r = run('check-compose.mjs', repoRoot)
    expectClean(r)
  })
})

describe('check-env-example: B9 env 完整', () => {
  it('代码引用的键必须出现在 .env.example（含注释行声明的可选键）', () => {
    const ok = fixture({
      '.env.example': 'FOO=1\n# SEED_DEMO=1  # 可选开关\n',
      'apps/server/src/a.ts': 'const a = process.env.FOO\nconst b = process.env.SEED_DEMO\n',
    })
    expect(run('check-env-example.mjs', ok).status).toBe(0)

    const bad = fixture({
      '.env.example': 'FOO=1\n',
      'modules/demo/index.ts': "const u = process.env.TOTALLY_MISSING ?? ''\n",
    })
    const r = run('check-env-example.mjs', bad)
    expect(r.status).toBe(1)
    expect(out(r)).toContain('modules/demo/index.ts:1')
    expect(out(r)).toContain('TOTALLY_MISSING')
    expect(out(r)).toContain('[B9]')
  })

  it('下标读 process.env[...] 同样受检；apps/web 的 VITE_ 键豁免', () => {
    const bad = fixture({
      '.env.example': 'FOO=1\n',
      'apps/server/src/a.ts': "const k = process.env['OTHER_MISSING']\n",
    })
    const r = run('check-env-example.mjs', bad)
    expect(r.status).toBe(1)
    expect(out(r)).toContain('OTHER_MISSING')

    const web = fixture({
      '.env.example': 'FOO=1\n',
      'apps/web/src/lib/api.ts': "const base = import.meta.env.VITE_PLATFORM_API ?? ''\n",
    })
    expect(run('check-env-example.mjs', web).status).toBe(0)
  })

  it('宿主注入式访问器 env.KEY / requireValue("KEY") / optional("KEY") 同样受检', () => {
    // 宿主不用 process.env.X：loadConfig(env) 收 Env 记录（env.TENANT_MODE），必填/可选走
    // requireValue('KEY') / optional('KEY') 字符串形参。不认这三种形态 = 门禁对真实约束零覆盖。
    const r = run(
      'check-env-example.mjs',
      fixture({
        '.env.example': 'TENANT_MODE=single\n',
        'apps/server/src/config.ts':
          "const mode = env.TENANT_MODE\nconst url = requireValue('NEW_REQUIRED')\nconst cs = optional('NEW_OPTIONAL') ?? ''\n",
      }),
    )
    expect(r.status).toBe(1)
    expect(out(r)).toContain('apps/server/src/config.ts:2')
    expect(out(r)).toContain('NEW_REQUIRED')
    expect(out(r)).toContain('apps/server/src/config.ts:3')
    expect(out(r)).toContain('NEW_OPTIONAL')
    expect(out(r)).not.toContain('TENANT_MODE') // 已声明的键不报
  })

  it('env.NEW_KEY 未声明必须 fail；注释行 `# KEY=` 仍算声明', () => {
    const missing = run(
      'check-env-example.mjs',
      fixture({
        '.env.example': 'TENANT_MODE=single\n',
        'apps/server/src/config.ts': "const seed = env.NEW_KEY === '1'\n",
      }),
    )
    expect(missing.status).toBe(1)
    expect(out(missing)).toContain('apps/server/src/config.ts:1')
    expect(out(missing)).toContain('NEW_KEY')
    expect(out(missing)).toContain('[B9]')

    // 真实仓形态：SEED_DEMO 在 .env.example 里只以注释行存在（可选开关，不该复制即生效）
    const commented = fixture({
      '.env.example': 'TENANT_MODE=single\n# SEED_DEMO=1  # dev：启动期种 demo 租户（生产不设）\n',
      'apps/server/src/config.ts': "const seed = env.SEED_DEMO === '1'\n",
    })
    expect(run('check-env-example.mjs', commented).status).toBe(0)
  })

  it('同一行的等价写法（process.env.X 与 env.X）只报一次', () => {
    const r = run(
      'check-env-example.mjs',
      fixture({
        '.env.example': 'FOO=1\n',
        'apps/server/src/a.ts': 'const a = process.env.DUP_KEY; const b = env.DUP_KEY\n',
      }),
    )
    expect(r.status).toBe(1)
    expect(out(r)).toContain('check-env-example: 1 处违规')
  })

  it('跳过 *.test.*（测试里 set/读 env 是 fixture 装配，不是部署面）', () => {
    const r = run(
      'check-env-example.mjs',
      fixture({
        '.env.example': 'FOO=1\n',
        'apps/server/src/a.test.ts': 'const u = process.env.DATABASE_URL_FIXTURE\n',
      }),
    )
    expect(r.status).toBe(0)
  })

  it('基准文件 .env.example 缺失 = 违规（不静默放行）', () => {
    const r = run('check-env-example.mjs', fixture({ 'apps/server/src/a.ts': 'const a = process.env.FOO\n' }))
    expect(r.status).toBe(1)
    expect(out(r)).toContain('.env.example')
  })

  it('对当前仓跑必须干净（Step 2 硬要求）', () => {
    const r = run('check-env-example.mjs', repoRoot)
    expectClean(r)
  })
})
