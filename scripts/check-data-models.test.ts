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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { RESERVED_METRIC_ID_PREFIXES, checkDataModels, freshnessSlaError, metricToAuditFileName, ratioShapeError } from './check-data-models.mjs'

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
// ⚠️ 下面这组是**夹具内的合成名**（`retail_detail` / `stg_lemeng_retail_detail`），只活在临时目录里：
//    真仓那份同名的旧湖 staging 已于 2026-10-06 **仓内退役**（`git rm`）——本文件的同名常量与它无关，
//    别因为「仓里搜不到这个文件」就去改夹具（规律 ④ 的双向配对靠它自己的一对源/模型成立）。
const STAGING = 'dbt/models/common/staging/stg_lemeng_retail_detail.sql'
const MARTS = 'dbt/models/common/marts/fct_retail_sale.sql'
// 读面视图（规则 ⑩ 的第三类扫描对象）：`dbt/models/<域>/views/vw_*.sql`
const VIEW = 'dbt/models/common/views/vw_retail_detail.sql'
const METRICS = 'dbt/semantics/l1_metrics.yml'
// 对账 test 按域分子目录（`dbt/tests/<源>/`）—— 与物料化侧逐域选取同源，见规则 ⑦
const AUDIT = 'dbt/tests/lemeng/audit_lemeng__retail__net_sales.sql'

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
 *
 * 主体列（规则 ⑩）：基线里 `MARTS` 与 `STAGING` **都带** `'acme' as org` —— 基线必须**无条件干净**，
 *   不依赖任何豁免（真名单 `SUBJECT_ORG_EXEMPT` 已随 2026-10-06 的旧湖 staging 仓内退役**清空**）。
 *   「豁免真的生效」这一半改由**注入合成豁免**的格⑩-6 单独钉住（不再让基线替它背书）。
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
      "    r['amount']::numeric as amount,",
      "    'acme' as org",
      'from r',
      '',
    ].join('\n'),
    [MARTS]: [
      'select',
      "    '3120' as system_book,",
      "    'acme' as org,",
      '    sum(amount)::double precision as net_amount',
      'from staging.stg_lemeng_retail_detail',
      'group by 1',
      '',
    ].join('\n'),
    [METRICS]: [
      'metrics:',
      '  - name: "lemeng:retail:net_sales"',
      '    expression: "sum(fct_retail_sale.net_amount)"',
      '    grain: [system_book, bizday]',
      '    owner: data-platform',
      '    tier: certified',
      '    source: lemeng',
      '    freshness_sla_days: 1',
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
  // ⚠️ 本格的 `aftersales:refund_ratio` 是**刻意保留的计划 L645 逐字样例**（两段），**不是**当前生效的
  //    声明名（现行声明名是三段式 `<源>:<业务域>:<指标>`，见 l1_metrics.yml）。保留它 = 保住对计划
  //    原文的引用；`metricToAuditFileName` 对段数不敏感 ⇒ 拿它测「每个 `:` 都换 `__`」仍然有效。
  it('计划 L645 的逐字样例：aftersales:refund_ratio → audit_aftersales__refund_ratio.sql', () => {
    expect(metricToAuditFileName('aftersales:refund_ratio')).toBe('audit_aftersales__refund_ratio.sql')
  })

  it('返回值是**文件名**（不含 dbt/tests/ 前缀），且只替换冒号、不动其他下划线', () => {
    expect(metricToAuditFileName('lemeng:retail:net_sales')).toBe('audit_lemeng__retail__net_sales.sql')
    expect(metricToAuditFileName('data__x:y:z')).toBe('audit_data__x__y__z.sql')
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
    expect(violations[0]?.message).toContain('lemeng:retail:net_sales')
  })

  // ── 规则 ⑤ 的**源维度**那一半（计划 5 Task 3）：`source` 必填 + 形状 ────────────────────
  // ⚠️ 与既有的 `sources`（**对象存储路径**，人读、选填、无门禁）**不是一回事**：
  //    `source` 是**源系统**（如 `lemeng`），Task 5 的裁剪与 Task 6 的对账都靠它。
  //    本格只钉「缺了就报」，不碰 `sources`。
  it('格⑤附带：语义声明缺 source（源系统）→ 违规（没有它，源维度在声明面就没有事实源）', () => {
    const root = variant((f) => {
      f[METRICS] = f[METRICS].replace('    source: lemeng\n', '')
    })
    const violations = checkDataModels(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.file).toBe(METRICS)
    expect(violations[0]?.message).toContain('source')
    expect(violations[0]?.message).toContain('lemeng:retail:net_sales')
  })

  // ── 规则 ⑥-c：保留给测试夹具的命名空间（把「夹具前缀不撞真声明」从约定变机检）────────────
  // 背景：平台桶（`data.metrics` 的 `org='platform'`）跨测试文件共用、清理只能按 id 删 ⇒
  // 真声明一旦占用夹具前缀的命名空间，某个测试的 afterAll 就会删掉那条**真行**（实测过一次）。
  it('格⑤附带：声明名占用**保留给测试夹具**的命名空间 → 违规', () => {
    for (const prefix of RESERVED_METRIC_ID_PREFIXES) {
      const root = variant((f) => {
        f[METRICS] = f[METRICS].replace('"lemeng:retail:net_sales"', `"${prefix}retail:net_sales"`)
        // 不需要造对账文件：⑥-c 命中即 `continue`（与 ⑥-a 同一处置），⑦ 不会为它报第二条
      })
      const violations = checkDataModels(root)
      expect(violations, `声明名 ${prefix}net_sales 没被判违规`).toHaveLength(1)
      expect(violations[0]?.message).toContain(prefix)
      expect(violations[0]?.message).toContain('保留给测试夹具')
    }
  })

  it('★ 保留清单与仓内测试夹具前缀**同源**（清单过期 = 这条机检对这种前缀失效）', () => {
    // 为什么需要这条：保留清单写在门禁里（唯一事实源），而前缀写在各自测试文件里。
    // 二者一旦不同步（新增夹具前缀却忘了登记），那条前缀就**不受 ⑥-c 保护**——
    // 而这正是「测试删真行」复发的入口。故逐文件核对：每个夹具前缀都必须在清单里。
    const FIXTURE_FILES = [
      'modules/data/domain/metric-store.test.ts',
      'modules/data/routes/metrics.test.ts',
      'modules/data/catalog-consumers.test.ts',
    ]
    for (const rel of FIXTURE_FILES) {
      const src = readFileSync(join(repoRoot, rel), 'utf8')
      const m = src.match(/^const (?:L1_ID_PREFIX|L1_PREFIX) = '([^']+)'/m)
      expect(m, `${rel} 里找不到夹具前缀常量（改过名字就要同步本用例）`).not.toBeNull()
      expect(RESERVED_METRIC_ID_PREFIXES, `${rel} 的前缀 ${m?.[1]} 不在保留清单里`).toContain(m?.[1])
    }
  })

  it('格⑤附带：source 形状不合（大写 / 连字符 / 前导数字）→ 违规', () => {
    // 三个反例各跑一次：形状规则是 `^[a-z][a-z0-9_]*$`（小写蛇形，与指标名三段同一形态）
    for (const bad of ['Le-meng', 'LEMENG', '3lemeng']) {
      const root = variant((f) => {
        f[METRICS] = f[METRICS].replace('    source: lemeng', `    source: ${bad}`)
      })
      const violations = checkDataModels(root)
      expect(violations, `source: ${bad} 没被判违规`).toHaveLength(1)
      expect(violations[0]?.message).toContain('source')
    }
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
        // 带 `as org`：本格测的是规则 ①（缺 `r['`），规则 ⑩ 必须**不**掺进来 —— 否则违例数变 2，
        // `toHaveLength(1)` 就不在测 ① 了（豁免名单清空后这一条才暴露：基线以外全文替换 STAGING 的格
        // 都得自己带上 org）。
        "    select *, 'acme' as org from read_parquet('s3://bucket/lemeng/retail_detail/3120/**/*.parquet')",
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
    // ⚠️ 落点自 2026-10-17 起带**域**占位符（目录即域，规则 ⑪）：声明面不指定域 ⇒ 这里只能给形态
    //    `models/<域>/staging/…`，由人来把它落到本域的目录（fixture 里那条声明是 `lemeng` 域的）。
    expect(violations[0]?.file).toBe('dbt/models/<域>/staging/stg_lemeng_retail_refund.sql')
    expect(violations[0]?.message).toContain('retail_refund')
    expect(violations[0]?.message).toContain(SOURCES)
  })

  it('格④附带：反向 —— staging 模型没有对应的源声明 → 违规（指到那个模型文件本身）', () => {
    const root = variant((f) => {
      // 带 `as org`：本格测的是规则 ④（孤儿 staging），其余规则必须**不**掺进来 ——
      // 否则违例数变 2、断言 toHaveLength(1) 就不在测 ④ 了（规则 ⑩ 上线时实测踩到）
      f['dbt/models/common/staging/stg_lemeng_retail_orphan.sql'] =
        "select r['amount'] as amount, 'acme' as org from r\n"
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
        '  - name: "lemeng:retail:net_sales"',
        '    expression: "sum(fct_retail_sale.net_amount)"',
        '    grain: [system_book, bizday]',
        '    owner: tenant-admin',
        '    tier: experimental',
        '    source: lemeng',
      '    freshness_sla_days: 1',
        '    definition: 同名但另一处定义（口径分叉）',
        '',
      ].join('\n')
    })
    const violations = checkDataModels(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.file).toBe('dbt/semantics/l2_tenant_metrics.yml')
    expect(violations[0]?.message).toContain('同名')
    expect(violations[0]?.message).toContain('lemeng:retail:net_sales')
  })

  it('格⑤附带：指标名缺命名空间前缀 → 违规', () => {
    const root = variant((f) => {
      f[METRICS] = f[METRICS].replace('"lemeng:retail:net_sales"', '"net_sales"')
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
    expect(violations[0]?.message).toContain('lemeng:retail:net_sales')
  })

  it('附加格：两个指标名映射到同一个 audit 文件名 → 违规（映射规则必须无碰撞）', () => {
    const root = variant((f) => {
      f[METRICS] = [
        'metrics:',
        '  - name: "lemeng:retail:a__b"',
        '    expression: "sum(fct_retail_sale.net_amount)"',
        '    grain: [system_book]',
        '    owner: data-platform',
        '    tier: certified',
        '    source: lemeng',
      '    freshness_sla_days: 1',
        '    definition: 甲',
        '  - name: "lemeng:retail__a:b"',
        '    expression: "sum(fct_retail_sale.net_amount)"',
        '    grain: [system_book]',
        '    owner: data-platform',
        '    tier: certified',
        '    source: lemeng',
      '    freshness_sla_days: 1',
        '    definition: 乙',
        '',
      ].join('\n')
      // 两个名字都映射到 audit_lemeng__retail__a__b.sql ⇒ 只存在一个文件时，⑦ 的存在性检查会对两边都通过
      delete f[AUDIT]
      f['dbt/tests/lemeng/audit_lemeng__retail__a__b.sql'] = 'select 1 where false\n'
    })
    const violations = checkDataModels(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.message).toContain('audit_lemeng__retail__a__b.sql')
    expect(violations[0]?.message).toContain('lemeng:retail__a:b')
  })
})

/** 合成豁免（测试注入用）：真名单 `SUBJECT_ORG_EXEMPT` 已随旧湖 staging（`stg_lemeng_retail_detail.sql`）
 *  的 2026-10-06 仓内退役清空 ⇒ 豁免机制的活体用例改由这个**注入的 Map** 供给，
 *  免得「登记了就静默」这一半跟着真名单一起消失（门禁本体见 `checkDataModels(rootDir, opts)`）。 */
function syntheticExempt(): Map<string, string> {
  return new Map([[STAGING, '测试注入：合成豁免（真名单已随旧湖 staging 退役清空）']])
}

describe('格⑩：主体列 org（issue #176 缺口 A / spec 2026-09-26-subject-org-column-design）', () => {
  it('格⑩-1：基线干净 —— 每个主体模型都带 `as org`（不依赖豁免）', () => {
    // 基线的 STAGING 与 MARTS **都**带 `'acme' as org`（见 compliant 头注）⇒ 这里必须恰好 0 违例。
    // 规则 ⑩ 的豁免机制**不在**这格里测（真名单已清空）——它由格⑩-5 / 格⑩-6 用注入的豁免覆盖。
    expect(checkDataModels(fixture(compliant()))).toEqual([])
  })

  it('格⑩-2：marts 缺 `as org` → 恰好 1 条，且指到那个模型文件', () => {
    const root = variant((f) => {
      f[MARTS] = f[MARTS].replace("    'acme' as org,\n", '')
    })
    const violations = checkDataModels(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.file).toBe(MARTS)
    expect(violations[0]?.message).toContain('org')
  })

  it('格⑩-3：只在**注释**里写 `as org` → 仍违规（注释位不算代码位，同实现判断①）', () => {
    // 把真列换成注释里的一句话：掩码后代码位没有 `as org` ⇒ 必须红（否则「写句注释就过关」）
    const root = variant((f) => {
      f[MARTS] = `-- 被注掉了：'acme' as org\n` + f[MARTS].replace("    'acme' as org,\n", '')
    })
    const violations = checkDataModels(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.file).toBe(MARTS)
  })

  it('格⑩-4：**非豁免** staging 缺 `as org` → 恰好 1 条（staging 侧同样在扫描面内）', () => {
    const root = variant((f) => {
      // 非豁免的 staging 必须同时有源声明，否则会先因规则 ④ 变红 ⇒ 这里补一份源（6 空格缩进，
      // 与基线里 `- name: retail_detail` 同级）
      f[SOURCES] = f[SOURCES] + '      - name: retail_order_line\n'
      f['dbt/models/common/staging/stg_lemeng_retail_order_line.sql'] = [
        "with r as (select * from read_parquet('s3://bucket/lemeng/retail_order_line/**/*.parquet'))",
        'select',
        "    r['system_book']::varchar as system_book",
        'from r',
        '',
      ].join('\n')
    })
    const violations = checkDataModels(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.file).toBe('dbt/models/common/staging/stg_lemeng_retail_order_line.sql')
  })

  it('格⑩-5：扫描面全落豁免上 ⇒ 空转自检报违规（规则空转 = 门禁不存在）', () => {
    // 只留「声明的源 + 一个**被豁免**的 staging 文件」，不建任何 marts ⇒ subjectScanned === 0。
    // 规则 ④ 双向在这一份里是满足的（与基线同形），所以这一条违规只能来自空转自检。
    // ⚠️ 豁免改由**注入**供给（真名单已清空）——注入的名单把 STAGING 划出扫描面，
    //    这正是「全落豁免上」这个前提的构造方式；不注入的话本格在真名单清空后就不成立了。
    const files = compliant()
    delete files[MARTS]
    const violations = checkDataModels(fixture(files), { subjectOrgExempt: syntheticExempt() })
    expect(violations).toHaveLength(1)
    expect(violations[0]?.message).toContain('空转')
  })

  it('格⑩-6：**注入的豁免真的静默**缺 org 的模型（豁免机制不因真名单清空而失效）', () => {
    // 把 STAGING 的真列 `'acme' as org` 拿掉（连它的逗号一起，别留下悬空逗号），
    // 同时把它注入豁免名单 ⇒ 规则 ⑩ 必须放行（0 违例）。
    // 与格⑩-4（非豁免 staging 缺列 → 红）配对：一个证「没登记就报」，一个证「登记了就静默」，
    // 两侧都不空转 —— 这是真名单清空后，豁免机制仍然有活体用例的唯一依据。
    const files = compliant()
    files[STAGING] = files[STAGING].replace("    r['amount']::numeric as amount,\n    'acme' as org\n", "    r['amount']::numeric as amount\n")
    const violations = checkDataModels(fixture(files), { subjectOrgExempt: syntheticExempt() })
    expect(violations).toEqual([])
  })

  it('格⑩-7：views 下 `vw_*` 缺 `as org` → 恰好 1 条（读面视图同样是租户可查的关系）', () => {
    // 视图与 marts/staging 一样会被 `modules/data` 按 `WHERE org = <orgId>` 查询（直读湖的读面），
    // 少了主体列 ⇒ 查询以 502 收场。规则 ⑩ 的扫描面必须含 views/，否则这一整类文件裸奔。
    const root = variant((f) => {
      f[VIEW] = [
        'select',
        "    r['amount']::numeric as amount",
        "from read_parquet('s3://bucket/lemeng/retail_detail/**/*.parquet') r",
        '',
      ].join('\n')
    })
    const violations = checkDataModels(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.file).toContain('vw_')
    expect(violations[0]?.message).toContain('org')
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
    // `collisions` 是修复笔 I1 加的桶（接口跟着走；这条断言没放宽：仍是「四个桶全空 + clean」）
    expect(d).toEqual({ missingInData: [], missingInPlatform: [], unattributable: [], collisions: [], clean: true })
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
    for (const unknown of ['public', 'tenant_', 'tenant_acme-org', 'stg_lemeng_retail_order_line']) {
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

// ════════════════════════════════════════════════════════════════════════════════════════
// T11 修复笔（评审 I1 / I2-a / M8）追加：**只追加**，上面 34 例一个字都不改。
//
// 唯一一处「改到既有行」的例外是 I1 给 `diffTenants` 的返回值加了 `collisions` 桶 ⇒
// 「两侧一致 → clean」那条 `toEqual` 必须跟着补 `collisions: []`（它**没有**放宽断言，
// 只是跟着接口走）。这一处已在 task-11-fix-report.md 的「与计划/任务书的冲突与偏离」里点名。
// ════════════════════════════════════════════════════════════════════════════════════════

const PROVISION_REL = 'deploy/data-tenants/provision-template.sql'

/** 对账纯核的类型（含 I1 新增的 `collisions` 桶）。 */
type ReconcileCore = {
  tenantSchemaName: (key: string) => string
  diffTenants: (
    platform: Array<{ org: string; key: string }>,
    schemas: string[],
    roles: string[],
  ) => {
    missingInData: Array<{ org: string; key: string; schema: string; role: string; schemaPresent: boolean; rolePresent: boolean }>
    missingInPlatform: Array<{ key: string; schema: string; role: string; schemaPresent: boolean; rolePresent: boolean }>
    unattributable: string[]
    collisions: Array<{ schema: string; orgs: string[]; keys: string[] }>
    clean: boolean
  }
}

/** 动态 import（模块缺席只红本段，不连坐同文件既有用例）。 */
async function reconcileCore(): Promise<ReconcileCore> {
  return (await import('./reconcile-data-tenants.mjs')) as never
}

/** 模板原文。 */
function provisionRaw(): string {
  return readFileSyncT11(join(repoRoot, PROVISION_REL), 'utf8')
}

/**
 * 模板的**代码位**：丢掉 `--` 行注释（本文件是 psql 脚本，注释只有行注释一种）。
 *
 * ⚠️ **不能用 `maskSqlComments`**（本文件上面 T11 段用的那个原语）：它**不掩字符串字面量**
 * （把它自己的头注判断①的原话），于是模板第 82 行的 `'…**不带 https://**：…'` 里
 * 「URL 后紧跟加粗星号」的 `/**` 被当成 **块注释起始** ⇒ 从那里到文件尾**全被掩成空白**
 * （实测，见 task-11-fix-report.md 的本轮新发现）。拿它做「不许出现非事务语句」的判据会**恒绿**
 * ——那是空转的断言，比没有断言更坏。
 */
function provisionCode(): string {
  return provisionRaw().split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n')
}

/** macro 的「空 tenant var ⇒ 回内置行为」分支原文（掩注释后；取不到 = 那条分支不在）。 */
function macroEmptyKeyBranch(): string | null {
  const m = /\{%-?\s*if\s+tenant\s*==\s*''\s*-?%\}\s*([\s\S]*?)\{%-?\s*else\s*-?%\}/.exec(macroCode())
  return m?.[1] ?? null
}

describe('T11 修复笔 I1：派生撞名（不同租户归一到同一 schema）必须显式报出，不许 clean', () => {
  it('两个不同 org 归一到同一 schema ⇒ 撞名组逐条列出，且 clean=false（评审 RR4 实测的那一组）', async () => {
    const { diffTenants } = await reconcileCore()
    const d = diffTenants(
      [{ org: 'acme-org', key: 'acme-org' }, { org: 'Acme-Org', key: 'Acme-Org' }],
      ['tenant_acme_org'],
      ['tenant_acme_org'],
    )
    // 修复前的形态正是「两个差集都空 ⇒ clean:true / exit 0」—— 静默串租户
    expect(d.missingInData).toEqual([])
    expect(d.missingInPlatform).toEqual([])
    expect(d.unattributable).toEqual([])
    expect(d.collisions).toEqual([
      { schema: 'tenant_acme_org', orgs: ['Acme-Org', 'acme-org'], keys: ['Acme-Org', 'acme-org'] },
    ])
    expect(d.clean, '撞名必须让 clean 为假 —— 否则对账看不出串租户').toBe(false)
  })

  it('单一 org（哪怕大小写混合）不是撞名 ⇒ 仍 clean（不许把正常形态判成撞名）', async () => {
    const { diffTenants } = await reconcileCore()
    const d = diffTenants([{ org: 'Acme-Org', key: 'Acme-Org' }], ['tenant_acme_org'], ['tenant_acme_org'])
    expect(d.collisions).toEqual([])
    expect(d.clean).toBe(true)
  })

  it('多组撞名：按 schema 名排序、组内稳定排序（对账输出可 diff，不随插入顺序抖）', async () => {
    const { diffTenants } = await reconcileCore()
    const d = diffTenants(
      [
        { org: 'acme-org', key: 'acme-org' },
        { org: '_', key: '_' },
        { org: 'Acme-Org', key: 'Acme-Org' },
        { org: '-', key: '-' },
      ],
      [],
      [],
    )
    // 语料里的两个撞名组（评审 RR4 逐例复核过）：tenant_acme_org 与 tenant__
    expect(d.collisions.map((c) => c.schema)).toEqual(['tenant__', 'tenant_acme_org'])
    expect(d.collisions[0]?.orgs).toEqual(['-', '_'])
  })
})

describe('T11 修复笔：空键 —— macro 与脚本的**已知分歧**，共享用例表原未覆盖，现钉住', () => {
  it('脚本侧空键**抛**（fail-closed）；macro 侧空 var 走「回内置行为」分支且**不 raise**（两者各自正确）', async () => {
    const { tenantSchemaName } = await reconcileCore()
    expect(() => tenantSchemaName(''), '脚本侧：空键会拼出 `tenant_`（所有租户共用名的形态）⇒ 必须抛').toThrow()
    const branch = macroEmptyKeyBranch()
    expect(branch, 'macro 必须有「空 tenant var ⇒ 回内置行为」这条分支').not.toBeNull()
    expect(branch).toContain('generate_schema_name_for_env')
    expect(
      branch,
      '空键分支里不许有 raise：macro 刻意回内置行为（P1 单租户零变化），脚本刻意抛 —— 分歧在此被 fixture 记录',
    ).not.toContain('raise_compiler_error')
  })
})

describe('T11 修复笔 I2-a / M8：模板事务化（失败 ⇒ 无残留）与 macro-paths 显式声明', () => {
  it('provision 模板：恰好一个 BEGIN、一个 COMMIT，且 BEGIN 在第一个落库语句之前', () => {
    const code = provisionCode()
    expect(code.match(/^\s*begin;\s*$/gim) ?? [], '恰好一个 BEGIN（整份模板单事务）').toHaveLength(1)
    expect(code.match(/^\s*commit;\s*$/gim) ?? [], '恰好一个 COMMIT').toHaveLength(1)
    const beginAt = code.search(/^\s*begin;\s*$/im)
    const firstWrite = code.search(/^\s*(create|alter|drop|grant|revoke)\b/im)
    expect(firstWrite, '模板里当然有落库语句（没有的话这条断言是空转）').toBeGreaterThan(-1)
    expect(beginAt, 'BEGIN 必须在第一句落库语句之前 —— 否则失败的那一段不被事务覆盖').toBeLessThan(firstWrite)
  })

  it('provision 模板：COMMIT 之后不许再有落库语句（否则那一段挂在事务外、失败就留残留）', () => {
    const code = provisionCode()
    const commitAt = code.search(/^\s*commit;\s*$/im)
    expect(code.slice(commitAt)).not.toMatch(/^\s*(create|alter|drop|grant|revoke)\b/im)
  })

  it('provision 模板：不含非事务语句（包进事务会直接报错，不许为了事务化把语法改错）', () => {
    const code = provisionCode().toLowerCase()
    for (const bad of ['concurrently', 'vacuum', 'create database', 'create tablespace', 'alter system', 'reindex']) {
      expect(code, `非事务语句 \`${bad}\` 不许出现在模板的**代码位**里（注释里点名允许）`).not.toContain(bad)
    }
    // 反面对照：同一条判据对合成源里的真 `vacuum;` 必须判红 —— 否则上面那圈是空转
    const synthetic = '-- 注释里提一句 vacuum 是允许的\nvacuum;\n'
    expect(synthetic.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n').toLowerCase()).toContain('vacuum')
  })

  it('dbt_project.yml 显式声明 macro-paths（缺省的 ["macros"] 一旦被收紧 ⇒ macro 静默变死代码而结构断言仍绿）', () => {
    const project = readFileSyncT11(join(repoRoot, 'dbt/dbt_project.yml'), 'utf8')
    expect(project).toMatch(/^\s*macro-paths:\s*\['macros'\]\s*$/m)
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════
// T9（P2 / W2 收尾）追加：门禁③扩面两类
//   (a) **L2 声明静态面**：`modules/data/domain/semantic-compiler.ts` 里的 zod schema
//       （写时校验）与唯一编译点的校验必须**同源** —— 防两处漂移。
//       ⚠️ **本格的覆盖强度如实披露（T9 评审 I-1）**：下面这 10 例断的是**标记级文本比对**
//       （改字面量 / 改键名 ⇒ 红），**不是行为断言** —— 「编译器行为变了而标记没变」的改动
//       （守卫体掏空、`filters` 被静默丢弃）在**本格**是绿的，那两例由
//       `modules/data/domain/semantic-compiler.test.ts`（CI `unit` job）抓。计划 L896 原本要的
//       行为 fixtures（「schema 拒的编译器也拒」）属**后续加固**，见门禁头注「⑧ 的**强度**」。
//   (b) **消费 `sync-data-semantics.mjs --check`**：把「L1 物化的 dry-run 契约」接进机检面。
//
// **为什么追加在本文件**：任务书硬约束 1 把 T9 的落点钉成这三个文件，且 T11 先例已把
// 「对账纯核 fixtures 与门禁 fixtures 同址」定成取舍（见上面 T11 段头注）⇒ 同址沿用。
//
// **本段不重排、不改写、不删上面任何既有用例**（T4 的六格与 CLI 契约、T11 的 16 例 fixtures
// 都是现状）。同上 T11 的先例：新增 import 写在本段内、并起别名，把「模块缺席」的爆炸半径
// 限制在本段 —— 否则本文件整体加载失败，上面那批既有用例会跟着一起红，看不清红的是谁。
// ════════════════════════════════════════════════════════════════════════════════════════

import { readFileSync as readFileSyncT9 } from 'node:fs'
import {
  L2_DECLARATION_REL,
  checkL2DeclarationSameSource,
  checkSyncCheckContract,
  checkDataModels as checkDataModelsT9,
} from './check-data-models.mjs'

/** 规则 ⑧ 的扫描面（相对 rootDir）—— **import 门禁导出的常量**，不在这里再写一份路径。 */
const L2_COMPILER_REL = L2_DECLARATION_REL

/** 真文件的逐字副本（读自真仓）。 */
function l2RealSource(): string {
  return readFileSyncT9(join(repoRoot, L2_COMPILER_REL), 'utf8')
}

describe('T9 格⑧：L2 声明的 zod schema 与编译点校验**同源**（纯核 / **标记级**，可喂合成源）', () => {
  it('真文件 → 零违规（反空转：基线真合规，门禁在真仓上不得因此变红）', () => {
    expect(checkL2DeclarationSameSource(l2RealSource())).toEqual([])
  })

  it('⑧-b（T8 回归点）：只放宽 schema 的 op.kind，编译器仍只认 refine ⇒ 必须红', () => {
    const v = checkL2DeclarationSameSource(
      l2RealSource().replace("kind: z.literal('refine')", "kind: z.literal('aggregate')"),
    )
    expect(v.length, 'schema 说收 aggregate、编译器只认 refine —— 这正是「两处漂移」').toBeGreaterThan(0)
    expect(v.map((x) => x.message).join('\n')).toContain('op.kind')
  })

  it('⑧-b：只放宽 schema 的过滤算子（多收 like），编译器只认 = / in ⇒ 必须红', () => {
    const v = checkL2DeclarationSameSource(
      l2RealSource().replace("z.enum(['=', 'in'])", "z.enum(['=', 'in', 'like'])"),
    )
    expect(v.length).toBeGreaterThan(0)
    expect(v.map((x) => x.message).join('\n')).toContain('过滤算子')
  })

  it('⑧-a：写时校验不再从唯一编译点导出（schema 搬家 ⇒ 两处漂移面）⇒ 必须红', () => {
    const v = checkL2DeclarationSameSource(
      l2RealSource().replace('export const L2DeclarationSchema', 'const L2DeclarationSchema'),
    )
    expect(v.map((x) => x.message).join('\n')).toContain('L2DeclarationSchema')
  })

  it('⑧-c：schema 收到一个接口里没有的字段（编译器永不读 ⇒ 静默丢弃）⇒ 必须红', () => {
    const v = checkL2DeclarationSameSource(
      l2RealSource().replace(
        '  target: z.number().optional(),',
        '  target: z.number().optional(),\n  expression: z.string().optional(),',
      ),
    )
    expect(v.map((x) => x.message).join('\n')).toContain('expression')
  })

  it('⑧-c 反向：接口里有、schema 里没有的字段 ⇒ 必须红（该声明永远写不进来）', () => {
    const v = checkL2DeclarationSameSource(
      l2RealSource().replace('  target?: number', '  target?: number\n  expression?: string'),
    )
    expect(v.map((x) => x.message).join('\n')).toContain('expression')
  })

  it('反面对照：合成源里「两侧逐字一致」必须**不**红（否则上面几条只是恒红，等于没在守）', () => {
    // 用**真名字**：判据是按 `L2Declaration*` / `compileL2` 定位的（把名字参数化会凭空多一层
    // 没有生产用的 API 面）。契约面则按同一套词表写全 —— schema 与编译器说同一套话。
    //
    // 合成源必须长这样（改任何一个字符前先读这四条）：
    //  ① refine 的 schema 块必须在 `ExprNodeSchema` **之前** —— 否则 `z.literal('refine')`
    //     会混进 ⑧-d 的节点集窗口；
    //  ② `filterSql` 的参数**必须**叫 `f`：编译面正则 `\bf\.op` 不匹配 `f2.op`（`2` 与 `f`
    //     之间没有词边界）⇒ 取不到算子集 ⇒ 红（真文件里用的就是 `f`）；
    //  ③ `opKind` 这个名字不能换：⑧-b 的编译面正则就是 `\bopKind\s*===`；
    //  ④ `renderExprNode` 的 6 个 `case` **一个都不能少**；`case 'add': case 'sub': case 'mul':`
    //     写成三个标签是**对的**（每个标签各算一个）。
    const synthetic = [
      'export interface L2RefineDeclaration {',
      '  baseMetric: string',
      "  op: { kind: 'refine' }",
      "  filters?: { dim: string; op: '=' | 'in'; values: string[] }[]",
      '}',
      'export interface L2ExprDeclaration {',
      "  op: { kind: 'expr'; expr: ExprNode }",
      "  filters?: { dim: string; op: '=' | 'in'; values: string[] }[]",
      '}',
      'export const L2RefineDeclarationSchema = z.object({',
      '  baseMetric: z.string().min(1).max(128),',
      "  op: z.object({ kind: z.literal('refine') }),",
      '  filters: z.array(z.object({',
      "    op: z.enum(['=', 'in']),",
      '  })),',
      '})',
      'export const ExprNodeSchema = z.lazy(() => z.union([',
      "  z.object({ kind: z.literal('ref'), id: z.string() }),",
      "  z.object({ kind: z.literal('num'), value: z.number() }),",
      "  z.object({ kind: z.enum(['add', 'sub', 'mul', 'div']), left: ExprNodeSchema, right: ExprNodeSchema }),",
      ']))',
      'export const L2ExprDeclarationSchema = z.object({',
      "  op: z.object({ kind: z.literal('expr'), expr: ExprNodeSchema }).strict(),",
      '  filters: z.array(z.object({',
      "    op: z.enum(['=', 'in']),",
      '  })),',
      '}).strict()',
      'export const L2DeclarationSchema = z.union([L2RefineDeclarationSchema, L2ExprDeclarationSchema])',
      'export function compileL2(d: L2Declaration, l1: readonly MetricRow[]) {',
      "  const opKind = (d as { op?: { kind?: unknown } }).op?.kind",
      "  if (opKind === 'refine') return compileRefine(l1, d)",
      "  if (opKind === 'expr') return compileExpr(l1, d)",
      "  throw new Error('x')",
      '}',
      'function renderExprNode(node: ExprNode, refExpr: ReadonlyMap<string, string>): string {',
      '  switch (node.kind) {',
      '    case \'num\': return String(node.value)',
      '    case \'ref\': return refExpr.get(node.id) ?? \'\'',
      '    case \'add\':',
      '    case \'sub\':',
      '    case \'mul\':',
      '      return \'x\'',
      '    case \'div\':',
      '      return \'y\'',
      '    default: throw new Error(\'z\')',
      '  }',
      '}',
      'function filterSql(f) {',
      "  if (f.op !== '=' && f.op !== 'in') throw new Error('y')",
      '}',
    ].join('\n')

    expect(checkL2DeclarationSameSource(synthetic)).toEqual([])
  })

  it('⑧-a union 少一支 ⇒ 报成员集不符（消息含 L2DeclarationSchema）', () => {
    const src = l2RealSource()
    const broken = src.replace(
      'z.union([L2RefineDeclarationSchema, L2ExprDeclarationSchema])',
      'z.union([L2RefineDeclarationSchema])',
    )
    const v = checkL2DeclarationSameSource(broken)
    expect(v.length).toBeGreaterThan(0)
    expect(v.some((x) => x.message.includes('L2DeclarationSchema'))).toBe(true)
  })

  it('⑧-c expr 支多一个 schema 键 ⇒ 报字段面不等（消息含该键名）', () => {
    const src = l2RealSource()
    const broken = src.replace(
      "  op: z.object({ kind: z.literal('expr'), expr: ExprNodeSchema }).strict(),",
      "  op: z.object({ kind: z.literal('expr'), expr: ExprNodeSchema }).strict(),\n  remark: z.string().optional(),",
    )
    const v = checkL2DeclarationSameSource(broken)
    expect(v.length).toBeGreaterThan(0)
    expect(v.some((x) => x.message.includes('remark'))).toBe(true)
  })

  it('⑧-d 节点集漂移（renderExprNode 少认一个 kind）⇒ 报节点集（消息含 节点集）', () => {
    const src = l2RealSource()
    const broken = src.replace("case 'div':", "case 'divide':")
    const v = checkL2DeclarationSameSource(broken)
    expect(v.length).toBeGreaterThan(0)
    expect(v.some((x) => x.message.includes('节点集'))).toBe(true)
  })
})

describe('T9 格⑨：消费 sync-data-semantics.mjs 的 --check 契约（门禁③的 L1 侧）', () => {
  /** 真契约：**动态 import**（模块缺席只红本段；且不拖 pg —— metric-store 只有 type import）。 */
  async function realContract(): Promise<Record<string, unknown>> {
    return await import('./sync-data-semantics.mjs')
  }

  it('真契约四条性质都在：--check 存在 / 未知 flag 响亮 / 漂移非 0 / 无漂移 0', async () => {
    const c = await realContract()
    expect(checkSyncCheckContract(c)).toEqual([])
    // 逐条直证（与门禁的断言面同源，避免「门禁绿但性质其实不在」）
    const parseArgs = c.parseArgs as (a: string[]) => { mode: string; unknown: string[] }
    const usageError = c.usageError as (a: unknown) => string | null
    const exitCodeFor = c.exitCodeFor as (m: string, d: unknown) => number
    expect(parseArgs(['--check']).mode).toBe(c.MODE_CHECK)
    expect(usageError(parseArgs(['--chekc'])), '未知 flag 被静默忽略 ⇒ 打了 --check 会真写库（T8 的原始缺陷）').not.toBeNull()
    const drift = { added: ['x'], updated: [], removed: [], unchanged: [] }
    const clean = { added: [], updated: [], removed: [], unchanged: [] }
    expect(exitCodeFor(c.MODE_CHECK as string, drift)).not.toBe(0)
    expect(exitCodeFor(c.MODE_CHECK as string, clean)).toBe(0)
  })

  it('反面对照：把「未知 flag 静默忽略」的契约喂进去 ⇒ 必须红（T8 那个会写库的形态）', async () => {
    const c = await realContract()
    // 变异要**外科级**：只把「未识别项」丢掉（= T8 第一版只认 `argv.includes('--dry-run')` 的形态），
    // 保留真实的 usageError。这样只有 ⑨-b 的**未知 flag** 那一条会红，互斥那条仍该绿 ——
    // 若把 usageError 整个换成 `() => null`，两条都会红，反而看不清红的是哪个触发路径。
    const silentUnknown = {
      ...c,
      parseArgs: (a: string[]) => ({ ...(c.parseArgs as (x: string[]) => object)(a), unknown: [] }),
    }
    const v = checkSyncCheckContract(silentUnknown)
    expect(v).toHaveLength(1)
    expect(v[0]?.message).toContain('未知')
  })

  it('反面对照：--check 退化成正数/恒 0 的出口码 ⇒ 必须红（门禁会读错）', async () => {
    const c = await realContract()
    const broken = { ...c, exitCodeFor: () => 0 }
    expect(checkSyncCheckContract(broken).length).toBeGreaterThan(0)
  })

  it('反面对照：用法错与漂移共用一个出口码 ⇒ 必须红（消费方分不清「打错字」和「真漂移」）', async () => {
    const c = await realContract()
    const collapsed = { ...c, EXIT_USAGE: c.EXIT_DRIFT }
    expect(checkSyncCheckContract(collapsed).length).toBeGreaterThan(0)
    expect(checkSyncCheckContract(collapsed).map((x) => x.message).join('\n')).toContain('出口码')
  })
})

describe('T9 端到端：门禁在**含真模块文件**的 rootDir 上跑（规则 ⑧ 走文件面）', () => {
  it('真文件副本 + 无 dbt/ ⇒ 零违规（⑧ 在文件面上同样不空转也不误伤）', () => {
    const root = fixture({ [L2_COMPILER_REL]: l2RealSource() })
    expect(checkDataModelsT9(root)).toEqual([])
  })

  it('真文件副本 + 单点放宽 op.kind ⇒ 经 checkDataModels 必须红，且违规落在 L2 文件上', () => {
    const root = fixture({
      [L2_COMPILER_REL]: l2RealSource().replace("kind: z.literal('refine')", "kind: z.literal('aggregate')"),
    })
    const v = checkDataModelsT9(root)
    expect(v.length).toBeGreaterThan(0)
    expect(v.every((x) => x.file === L2_COMPILER_REL)).toBe(true)
    expect(v.map((x) => x.message).join('\n')).toContain('op.kind')
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════
// 规则 ⑤ 的 ratio 形状核（spec 2026-10-12 §5.3，W0 Task 2 追加）——纯函数直测，
// 不进上面的 fixture 体系：它判的是**单条声明**的形状，不需要临时 dbt 目录。
// 契约：率类声明走 `ratio: {numerator, denominator}`，与 expression 互斥；分子分母各含
// ≥1 个「关系.列」引用且必须同关系（单 FROM 约束的声明面）；不许带分号。
// ════════════════════════════════════════════════════════════════════════════════════════
describe('规则 ⑤ ratio 形状（ratioShapeError 纯核，spec 2026-10-12 §5.3）', () => {
  const base = {
    name: 'lemeng:retail:test_rate',
    definition: 'x',
    grain: ['a'],
    owner: 'o',
    tier: 'experimental',
    source: 'lemeng',
  }

  it('ratio 与 expression 互斥（两处各写一份口径 = 口径分叉）', () => {
    expect(ratioShapeError({
      ...base, expression: 'sum(f.x)',
      ratio: { numerator: 'sum(f.x)', denominator: 'sum(f.y)' },
    })).toMatch(/互斥/)
  })

  it('缺分子或分母 → 报缺的那一项', () => {
    expect(ratioShapeError({ ...base, ratio: { numerator: 'sum(f.x)' } })).toMatch(/denominator|分母/)
    expect(ratioShapeError({ ...base, ratio: { denominator: 'sum(f.y)' } })).toMatch(/numerator|分子/)
  })

  it('分子分母必须各含「关系.列」且同关系（单 FROM）', () => {
    expect(ratioShapeError({ ...base, ratio: { numerator: 'sum(x)', denominator: 'sum(f.y)' } }))
      .toMatch(/关系/)
    expect(ratioShapeError({
      ...base, ratio: { numerator: 'sum(a.x)', denominator: 'sum(b.y)' },
    })).toMatch(/多个关系|同关系/)
  })

  it('含分号 → 报错（声明只写聚合表达式）', () => {
    expect(ratioShapeError({
      ...base, ratio: { numerator: 'sum(f.x);', denominator: 'sum(f.y)' },
    })).toMatch(/分号/)
  })

  it('合法 ratio → null；纯 expression 声明 → null', () => {
    expect(ratioShapeError({ ...base, ratio: { numerator: 'sum(f.x)', denominator: 'sum(f.y)' } })).toBeNull()
    expect(ratioShapeError({ ...base, expression: 'sum(f.x)' })).toBeNull()
  })

  it('两者都不给 → 报错（必填缺口在 ratio 路径下的兜底）', () => {
    expect(ratioShapeError({ ...base })).toMatch(/expression|ratio/)
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════
// 规则 ⑤ 的 freshness_sla_days 形状核（spec §10.7.1，新鲜度 SLA 登记）——纯函数直测，
// 同 ratioShapeError 的姿势：判的是**单条声明**的形状，不需要临时 dbt 目录。
// 契约：必填（缺 = ⑤ 报）+ 非负整数（它是服务端 freshness_status 转译的算术判据，
// 小数/负数/字符串落库 = 状态判错且不报错）。
// ════════════════════════════════════════════════════════════════════════════════════════
describe('规则 ⑤ freshness_sla_days 形状（freshnessSlaError 纯核，spec §10.7.1）', () => {
  const base = { name: 'lemeng:retail:net_sales' }

  it('非负整数 ⇒ null（0 是合法的「当日」承诺；2 = inventory 的实测登记）', () => {
    expect(freshnessSlaError({ ...base, freshness_sla_days: 1 })).toBeNull()
    expect(freshnessSlaError({ ...base, freshness_sla_days: 2 })).toBeNull()
    expect(freshnessSlaError({ ...base, freshness_sla_days: 0 })).toBeNull()
  })

  it('小数 / 负数 / 字符串 ⇒ 报错（算术判据不吃垃圾值）', () => {
    for (const bad of [1.5, -1, '2', true, null]) {
      expect(freshnessSlaError({ ...base, freshness_sla_days: bad }), `${JSON.stringify(bad)} 没被拦`)
        .toMatch(/freshness_sla_days/)
    }
  })

  it('格⑤附带（门禁面）：缺 freshness_sla_days ⇒ 违规点名该字段；坏形状 ⇒ ⑤-c 单独报', () => {
    // 缺字段：⑤ 必填面报（不与 ⑤-c 重复——「没给值」不进形状核）
    const missing = variant((f) => {
      f[METRICS] = f[METRICS].replace('    freshness_sla_days: 1\n', '')
    })
    const mv = checkDataModels(missing)
    expect(mv).toHaveLength(1)
    expect(mv[0]?.message).toContain('freshness_sla_days')

    // 给了但形态不对：⑤-c 报（⑤ 不再重复）
    const badShape = variant((f) => {
      f[METRICS] = f[METRICS].replace('    freshness_sla_days: 1', '    freshness_sla_days: 1.5')
    })
    const bv = checkDataModels(badShape)
    expect(bv).toHaveLength(1)
    expect(bv[0]?.message).toContain('非负整数')
  })
})

describe('格⑪：列级授权声明面（required_scope / reads，spec 2026-10-17 §4.2/§4.3）', () => {
  /** 在 freshness_sla_days 之后插一行（基线指标其余字段不动）。 */
  const withLine = (line: string) =>
    variant((f) => {
      f[METRICS] = f[METRICS].replace('    freshness_sla_days: 1\n', `    freshness_sla_days: 1\n${line}\n`)
    })

  it('未声明 ⇒ 干净（缺省 = 不限制，与 2026-10-17 之前的行为一致）', () => {
    expect(checkDataModels(variant(() => {}))).toEqual([])
  })

  it('合法的 required_scope / reads ⇒ 干净', () => {
    expect(
      checkDataModels(withLine('    required_scope: data:cost\n    reads: ["lemeng.item.item_cost_price"]')),
    ).toEqual([])
  })

  it('拼错的键名 ⇒ 违规并点名允许的键（拼错会被静默忽略 = 该指标永远不受限制）', () => {
    const v = checkDataModels(withLine('    required_scpoe: data:cost'))
    expect(v).toHaveLength(1)
    expect(v[0]?.message).toContain('未知字段')
    expect(v[0]?.message).toContain('required_scpoe')
  })

  it('required_scope 空串 / 首尾带空白 ⇒ 违规（权限码是逐字比对，带空白谁也匹配不上）', () => {
    for (const bad of ['""', '" data:cost"', '"data:cost "', '"   "']) {
      const v = checkDataModels(withLine(`    required_scope: ${bad}`))
      expect(v, `required_scope: ${bad} 没被拦`).toHaveLength(1)
      expect(v[0]?.message).toContain('required_scope')
    }
  })

  it('reads 写成字符串 / 空数组 ⇒ 违规（它是血缘门的输入，写错会让门误判「没读这一列」）', () => {
    for (const bad of ['lemeng.item.item_cost_price', '[]']) {
      const v = checkDataModels(withLine(`    reads: ${bad}`))
      expect(v, `reads: ${bad} 没被拦`).toHaveLength(1)
      expect(v[0]?.message).toContain('reads')
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════
// 规则 ⑤-d：值级脱敏声明面（mask，spec 2026-10-17 §5.2）。fixture 驱动（走完整门禁管线）；
// 逐项判据的唯一实现在 sync 的 maskItemError（门禁 import 它），这里钉的是「门禁真的报」。
// ⚠️ 「column 须逐字出现在 selectSql 里」**不**在本门禁的判据面（门禁手里没有物化后的
//    selectSql）——那半归 sync 的 masksOf，单测与变异确认在 sync-data-semantics.test.ts。
// ════════════════════════════════════════════════════════════════════════════════════════
describe('规则 ⑤-d：mask 形状（值级脱敏声明面，spec 2026-10-17 §5.2）', () => {
  /** 在 freshness_sla_days 之后插一行（基线指标其余字段不动）。 */
  const withMask = (line: string) =>
    variant((f) => {
      f[METRICS] = f[METRICS].replace('    freshness_sla_days: 1\n', `    freshness_sla_days: 1\n${line}\n`)
    })

  it('未声明 ⇒ 干净（缺省 = 无掩码；当前仓内 36 条声明也都没有 mask）', () => {
    expect(checkDataModels(variant(() => {}))).toEqual([])
  })

  it('合法 mask（round 带步长）⇒ 干净', () => {
    expect(checkDataModels(withMask(
      '    mask: [{ column: "fct_retail_sale.net_amount", kind: "round", step: 1000, grantedBy: "data:precise" }]',
    ))).toEqual([])
  })

  it('★ 手写整值声明（column: null / column 键缺省）⇒ 违规（手写整值一律拒；#830）', () => {
    // 本任务之前这里断言的是「整值 nullify 合法」——那是旧世界（YAML 写得出手写整值）；
    // 现在整值形态只由默认档合成，手写它一律拒。唯一实现 = sync 的 maskItemError（本门禁 import 它）。
    for (const line of [
      '    mask: [{ column: null, kind: "nullify", grantedBy: "data:precise" }]',
      '    mask: [{ kind: "nullify", grantedBy: "data:precise" }]',   // column 缺省 = null（整值）
    ]) {
      const v = checkDataModels(withMask(line))
      expect(v, `mask 行 ${line} 没被拦`).toHaveLength(1)
      expect(v[0]?.message).toContain('整值')
    }
  })

  it('★ mask 写成非数组 ⇒ 违规（变异确认锚点：去掉门禁这条形状核 ⇒ 本用例必须红）', () => {
    const v = checkDataModels(withMask('    mask: "round"'))
    expect(v).toHaveLength(1)
    expect(v[0]?.message).toContain('mask')
  })

  it('未知 kind / 整值配 round / grantedBy 带空白 ⇒ 违规（逐项判据经 maskItemError 唯一实现）', () => {
    for (const line of [
      '    mask: [{ column: "fct_retail_sale.net_amount", kind: "bucket", grantedBy: "data:precise" }]',
      '    mask: [{ column: null, kind: "round", step: 1000, grantedBy: "data:precise" }]',
      '    mask: [{ column: "fct_retail_sale.net_amount", kind: "nullify", grantedBy: "data precise" }]',
      '    mask: [{ column: "fct_retail_sale.net_amount", kind: "round", grantedBy: "data:precise" }]',
    ]) {
      const v = checkDataModels(withMask(line))
      expect(v, `mask 行 ${line} 没被拦`).toHaveLength(1)
      expect(v[0]?.message).toContain('mask')
    }
  })

  it('多条 mask 逐项各报一条（坏项不连累好项的判定）', () => {
    const v = checkDataModels(withMask(
      '    mask: [{ column: "fct_retail_sale.net_amount", kind: "nullify", grantedBy: "data:precise" }, { column: "fct_retail_sale.net_amount", kind: "nope", grantedBy: "data:precise" }]',
    ))
    expect(v).toHaveLength(1)
    expect(v[0]?.message).toContain('kind')
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════
// 规则 ⑪：域覆盖（fail-closed）—— docs/architecture.md §2.5 / dbt/dbt_project.yml 注释
//
// 为什么每一格都要断言「红了」且「点到名」：这条规则要防的两个方向**都只有静默这一种症状**——
//   · 域目录在、登记缺 ⇒ dbt 默认 `enabled: true` ⇒ 该域**每个数据面都会 build 它**（本方侧把
//     对方租户的数据物化进本方仓库并标成本方 org = 反向泄漏）；
//   · 登记在、表达式错（漏域名 / 指向别的 env 键）⇒ 该域**永不 build**，dbt 一声不响。
// 与 #677/#679「解析数涨、执行集不变、run 照绿」同形，故它值得一格一条。
// ⚠️ 强度同规则 ⑧：**标记级**文本比对（目录名 / YAML 键名 / `+enabled` 字符串里的字面量），不跑 dbt。
// ════════════════════════════════════════════════════════════════════════════════════════
describe('规则 ⑪：域覆盖（models/<域>/ ↔ dbt_project.yml 的 +enabled）', () => {
  const PROJECT = 'dbt/dbt_project.yml'
  /** 基线 fixture 里的域目录名（`compliant()` 用的是 `common/`） */
  const DOMAIN = 'common'
  const enabled = (d: string, key = 'DATA_PLANE_DOMAINS') =>
    `      +enabled: "{{ '${d}' in env_var('${key}').split(',') }}"`
  const project = (...entries: string[]) => [
    "name: 'platform_data'",
    'version: 1.0.0',
    'profile: platform_data',
    'models:',
    '  platform_data:',
    '    +materialized: table',
    ...entries,
    '',
  ].join('\n')

  it('格⑪-1 基线：域目录已登记且 +enabled 形态正确 ⇒ 不误伤（违规数 0）', () => {
    const root = variant((f) => { f[PROJECT] = project(`    ${DOMAIN}:`, enabled(DOMAIN)) })
    expect(checkDataModels(root)).toHaveLength(0)
  })

  it('格⑪-2 域目录**未登记** ⇒ 违规（点名该域；未登记 = dbt 默认启用 = 每个面都 build）', () => {
    const root = variant((f) => { f[PROJECT] = project() })
    const v = checkDataModels(root)
    expect(v).toHaveLength(1)
    expect(v[0]?.file).toBe(PROJECT)
    expect(v[0]?.message).toContain(`models/${DOMAIN}/`)
    expect(v[0]?.message).toContain('每个数据面都会 build')
  })

  it('格⑪-3 登记了但**没有 +enabled** ⇒ 违规（效果同未登记）', () => {
    const root = variant((f) => { f[PROJECT] = project(`    ${DOMAIN}:`) })
    const v = checkDataModels(root)
    expect(v).toHaveLength(1)
    expect(v[0]?.message).toContain('+enabled')
  })

  it('格⑪-4 +enabled 指向**别的 env 键** ⇒ 违规（域身份与部署身份脱钩）', () => {
    const root = variant((f) => { f[PROJECT] = project(`    ${DOMAIN}:`, enabled(DOMAIN, 'SOME_OTHER_KEY')) })
    const v = checkDataModels(root)
    expect(v).toHaveLength(1)
    expect(v[0]?.message).toContain('DATA_PLANE_DOMAINS')
  })

  it('格⑪-5 +enabled 里**域名写错**（复制粘贴别域的那一行）⇒ 违规（该域永不 build）', () => {
    const root = variant((f) => { f[PROJECT] = project(`    ${DOMAIN}:`, enabled('lemeng')) })
    const v = checkDataModels(root)
    expect(v).toHaveLength(1)
    expect(v[0]?.message).toContain(`'${DOMAIN}'`)
  })

  it('格⑪-6 登记了域但**目录不存在** ⇒ 违规（死配置）', () => {
    const root = variant((f) => {
      f[PROJECT] = project(`    ${DOMAIN}:`, enabled(DOMAIN), '    ghost:', enabled('ghost'))
    })
    const v = checkDataModels(root)
    expect(v).toHaveLength(1)
    expect(v[0]?.message).toContain('ghost')
    expect(v[0]?.message).toContain('死配置')
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════
// 下钻三键（compose/dimensions/detail）与顶层 measures:（spec 2026-10-21 §2.3/§2.3.1，#977）
//
// 契约：三键**同现或同缺**——半套声明 = 消费面 NO_DETAIL_BINDING 与声明意图相左（静默面）；
// compose 是组件组合式，引用闭集 = **同文件**顶层 `measures:`（`{ '组件名@粒度': { expr, additivity, ... } }`，对象形态）；
// detail.relation 只认 `vw_*`（Phase 1 下钻读直读湖视图，spec §2.2）且
// `dbt/models/**/views/<relation>.sql` 必须在仓；detail.filter 非空、不含分号。
// 夹具照本文件既有 temp-repo helper（compliant / variant / fixture）构造：先有一份
// 「三键 + measures + 视图」全就位的零违规夹具，再逐格做单点变异。
// ════════════════════════════════════════════════════════════════════════════════════════

/** 下钻读面视图（`detail.relation` 指向的在仓骨架；规则 ⑩ 的扫描面 ⇒ 必须带 `as org`）。 */
const DRILL_VIEW = 'dbt/models/common/views/vw_t.sql'

/**
 * 「三键齐全 + measures 就位 + 视图在仓」的**唯一零违规**下钻夹具。
 * ⚠️ 视图骨架必须真合规（带 `as org`）：否则「零违规」那格的红分不清来自下钻面还是规则 ⑩
 * （同头注对基线 compliant() 的要求）。
 */
function drillCompliant(): Record<string, string> {
  const files = compliant()
  files[METRICS] = [
    // 具名行域（P3.0 Task 3）：组件 `domain` 必须在本块里登记；下钻面的 filter 由组件域 LUB 派生。
    'domains:',
    '  finished: { filter: "state = \'FINISHED\'" }',
    '  sale_finished: { extends: finished, filter: "order_transaction_type = \'SALE_ORDER\'" }',
    '  return_finished: { extends: finished, filter: "order_transaction_type like \'%RETURN%\'\'" }',
    'measures:',
    '  "sale_amount@order": { expr: "sum(fct_retail_sale.net_amount)", additivity: flow, domain: sale_finished }',
    '  "return_amount@line": { expr: "sum(fct_retail_sale.return_amount)", additivity: flow, domain: return_finished }',
    'metrics:',
    '  - name: "lemeng:retail:net_sales"',
    '    expression: "sum(fct_retail_sale.net_amount)"',
    '    grain: [system_book, bizday]',
    '    owner: data-platform',
    '    tier: certified',
    '    source: lemeng',
    '    freshness_sla_days: 1',
    '    definition: 净销售额 = 有效零售订单成交金额合计',
    '    compose: "sale_amount@order - return_amount@line"',
    '    dimensions: [system_book, bizday]',
    `    detail: { relation: vw_t, filter: "state = 'FINISHED'" }`,
    '',
  ].join('\n')
  files[DRILL_VIEW] = [
    'select',
    "    'acme' as org,",
    '    system_book,',
    '    order_id',
    'from staging.stg_lemeng_retail_detail',
    '',
  ].join('\n')
  return files
}

/**
 * 同一夹具的**迁移后形态**（P3.0 Task 3）：`detail.filter` 缺席，由 compose 所引用组件域的 LUB 派生。
 * 两组件（sale_finished + return_finished）⇒ LUB `finished` ⇒ `state = 'FINISHED'`，与手写值逐字一致。
 */
function drillCompliantWithDomains(): Record<string, string> {
  const files = drillCompliant()
  files[METRICS] = files[METRICS].replace(
    `    detail: { relation: vw_t, filter: "state = 'FINISHED'" }`,
    '    detail: { relation: vw_t }',
  )
  return files
}

describe('下钻三键 + measures（spec 2026-10-21 §2.3/§2.3.1，#977）', () => {
  it('下钻三键：全给或全不给，半套声明拒绝', () => {
    const root = variant((f) => {
      f[METRICS] = f[METRICS].replace(
        '    freshness_sla_days: 1\n',
        '    freshness_sla_days: 1\n    compose: "sale_amount@order - return_amount@line"\n',
      ) // 只给 compose —— 缺 dimensions/detail
    })
    const vs = checkDataModels(root)
    expect(vs.some((v) => /compose.*dimensions.*detail|三键/.test(v.message))).toBe(true)
  })

  it('compose 引用未声明组件 ⇒ 拒', () => {
    // 三键齐全但同文件没有 measures: ⇒ 两个引用都未命中闭集
    const files = drillCompliant()
    files[METRICS] = files[METRICS].replace(
      'measures:\n'
      + '  "sale_amount@order": { expr: "sum(fct_retail_sale.net_amount)", additivity: flow, domain: sale_finished }\n'
      + '  "return_amount@line": { expr: "sum(fct_retail_sale.return_amount)", additivity: flow, domain: return_finished }\n',
      '',
    )
    const vs = checkDataModels(fixture(files))
    expect(vs.some((v) => /未声明的度量组件/.test(v.message))).toBe(true)
  })

  it('detail.relation 非 vw_* 或视图文件不存在 ⇒ 拒', () => {
    // 变异一：relation 不合 vw_* 形态（Phase 1 下钻只读直读湖视图，spec §2.2）
    const files1 = drillCompliant()
    files1[METRICS] = files1[METRICS].replace('relation: vw_t', 'relation: fct_retail_sale')
    const vs1 = checkDataModels(fixture(files1))
    expect(vs1.some((v) => /vw_|视图/.test(v.message))).toBe(true)

    // 变异二：形态合规但 dbt/models/**/views/ 下没有这个文件（下钻会查一个不存在的关系）
    const files2 = drillCompliant()
    files2[METRICS] = files2[METRICS].replace('relation: vw_t', 'relation: vw_ghost_detail')
    const vs2 = checkDataModels(fixture(files2))
    expect(vs2.some((v) => /vw_|视图|不存在/.test(v.message))).toBe(true)
  })

  it('measures 对象形态：缺 additivity / 字符串形态 / 未知键 ⇒ 拒', () => {
    const base = drillCompliant()
    const OBJ = '  "sale_amount@order": { expr: "sum(fct_retail_sale.net_amount)", additivity: flow, domain: sale_finished }'

    // 字符串形态（P3.0 起拒绝：表达不了 additivity）
    const bad1 = { ...base, [METRICS]: base[METRICS].replace(OBJ, '  "sale_amount@order": "sum(sale_money)"') }
    expect(checkDataModels(fixture(bad1)).some((v) => /对象形态|additivity/.test(v.message))).toBe(true)

    // 对象形态但缺 additivity
    const bad2 = { ...base, [METRICS]: base[METRICS].replace(OBJ, '  "sale_amount@order": { expr: "sum(sale_money)" }') }
    expect(checkDataModels(fixture(bad2)).some((v) => /additivity/.test(v.message))).toBe(true)

    // 未知键（拼错的键名会被静默忽略，必须在门禁期红）
    const bad3 = { ...base, [METRICS]: base[METRICS].replace(OBJ, '  "sale_amount@order": { expr: "sum(sale_money)", additivity: flow, bogus: 1 }') }
    expect(checkDataModels(fixture(bad3)).some((v) => /未知键/.test(v.message))).toBe(true)

    // 反面（防误伤）：合法对象形态 ⇒ 零违规
    const good = { ...base, [METRICS]: base[METRICS].replace(OBJ, '  "sale_amount@order": { expr: "sum(sale_money)", additivity: flow }') }
    expect(checkDataModels(fixture(good))).toEqual([])
  })

  it('measures 表达式含分号 ⇒ 拒', () => {
    // replace 只换第一处 = measures: 的那个值（metrics 的 expression 在其后，不被波及）
    const files = drillCompliant()
    files[METRICS] = files[METRICS].replace('"sum(fct_retail_sale.net_amount)"', '"sum(x); drop table t"')
    const vs = checkDataModels(fixture(files))
    expect(vs).toHaveLength(1)
    expect(vs[0]?.message).toContain('measures.')
    expect(vs[0]?.message).toMatch(/分号|;/)
  })

  it('三键齐全 + measures 就位 ⇒ 零违规', () => {
    expect(checkDataModels(fixture(drillCompliant()))).toEqual([])
  })

  it('detail.filter 缺席但可派生 ⇒ 零违规；domain 拼错 / 缺 domain ⇒ 拒（P3.0 Task 3）', () => {
    // 迁移后形态：没有 filter，两组件域 LUB = finished ⇒ 派生 `state = 'FINISHED'`
    expect(checkDataModels(fixture(drillCompliantWithDomains()))).toEqual([])

    // 行域名拼错 ⇒ 派生时「未知行域」+ 成员性不过
    const bad = drillCompliantWithDomains()
    bad[METRICS] = bad[METRICS].replace('domain: sale_finished', 'domain: sale_finishedd')
    expect(checkDataModels(fixture(bad)).some((v) => /domain|domains/.test(v.message))).toBe(true)

    // 组件缺 domain ⇒ 不许放宽成 true，派生失败即红
    const noDomain = drillCompliantWithDomains()
    noDomain[METRICS] = noDomain[METRICS].replace(', domain: sale_finished', '')
    expect(checkDataModels(fixture(noDomain)).some((v) => /缺 domain|派生/.test(v.message))).toBe(true)

    // extends 指向未登记的行域 ⇒ 派生链走到未知域时响亮失败
    const badParent = drillCompliantWithDomains()
    badParent[METRICS] = badParent[METRICS].replace('extends: finished', 'extends: finishedd')
    expect(checkDataModels(fixture(badParent)).some((v) => /未知行域|domains/.test(v.message))).toBe(true)
  })

  it('domains: 形状坏 ⇒ 门禁期就红（未知键 / 空谓词）', () => {
    const badKey = drillCompliant()
    badKey[METRICS] = badKey[METRICS].replace('{ extends: finished, filter:', '{ extnds: finished, filter:')
    expect(checkDataModels(fixture(badKey)).some((v) => /domains/.test(v.message))).toBe(true)

    const emptyFilter = drillCompliant()
    emptyFilter[METRICS] = emptyFilter[METRICS].replace(`"state = 'FINISHED'"`, '""')
    expect(checkDataModels(fixture(emptyFilter)).some((v) => /domains.*filter/.test(v.message))).toBe(true)
  })

  /** 把 flow 形态的 detail 换成带条件列的 block 形态（同一份零违规夹具的单点变异）。 */
  const withColumns = (yamlLines: string[]): Record<string, string> => {
    const files = drillCompliant()
    files[METRICS] = files[METRICS].replace(
      `    detail: { relation: vw_t, filter: "state = 'FINISHED'" }`,
      ['    detail:', '      relation: vw_t', `      filter: "state = 'FINISHED'"`, ...yamlLines].join('\n'),
    )
    return files
  }

  /** 下钻夹具 + 契约（`vw_<domain>_<table>` ← contracts/<domain>.<table>.json，与生成器同一约定）。 */
  const withContract = (col: string): Record<string, string> => {
    const files = drillCompliant()
    files[METRICS] = files[METRICS].replace(
      `    detail: { relation: vw_t, filter: "state = 'FINISHED'" }`,
      [
        '    detail:',
        '      relation: vw_lemeng_retail_detail',
        `      filter: "state = 'FINISHED'"`,
        '      columns:',
        `        - { col: ${col}, grantedBy: data:cost }`,
      ].join('\n'),
    )
    files['dbt/models/lemeng/views/vw_lemeng_retail_detail.sql'] = [
      'select',
      "    'acme' as org,",
      '    system_book,',
      '    order_detail_std_price',
      'from staging.stg_lemeng_retail_detail',
      '',
    ].join('\n')
    files['contracts/common/lemeng.retail_detail.json'] = JSON.stringify({
      domain: 'lemeng',
      table: 'retail_detail',
      columns: [{ name: 'system_book' }, { name: 'order_detail_std_price' }],
    })
    return files
  }

  it('detail.columns[].col 按契约列集校验：真列 ⇒ 零违规；拼错 ⇒ 拒（#1009）', () => {
    expect(checkDataModels(fixture(withContract('order_detail_std_price')))).toEqual([])

    const vs = checkDataModels(fixture(withContract('order_detail_stdprice')))
    expect(vs).toHaveLength(1)
    expect(vs[0]?.message).toContain('契约列集')
    expect(vs[0]?.message).toContain('order_detail_stdprice')
  })

  it('detail.columns 合法条件列 ⇒ 零违规', () => {
    const files = withColumns(['      columns:', '        - { col: order_detail_std_price, grantedBy: data:cost }'])
    expect(checkDataModels(fixture(files))).toEqual([])
  })

  it('detail.columns：蛇形键名写错（granted_by）⇒ 拒（静默不生效是这里最怕的形态）', () => {
    const files = withColumns(['      columns:', '        - { col: order_detail_std_price, granted_by: data:cost }'])
    const vs = checkDataModels(fixture(files))
    expect(vs.some((v) => /未知键/.test(v.message) && /granted_by/.test(v.message))).toBe(true)
  })

  it('detail.columns：col 与 dimensions 重叠 / 叫 value / 重复 / 空数组 ⇒ 各自拒', () => {
    const inDims = withColumns(['      columns:', '        - { col: system_book, grantedBy: data:cost }'])
    expect(checkDataModels(fixture(inDims)).some((v) => /dimensions/.test(v.message))).toBe(true)

    const asValue = withColumns(['      columns:', '        - { col: value, grantedBy: data:cost }'])
    expect(checkDataModels(fixture(asValue)).some((v) => /value/.test(v.message))).toBe(true)

    const dup = withColumns([
      '      columns:',
      '        - { col: order_detail_std_price, grantedBy: data:cost }',
      '        - { col: order_detail_std_price, grantedBy: data:cost }',
    ])
    expect(checkDataModels(fixture(dup)).some((v) => /重复/.test(v.message))).toBe(true)

    const empty = withColumns(['      columns: []'])
    expect(checkDataModels(fixture(empty)).some((v) => /非空数组/.test(v.message))).toBe(true)
  })

  it('detail：未知键（如 colums 拼错）⇒ 拒', () => {
    const files = withColumns(['      colums:', '        - { col: order_detail_std_price, grantedBy: data:cost }'])
    const vs = checkDataModels(fixture(files))
    expect(vs.some((v) => /未知键/.test(v.message))).toBe(true)
  })

  it('compose 整串文法锚定：自由 SQL（如 (select 1)）⇒ 拒，合法组合式不误伤（裁决 2A）', () => {
    // 变异：compose 换成无 @、无分号的自由 SQL —— 剥掉引用与 + - ( ) 空白后有残留，必须门禁期就红
    //（修前这一格是绿的：matchAll 抓不到引用、无分号、其余三键全合规 ⇒ 自由 SQL 静默滑过）
    const files = drillCompliant()
    files[METRICS] = files[METRICS].replace(
      'compose: "sale_amount@order - return_amount@line"',
      "compose: '(select 1)'",
    )
    const vs = checkDataModels(fixture(files))
    expect(vs).toHaveLength(1)
    expect(vs[0]?.message).toMatch(/文法外记号/)

    // 反面（防误伤）：合法组合式带括号与空白 ⇒ 锚定后残留为空，仍零违规
    const legit = drillCompliant()
    legit[METRICS] = legit[METRICS].replace(
      'compose: "sale_amount@order - return_amount@line"',
      'compose: "(sale_amount@order) - return_amount@line"',
    )
    expect(checkDataModels(fixture(legit))).toEqual([])
  })
})
