// scripts/check-data-models.test.ts — dbt 工件静态门禁（issue #150 / 计划 Task 4）的 fixture 测试。
//
// 为什么是 fixture 驱动：本门禁的价值全在「**哪一格红了**」——计划 L649 的六格逐格钉住一条检查
// 项，本文件另补两格（审计文件名碰撞 / 真仓自检）与 CLI 对外契约。断言面刻意落在
// `(file, line)` + message 关键词上（与 check-tenant-isolation.test.ts 同形）：断言全量文案会让
// 「改文案」变成红；断言只看 `length > 0` 则「门禁退化」发现不了（六个检查项塌成一个也算绿）。
//
// ⚠️ 基线 fixture（compliant）必须**真合规**：五格是「只改一处」的变异，若基线自己就违规，
//    五格的断言会全部变成「报了两条」——那时你分不清红的是被变异的那条检查项，还是基线里的另一条。
//
// ⚠️ 门禁的**结构可解析**（YAML/SQL 形态）在本文件里是真验的；**dbt 语义可解析**（`dbt parse`）
//    **未验**——本机没有 dbt，见 dbt/README.md「未验清单」。
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { checkDataModels, metricToAuditFileName } from './check-data-models.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const scriptsDir = join(repoRoot, 'scripts')

const tmpRoots: string[] = []

/** 建一个临时 fixture 根目录（files: 相对路径 → 内容），afterAll 统一删除 */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'platform-data-models-'))
  tmpRoots.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

afterAll(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true })
})

const SOURCES = 'dbt/models/common/staging/sources.yml'
const STAGING = 'dbt/models/common/staging/stg_lemeng_retail_detail.sql'
const MARTS = 'dbt/models/common/marts/fct_retail_sale.sql'
const METRICS = 'dbt/semantics/l1_metrics.yml'
const AUDIT = 'dbt/tests/audit_retail__net_sales.sql'

/**
 * 基线：一份**最小但完整**的合规 dbt 目录。
 *
 * 三处刻意放进去的「反面对照」，它们必须**不**产生违规（否则门禁会把规范的写法判成违规，
 * 上线即被人关掉）：
 *   ① staging 的注释里点了 `::double` 与 `union_by_name` 的名字——**注释位不算代码位**
 *      （真实仓的 staging 注释正是这样写的：把禁忌形态写在旁边提醒后来者）；
 *   ② marts 的 `::double precision` 是 **PG 原生类型**，与要被拦的 DuckDB shell 类型
 *      `::double` 不同形，照规格放行；
 *   ③ staging 文件名与 sources.yml 的 `lemeng` + `retail_detail` 严格同构
 *      （`stg_<source>_<table>.sql`）——④ 是**双向**的，只对一半就红。
 */
function compliant(): Record<string, string> {
  return {
    [SOURCES]: [
      'version: 2',
      'sources:',
      '  - name: lemeng',
      '    tables:',
      '      - name: retail_detail',
      '',
    ].join('\n'),
    [STAGING]: [
      '-- 禁忌形态写在注释里是允许的：::double 与 union_by_name 都只拦代码位。',
      'with r as (',
      "    select * from read_parquet('s3://bucket/lemeng/retail_detail/3120/**/*.parquet')",
      ')',
      'select',
      "    r['amount']::numeric as amount",
      'from r',
      '',
    ].join('\n'),
    [MARTS]: [
      'select',
      "    '3120' as system_book,",
      '    sum(amount)::double precision as net_amount',
      'from staging.stg_lemeng_retail_detail',
      'group by 1',
      '',
    ].join('\n'),
    [METRICS]: [
      'metrics:',
      '  - name: "retail:net_sales"',
      '    expression: "sum(fct_retail_sale.net_amount)"',
      '    grain: [system_book, bizday]',
      '    owner: data-platform',
      '    tier: certified',
      '    definition: 净销售额 = 有效零售订单成交金额合计',
      '',
    ].join('\n'),
    [AUDIT]: 'select 1 where false\n',
  }
}

/** 基线 + 一处变异 ⇒ 临时目录 */
function variant(mutate: (files: Record<string, string>) => void): string {
  const files = compliant()
  mutate(files)
  return fixture(files)
}

/** CLI 入口（tsx 运行时：脚本 import 了 `yaml` 依赖，纯 node 也能跑，但与门禁本体同路更稳） */
function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', join(scriptsDir, 'check-data-models.mjs'), ...args], {
      cwd: repoRoot,
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

describe('metricToAuditFileName：`: ` → `__` 的**唯一映射规则**（T9 消费同一个函数，禁止另造一套）', () => {
  it('计划 L645 的逐字样例：aftersales:refund_ratio → audit_aftersales__refund_ratio.sql', () => {
    expect(metricToAuditFileName('aftersales:refund_ratio')).toBe('audit_aftersales__refund_ratio.sql')
  })

  it('返回值是**文件名**（不含 dbt/tests/ 前缀），且只替换冒号、不动其他下划线', () => {
    expect(metricToAuditFileName('retail:net_sales')).toBe('audit_retail__net_sales.sql')
    expect(metricToAuditFileName('data__x:y')).toBe('audit_data__x__y.sql')
  })
})

describe('门禁六格（计划 L649）+ 附加两格', () => {
  it('格①：合规目录 → 干净（含注释位与 ::double precision 两处反面对照）', () => {
    const root = variant(() => {})
    expect(checkDataModels(root)).toEqual([])
  })

  it('格②：语义声明缺 owner → 违规，且指到声明文件', () => {
    const root = variant((f) => {
      f[METRICS] = f[METRICS].replace('    owner: data-platform\n', '')
    })
    const violations = checkDataModels(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.file).toBe(METRICS)
    expect(violations[0]?.message).toContain('owner')
    expect(violations[0]?.message).toContain('retail:net_sales')
  })

  it('格③：staging 用 `::double` → 违规（`::double precision` 不报，见格①的反面对照）', () => {
    const root = variant((f) => {
      f[STAGING] = f[STAGING].replace("r['amount']::numeric as amount", "r['amount']::double as amount")
    })
    const violations = checkDataModels(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.file).toBe(STAGING)
    expect(violations[0]?.line).toBeGreaterThan(0)
    expect(violations[0]?.message).toContain('::double')
  })

  // ── 规则 ② 的第二形态：`CAST(expr AS double)` ────────────────────────────────────────
  // 坑 #4 的触发条件是「**裸 `double` 去查 pg_type**」（触发器是类型名查找，不是 `::` 这个运算符）。
  // `CAST(expr AS Typename)` 的 Typename 与 `::` 走同一条路 ⇒ 两者必须同红；且 `CAST` 是比 `::`
  // 更常见的写法（评审 §RR1.8 探针 G：修前这一格**逃检**，故本格是「先红后绿」的红格）。
  it('格③附带：代码位 `cast(... as double)` → 违规（与 `::double` 同一条类型名查找路径，坑 #4）', () => {
    const root = variant((f) => {
      f[STAGING] = f[STAGING].replace(
        "r['amount']::numeric as amount",
        "cast(r['amount'] as double) as amount",
      )
    })
    const violations = checkDataModels(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.file).toBe(STAGING)
    expect(violations[0]?.line).toBeGreaterThan(0)
    expect(violations[0]?.message).toContain('double')
    expect(violations[0]?.message).toContain('坑 #4')
  })

  it('格③反面对照：代码位 `cast(... as double precision)` → 绿（PG 原生类型，负向前瞻不得误伤）', () => {
    const root = variant((f) => {
      // 把 marts 里**唯一**的 `double` 形态换成 CAST 写法 ⇒ 本格单独隔离「`as double precision` 会不会被误伤」
      f[MARTS] = f[MARTS].replace(
        '    sum(amount)::double precision as net_amount',
        '    cast(sum(amount) as double precision) as net_amount',
      )
    })
    expect(checkDataModels(root)).toEqual([])
  })

  it('格④：staging 无 `r[`取列模式 → 违规（SELECT * 能过、点名取列报 column does not exist）', () => {
    const root = variant((f) => {
      f[STAGING] = [
        'with r as (',
        "    select * from read_parquet('s3://bucket/lemeng/retail_detail/3120/**/*.parquet')",
        ')',
        'select * from r',
        '',
      ].join('\n')
    })
    const violations = checkDataModels(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.file).toBe(STAGING)
    expect(violations[0]?.message).toContain("r['")
  })

  it('格④附带：`union_by_name` 兜漂移 → 违规（漂移必须显式处理）', () => {
    const root = variant((f) => {
      f[STAGING] = f[STAGING].replace('select * from read_parquet(', 'select * from read_parquet(').replace(
        '/**/*.parquet\')',
        "/**/*.parquet', union_by_name = true)",
      )
    })
    const violations = checkDataModels(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.message).toContain('union_by_name')
  })

  it('格④附带：staging 与 sources.yml 不一一对应（源没有对应 staging）→ 违规', () => {
    const root = variant((f) => {
      f[SOURCES] = f[SOURCES].replace('      - name: retail_detail\n', '      - name: retail_detail\n      - name: retail_refund\n')
    })
    const violations = checkDataModels(root)
    expect(violations).toHaveLength(1)
    // 「声明了但工件缺席」类违规的 `file` 约定 = **该缺席工件的应有路径**（可据此直接建文件），
    // 声明侧的位置写进 message —— 本文件与 ⑦（缺 audit_*.sql）用同一条约定，两者形状一致。
    expect(violations[0]?.file).toBe('dbt/models/common/staging/stg_lemeng_retail_refund.sql')
    expect(violations[0]?.message).toContain('retail_refund')
    expect(violations[0]?.message).toContain(SOURCES)
  })

  it('格④附带：反向 —— staging 模型没有对应的源声明 → 违规（指到那个模型文件本身）', () => {
    const root = variant((f) => {
      f['dbt/models/common/staging/stg_lemeng_retail_orphan.sql'] = "select r['amount'] from r\n"
    })
    const violations = checkDataModels(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.file).toBe('dbt/models/common/staging/stg_lemeng_retail_orphan.sql')
    expect(violations[0]?.message).toContain('retail_orphan')
  })

  it('格⑤：同名指标两处（跨文件）→ 违规', () => {
    const root = variant((f) => {
      f['dbt/semantics/l2_tenant_metrics.yml'] = [
        'metrics:',
        '  - name: "retail:net_sales"',
        '    expression: "sum(fct_retail_sale.net_amount)"',
        '    grain: [system_book, bizday]',
        '    owner: tenant-admin',
        '    tier: experimental',
        '    definition: 同名但另一处定义（口径分叉）',
        '',
      ].join('\n')
    })
    const violations = checkDataModels(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.file).toBe('dbt/semantics/l2_tenant_metrics.yml')
    expect(violations[0]?.message).toContain('同名')
    expect(violations[0]?.message).toContain('retail:net_sales')
  })

  it('格⑤附带：指标名缺命名空间前缀 → 违规', () => {
    const root = variant((f) => {
      f[METRICS] = f[METRICS].replace('"retail:net_sales"', '"net_sales"')
    })
    const violations = checkDataModels(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.message).toContain('net_sales')
  })

  it('格⑥：声明了指标却没有对应 audit_*.sql → 违规（每个指标一条独立复算）', () => {
    const root = variant((f) => {
      delete f[AUDIT]
    })
    const violations = checkDataModels(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.file).toBe(AUDIT)
    expect(violations[0]?.message).toContain('retail:net_sales')
  })

  it('附加格：两个指标名映射到同一个 audit 文件名 → 违规（映射规则必须无碰撞）', () => {
    const root = variant((f) => {
      f[METRICS] = [
        'metrics:',
        '  - name: "retail:a__b"',
        '    expression: "sum(fct_retail_sale.net_amount)"',
        '    grain: [system_book]',
        '    owner: data-platform',
        '    tier: certified',
        '    definition: 甲',
        '  - name: "retail__a:b"',
        '    expression: "sum(fct_retail_sale.net_amount)"',
        '    grain: [system_book]',
        '    owner: data-platform',
        '    tier: certified',
        '    definition: 乙',
        '',
      ].join('\n')
      // 两个名字都映射到 audit_retail__a__b.sql ⇒ 只存在一个文件时，⑦ 的存在性检查会对两边都通过
      delete f[AUDIT]
      f['dbt/tests/audit_retail__a__b.sql'] = 'select 1 where false\n'
    })
    const violations = checkDataModels(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.message).toContain('audit_retail__a__b.sql')
    expect(violations[0]?.message).toContain('retail__a:b')
  })
})

describe('CLI 对外契约（干净 exit 0 + OK 行；违规 exit 1 + 每条一行）', () => {
  it('合规 fixture → exit 0，stdout 有 OK 行与检查面计数（防空转）', () => {
    const root = variant(() => {})
    const r = runCli([root])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('check-data-models: OK')
    expect(r.stdout, '计数必须打印：否则「本仓没有 dbt/ 所以永远绿」与「真检查过」同色').toContain('声明指标 1')
  })

  it('违规 fixture → exit 1，违规行带相对路径与标签', () => {
    const root = variant((f) => {
      delete f[AUDIT]
    })
    const r = runCli([root])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('check-data-models: 1 处违规')
    expect(r.stderr).toContain(AUDIT)
    expect(r.stderr).toContain('[data-models]')
  })

  it('真仓自检（默认 rootDir = 仓库根）：本任务自己的 dbt/ 必须干净', () => {
    const r = runCli([])
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════
// T11（P3 / W3 串行首任务）追加：每租户 schema 派生 + 租户启用集对账
//
// **为什么追加在本文件**：任务书硬约束 1 把 T11 的落点钉成「`dbt/macros/**`、`dbt/README.md`、
// `deploy/data-tenants/**`、`scripts/reconcile-data-tenants.mjs`、`scripts/check-data-models.test.ts`
// （只追加）」，且计划 Task 11 Step 3 的 `git add` 也只列了**这一个**测试文件 ⇒ T11 的两组
// fixtures 都落在这里（「对账的纯核 fixtures」与「门禁 fixtures」同址：文件名的字面含义不再覆盖
// 全部内容，这是既定约束的取舍，**不是笔误**；偏离点已记进 task-11-report.md）。
//
// 本段**不重排、不改写、不删**上面任何既有用例（W1 刚落地，且同期有人在改 `check-data-models.mjs`
// 本体 —— 本波 T11 只许在 `.test.ts` 里追加）。故所有新增 import 与 helper 都写在本段内，
// 动态 `import()` 把「模块缺席」的失败**局限在本段**（否则本文件整体加载失败，上面那批既有用例
// 会跟着一起红 —— 那时看不清红的是谁）。
// ════════════════════════════════════════════════════════════════════════════════════════

import { readFileSync as readFileSyncT11 } from 'node:fs'
import { maskSqlComments as maskSqlCommentsT11 } from './check-data-models.mjs'

/** 租户键 → 资源名 的**唯一用例表**：macro 与对账脚本必须对同一张表给出同一答案。 */
const TENANT_KEY_CASES: Array<[string, string]> = [
  ['acme', 'tenant_acme'],
  ['beta', 'tenant_beta'],
  ['acme-org', 'tenant_acme_org'],
  ['Acme-Org', 'tenant_acme_org'],
  ['a_b', 'tenant_a_b'],
]

const MACRO_REL = 'dbt/macros/generate_schema_name.sql'

/** 掩掉 Jinja 注释（`{# … #}`）。
 *  为什么必须掩：本仓的 macro/README 惯例是**在注释里点名禁忌形态**（dbt/README 规则② 那行就是
 *  这么写的）。不掩 Jinja 注释，「不许出现裸字面量 schema 名」这条断言就会把自己规范里举的
 *  反例判成违规（与门禁本体 maskSqlComments 的注释位判断①同因）。 */
function maskJinjaComments(src: string): string {
  return src.replace(/\{#[\s\S]*?#\}/g, (m) => ' '.repeat(m.length))
}

/** macro 的**代码位**文本：Jinja 注释 + SQL 注释都掩掉（两种注释位都不算代码位）。 */
function macroCode(): string {
  return maskSqlCommentsT11(maskJinjaComments(readFileSyncT11(join(repoRoot, MACRO_REL), 'utf8')))
}

/** 取代码位上的 SQL 单引号字面量。 */
function quotedLiterals(src: string): string[] {
  return [...src.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? '')
}

/** 「整名」形态的裸字面量 schema（`'tenant_acme'` 是裸字面量；`'tenant_'` 是**前缀**，不是）。
 *  抽成函数是为了让反面对照能喂合成源，证明这条判据**不是空转**。 */
function bareLiteralSchemaNames(src: string): string[] {
  return quotedLiterals(src).filter((lit) => /^tenant_[a-z0-9_]+$/.test(lit))
}

describe('T11 格①：generate_schema_name 的每租户 schema 必须由 var(\'tenant\') 派生', () => {
  it('macro 在场，且 schema 名由 var(\'tenant\') 派生（lower + `-`→`_` 归一，与对账脚本同一用例表）', () => {
    const code = macroCode()
    expect(code, `${MACRO_REL} 缺席 —— 每租户 schema 的唯一定义点`).toMatch(/var\(\s*'tenant'\s*[,)]/)
    expect(code, '归一：大小写折叠').toMatch(/lower/)
    expect(code, '归一：`-` → `_`（casdoor org 常带连字符，PG 标识符里不安全）').toMatch(
      /replace\(\s*'-'\s*,\s*'_'\s*\)/,
    )
    expect(code, '租户 schema 的命名前缀是唯一的落点（「tenant_」这个**前缀**字面量必须在）').toContain("'tenant_'")
  })

  it('macro 里**没有**裸字面量 schema 名（整名直写 `tenant_xxx` ⇒ 派生被架空，每租户会共用同一个 schema）', () => {
    expect(bareLiteralSchemaNames(macroCode())).toEqual([])
  })

  it('反面对照：合成源里的整名字面量**必须被这条判据抓到**（断言不是空转）', () => {
    expect(bareLiteralSchemaNames("{% macro m() %}{{ 'tenant_acme' }}{% endmacro %}")).toEqual(['tenant_acme'])
    // 前缀形态不算裸字面量（否则上面那条断言会被自己的前缀变成恒红）
    expect(bareLiteralSchemaNames("{% macro m() %}{{ 'tenant_' ~ var('tenant') }}{% endmacro %}")).toEqual([])
  })

  it('macro 的注释位**不算**代码位（注释里举反例是允许的，否则门禁一上线就被人关掉）', () => {
    expect(bareLiteralSchemaNames(maskJinjaComments("{% macro m() %}{# 反例：'tenant_acme' #}{{ 'tenant_' }}{% endmacro %}"))).toEqual([])
  })
})

describe('T11 格②：reconcile-data-tenants 的纯核（两侧集合的各种差集形态）', () => {
  /** 动态 import：模块缺席时只红本段，不连坐同文件既有用例。 */
  async function core(): Promise<{
    tenantKeyOf: (name: string) => string
    tenantSchemaName: (key: string) => string
    diffTenants: (
      platform: Array<{ org: string; key: string }>,
      schemas: string[],
      roles: string[],
    ) => {
      missingInData: Array<{ org: string; key: string; schema: string; role: string; schemaPresent: boolean; rolePresent: boolean }>
      missingInPlatform: Array<{ key: string; schema: string; role: string; schemaPresent: boolean; rolePresent: boolean }>
      unattributable: string[]
      clean: boolean
    }
  }> {
    return (await import('./reconcile-data-tenants.mjs')) as never
  }

  it('tenantSchemaName：与 macro 同一张用例表 + 非法键 fail-closed（绝不静默拼出一个坏标识符）', async () => {
    const { tenantSchemaName } = await core()
    for (const [key, expected] of TENANT_KEY_CASES) {
      expect(tenantSchemaName(key), `键 ${key}`).toBe(expected)
    }
    for (const bad of ['', '   ', 'a.b', 'json/x', 'a b']) {
      expect(() => tenantSchemaName(bad), `非法键 ${JSON.stringify(bad)} 必须抛`).toThrow()
    }
  })

  it('两侧一致 → clean，两个差集都空', async () => {
    const { diffTenants } = await core()
    const d = diffTenants(
      [{ org: 'acme-org', key: 'acme-org' }, { org: 'beta', key: 'beta' }],
      ['tenant_acme_org', 'tenant_beta'],
      ['tenant_acme_org', 'tenant_beta'],
    )
    expect(d).toEqual({ missingInData: [], missingInPlatform: [], unattributable: [], clean: true })
  })

  it('差集①「平台有、数据面无」→ 逐条列出（不是只给个计数，更不是静默）', async () => {
    const { diffTenants } = await core()
    const d = diffTenants(
      [{ org: 'acme-org', key: 'acme-org' }, { org: 'beta', key: 'beta' }],
      ['tenant_acme_org'],
      ['tenant_acme_org'],
    )
    expect(d.missingInData).toEqual([
      { org: 'beta', key: 'beta', schema: 'tenant_beta', role: 'tenant_beta', schemaPresent: false, rolePresent: false },
    ])
    expect(d.missingInPlatform).toEqual([])
    expect(d.clean).toBe(false)
  })

  it('差集②「数据面有、平台无」→ 逐条列出（退租/改名漏回收的形态）', async () => {
    const { diffTenants } = await core()
    const d = diffTenants(
      [{ org: 'acme-org', key: 'acme-org' }],
      ['tenant_acme_org', 'tenant_ghost'],
      ['tenant_acme_org', 'tenant_ghost'],
    )
    expect(d.missingInPlatform).toEqual([
      { key: 'ghost', schema: 'tenant_ghost', role: 'tenant_ghost', schemaPresent: true, rolePresent: true },
    ])
    expect(d.missingInData).toEqual([])
    expect(d.clean).toBe(false)
  })

  it('半建（schema 有、role 无）→ 也进差集①，且用 present 标志把「半」显式标出来', async () => {
    const { diffTenants } = await core()
    const d = diffTenants([{ org: 'acme-org', key: 'acme-org' }], ['tenant_acme_org'], [])
    expect(d.missingInData).toEqual([
      { org: 'acme-org', key: 'acme-org', schema: 'tenant_acme_org', role: 'tenant_acme_org', schemaPresent: true, rolePresent: false },
    ])
    // 半建的 schema **不算孤儿**：它的键在平台侧存在，只是 role 那半没建
    expect(d.missingInPlatform).toEqual([])
  })

  it('半建反过来（role 有、schema 无）→ 同样进差集①', async () => {
    const { diffTenants } = await core()
    const d = diffTenants([{ org: 'acme-org', key: 'acme-org' }], [], ['tenant_acme_org'])
    expect(d.missingInData).toEqual([
      { org: 'acme-org', key: 'acme-org', schema: 'tenant_acme_org', role: 'tenant_acme_org', schemaPresent: false, rolePresent: true },
    ])
  })

  it('两边命名归一后同名 ⇒ clean（证明两侧用的是同一条派生规则，不是各写一套）', async () => {
    const { diffTenants } = await core()
    const d = diffTenants([{ org: 'Acme-Org', key: 'Acme-Org' }], ['tenant_acme_org'], ['tenant_acme_org'])
    expect(d.clean).toBe(true)
  })

  it('tenantKeyOf：数据面名字 → 键，认不出的一律返回空串（**不猜**）', async () => {
    const { tenantKeyOf } = await core()
    expect(tenantKeyOf('tenant_acme')).toBe('acme')
    expect(tenantKeyOf('tenant_acme_org')).toBe('acme_org')
    for (const unknown of ['public', 'tenant_', 'tenant_acme-org', 'stg_lemeng_retail_detail']) {
      expect(tenantKeyOf(unknown), `认不出的名字 ${unknown}`).toBe('')
    }
  })

  it('认不出的数据面对象**显式进 unattributable**（不许静默丢弃：丢弃 = 漂移看不见）', async () => {
    const { diffTenants } = await core()
    const d = diffTenants([{ org: 'acme-org', key: 'acme-org' }], ['tenant_acme_org', 'tenant_'], ['tenant_acme_org'])
    expect(d.unattributable).toEqual(['tenant_'])
    expect(d.clean).toBe(false)
  })
})

describe('T11 格②附带：平台侧「启用集」的算法（与 enabledFor 两个消费方同源）', () => {
  async function core(): Promise<{
    platformTenantRefs: (
      tenants: Array<{ id: number; org: string }>,
      modules: Array<{ tenant_id: number; module_id: string; enabled: boolean }>,
      loaded: string[],
    ) => Array<{ org: string; key: string }>
  }> {
    return (await import('./reconcile-data-tenants.mjs')) as never
  }

  it('`tenant_module` 无行 = 启用（与 enabledFor 同语义）；显式 enabled=false 才剔除', async () => {
    const { platformTenantRefs } = await core()
    expect(
      platformTenantRefs(
        [{ id: 1, org: 'acme-org' }, { id: 2, org: 'beta' }, { id: 3, org: 'gamma' }],
        [
          { tenant_id: 2, module_id: 'data', enabled: false },
          { tenant_id: 3, module_id: 'data', enabled: true },
        ],
        ['aftersales', 'data'],
      ),
    ).toEqual([
      { org: 'acme-org', key: 'acme-org' },
      { org: 'gamma', key: 'gamma' },
    ])
  })

  it('别的模块的启用行不影响 data 的启用集（只看 data 那一行）', async () => {
    const { platformTenantRefs } = await core()
    expect(
      platformTenantRefs(
        [{ id: 1, org: 'acme-org' }],
        [{ tenant_id: 1, module_id: 'aftersales', enabled: false }],
        ['aftersales', 'data'],
      ),
    ).toEqual([{ org: 'acme-org', key: 'acme-org' }])
  })

  it('data 模块未装载 ⇒ 启用集为空（「模块不在本仓」不能被读成「所有租户都停用了」）', async () => {
    const { platformTenantRefs } = await core()
    expect(platformTenantRefs([{ id: 1, org: 'acme-org' }], [], ['aftersales', 'demo'])).toEqual([])
  })
})
