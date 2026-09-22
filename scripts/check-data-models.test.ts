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
