// semantic-compiler.test.ts — L2 **唯一编译点**的单测（T8 Step 1）。
//
// 本文件钉的是「定义权下放」的安全边界：L2 只能**裁剪/别名/过滤/目标值**，不能改口径、
// 不能落任意 SQL（全局约束 12）。故断言分三类：
//   ① 机检（写时校验）：引用不存在 / 维度越界 / 形状不合契约 —— 一律**抛**，不静默放过
//   ② 产物形状：纯 SELECT（无分号、无 DDL/DML 痕迹）——「禁任意 SQL」的可机检落点
//   ③ 产物**真的能跑**：拿真库里的替身表把编译产物当 SQL 执行，断言 roll-up 结果正确
//      （只做字符串断言 = 可能编出一个自己都没跑过的形状；#51 教训：宽松的替身让缺陷不可见）
import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import type { MetricDef } from './authz'
import { sqlQuote } from './authz'
import type { MetricRow } from './metric-store'
import {
  MAX_BODY_NESTING,
  exceedsNesting,
  SemanticCompileError,
  compileL2,
  collectRefIds,
  dimensionNamesOf,
  parseL1Select,
  renderExprNode,
  resolveL1Base,
  FORBIDDEN_SQL_RE,
} from './semantic-compiler'
import type { ExprNode, L2Declaration, L2RefineDeclaration } from './semantic-compiler'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

/**
 * date 列 → `YYYY-MM-DD`（**本地**时区口径）。
 * 不用 `String(date)`（那是 "Thu Jan 01 2026 …"），也不用 `toISOString()`：后者按 UTC 渲染，
 * 而 pg 在这个会话时区（+08）下回的 Date 是当地零点的瞬间 ⇒ 会被渲染成前一天。
 */
function localDay(v: unknown): string {
  if (!(v instanceof Date)) return String(v)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`
}

/**
 * L1 基底（形状 = sync 脚本物化的产物，见 scripts/sync-data-semantics.mjs 的「形状契约」节）。
 * 关系名**不带 schema**：多租户下 schema 由会话 search_path 绑（dbt/README §10），
 * 故 L1 的 select_sql 必须写成非限定关系名。
 */
function l1(over: Partial<MetricRow> = {}): MetricRow {
  return {
    id: 'lemeng:retail:net_sales',
    title: '净销售额',
    description: '有效零售订单的成交金额合计',
    requiredScope: null,
    subjectColumn: 'org',
    selectSql: 'select sum(fct_retail_sale.net_amount) as value, system_book, bizday from fct_retail_sale',
    groupBy: 'system_book, bizday',
    params: {},
    source: 'l1',
    // 源系统（源维度）：L1 声明里 `source` 必填 ⇒ sync 物化出的 L1 行恒有源。
    sourceSystem: 'lemeng',
    // L1 行由 sync 物化（不经 API）⇒ 无操作人、版本恒 1（#489 的追溯只覆盖 L2）
    updatedBy: null,
    version: 1,
    // 存储行恒带规范化布尔（spec §8.4；缺省 false = 本夹具不涉自动合计）
    totalable: false,
    // 新鲜度链路（spec §10.7；缺省 = 无链路形态，本夹具不涉水位）
    slaDays: 1,
    freshnessRelations: [],
    ...over,
  }
}

/** L1 词表：两条声明（第二条用来验「维度只属于自己那条」）。 */
const L1_CATALOG: MetricRow[] = [
  l1(),
  l1({
    id: 'lemeng:retail:order_count',
    title: '订单数',
    selectSql: 'select sum(fct_retail_sale.order_count) as value, system_book, bizday from fct_retail_sale',
  }),
]

/** 最小合法声明；各用例只覆盖自己关心的字段。 */
const decl = (over: Partial<L2RefineDeclaration> = {}) => ({
  baseMetric: 'lemeng:retail:net_sales',
  op: { kind: 'refine' as const },
  ...over,
})

/** 抛错助手：断言抛的是带 code 的 SemanticCompileError（不是任意 TypeError）。 */
function expectThrow(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (e) {
    expect(e, `期望抛 SemanticCompileError(${code})，实抛 ${String(e)}`).toBeInstanceOf(SemanticCompileError)
    expect((e as SemanticCompileError).code).toBe(code)
    return
  }
  throw new Error(`期望抛 SemanticCompileError(${code})，但没有抛`)
}

describe('parseL1Select：L1 select_sql 形状契约', () => {
  it('带粒度的形状：拆出表达式 / 关系名', () => {
    const p = parseL1Select(l1().selectSql)
    expect(p.expression).toBe('sum(fct_retail_sale.net_amount)')
    expect(p.relation).toBe('fct_retail_sale')
  })

  it('不带粒度的形状也算合法（grain 为空数组的指标）', () => {
    const p = parseL1Select('select count(*) as value from fct_x')
    expect(p.expression).toBe('count(*)')
    expect(p.relation).toBe('fct_x')
  })

  it('schema 限定的关系名也算合法（单租户/私有化形态不受影响）', () => {
    expect(parseL1Select('select sum(a.b) as value, c from d.e').relation).toBe('d.e')
  })

  it('不合契约 ⇒ 抛 BAD_BASE_SQL（连带分号/DML 一起拦）', () => {
    expectThrow(() => parseL1Select('select a, b from c'), 'BAD_BASE_SQL')
    expectThrow(() => parseL1Select('select a as value, b from c; drop table c'), 'BAD_BASE_SQL')
    expectThrow(() => parseL1Select('delete from c'), 'BAD_BASE_SQL')
  })
})

describe('dimensionNamesOf：L1 声明的维度清单', () => {
  it('按 group_by 拆维度（去空白、丢空段）', () => {
    expect(dimensionNamesOf(l1())).toEqual(['system_book', 'bizday'])
    expect(dimensionNamesOf(l1({ groupBy: '' }))).toEqual([])
  })
})

describe('resolveL1Base：base 必须命中 L1 词表', () => {
  it('命中则返回该行', () => {
    expect(resolveL1Base(L1_CATALOG, 'lemeng:retail:net_sales').title).toBe('净销售额')
  })

  it('base 不存在于 L1 ⇒ 抛 L1_BASE_NOT_FOUND', () => {
    expectThrow(() => resolveL1Base(L1_CATALOG, 'retail:not_declared'), 'L1_BASE_NOT_FOUND')
  })

  it('base 命中的是**别家的 L2 行** ⇒ 同样抛（L2 不能当 L2 的 base：唯一编译点只认 L1）', () => {
    const l2Row = l1({ id: 'tenant:custom', source: 'l2' })
    expectThrow(() => resolveL1Base([...L1_CATALOG, l2Row], 'tenant:custom'), 'L1_BASE_NOT_FOUND')
  })
})

describe('compileL2：写时校验（机检，不是运行时才发现）', () => {
  it('op.kind 只支持 refine（B 中档的受限表达式不私自放行）', () => {
    const base = resolveL1Base(L1_CATALOG, 'lemeng:retail:net_sales')
    expectThrow(
      () => compileL2([base], decl({ op: { kind: 'expression' } as unknown as { kind: 'refine' } })),
      'OP_UNSUPPORTED',
    )
  })

  it('filters 的维度名不在 L1 声明 ⇒ 抛 UNKNOWN_DIM（并点名是哪个维度）', () => {
    const base = resolveL1Base(L1_CATALOG, 'lemeng:retail:net_sales')
    expectThrow(
      () => compileL2([base], decl({ filters: [{ dim: 'store_id', op: '=', values: ['S1'] }] })),
      'UNKNOWN_DIM',
    )
  })

  it('visibility 的维度名不在 L1 声明 ⇒ 抛 UNKNOWN_DIM', () => {
    const base = resolveL1Base(L1_CATALOG, 'lemeng:retail:net_sales')
    expectThrow(
      () => compileL2([base], decl({ visibility: { dims: ['system_book', 'store_id'] } })),
      'UNKNOWN_DIM',
    )
  })

  it('维度名不是标识符（想借维度名注入）⇒ 抛 UNKNOWN_DIM', () => {
    const base = resolveL1Base(L1_CATALOG, 'lemeng:retail:net_sales')
    expectThrow(
      () => compileL2([base], decl({ visibility: { dims: ['system_book) or 1=1 --'] } })),
      'UNKNOWN_DIM',
    )
  })

  it('= 只许一个值、in 至少要一个值 ⇒ 否则抛 BAD_FILTER', () => {
    const base = resolveL1Base(L1_CATALOG, 'lemeng:retail:net_sales')
    expectThrow(() => compileL2([base], decl({ filters: [{ dim: 'bizday', op: '=', values: [] }] })), 'BAD_FILTER')
    expectThrow(
      () => compileL2([base], decl({ filters: [{ dim: 'bizday', op: '=', values: ['a', 'b'] }] })),
      'BAD_FILTER',
    )
    expectThrow(() => compileL2([base], decl({ filters: [{ dim: 'bizday', op: 'in', values: [] }] })), 'BAD_FILTER')
  })
})

describe('compileL2：产物形状', () => {
  it('不声明 visibility ⇒ 维度继承 L1 的 grain，标题仍是 L1 标题', () => {
    const base = resolveL1Base(L1_CATALOG, 'lemeng:retail:net_sales')
    const { selectSql, title, groupBy } = compileL2([base], decl())
    expect(title).toBe('净销售额')
    expect(selectSql).toBe('select sum(fct_retail_sale.net_amount) as value, system_book, bizday from fct_retail_sale')
    // groupBy 一并回：落库要它（data.metrics.group_by 必填），且必须与 SELECT 的维度同源
    expect(groupBy).toBe('system_book, bizday')
  })

  it('groupBy 与 SELECT 的可见维度**同源**（裁剪后两边一起变，不会各说各话）', () => {
    const base = resolveL1Base(L1_CATALOG, 'lemeng:retail:net_sales')
    const { selectSql, groupBy } = compileL2([base], decl({ visibility: { dims: ['bizday'] } }))
    expect(groupBy).toBe('bizday')
    expect(selectSql).toContain(', bizday')
    expect(selectSql).not.toContain('system_book')
  })

  it('visibility 重复维度去重（同一个维度写两遍不该让 SELECT 出现重复列）', () => {
    const base = resolveL1Base(L1_CATALOG, 'lemeng:retail:net_sales')
    const { selectSql, groupBy } = compileL2([base], decl({ visibility: { dims: ['bizday', 'bizday'] } }))
    expect(groupBy).toBe('bizday')
    expect(selectSql).toBe('select sum(fct_retail_sale.net_amount) as value, bizday from fct_retail_sale')
  })

  it('filters 形态下 groupBy 也回可见维度（派生表那支同样不能漏）', () => {
    const base = resolveL1Base(L1_CATALOG, 'lemeng:retail:net_sales')
    const { groupBy } = compileL2([base], decl({
      visibility: { dims: ['system_book'] },
      filters: [{ dim: 'bizday', op: '=', values: ['2026-01-01'] }],
    }))
    expect(groupBy).toBe('system_book')
  })

  it('alias ⇒ 标题换成别名（口径不变，只是换个叫法）', () => {
    const base = resolveL1Base(L1_CATALOG, 'lemeng:retail:net_sales')
    expect(compileL2([base], decl({ alias: '熊喵净销售' })).title).toBe('熊喵净销售')
  })

  it('visibility.dims 裁掉维度（裁剪只少不多）', () => {
    const base = resolveL1Base(L1_CATALOG, 'lemeng:retail:net_sales')
    const { selectSql } = compileL2([base], decl({ visibility: { dims: ['system_book'] } }))
    expect(selectSql).toContain('system_book')
    expect(selectSql).not.toContain('bizday')
  })

  it('visibility.dims 空数组 ⇒ 只出汇总值（不带任何维度）', () => {
    const base = resolveL1Base(L1_CATALOG, 'lemeng:retail:net_sales')
    const { selectSql } = compileL2([base], decl({ visibility: { dims: [] } }))
    expect(selectSql).toBe('select sum(fct_retail_sale.net_amount) as value from fct_retail_sale')
  })

  it('L2 不改 L1 口径：值表达式逐字来自 base（不是 L2 自己写的）', () => {
    const base = resolveL1Base(L1_CATALOG, 'lemeng:retail:net_sales')
    const { selectSql } = compileL2([base], decl({ alias: 'x', visibility: { dims: ['bizday'] } }))
    expect(selectSql).toContain('sum(fct_retail_sale.net_amount) as value')
  })

  it('filters 走 FROM 派生表：值表达式与关系名原样保留（schema 限定形态也不破）', () => {
    const base = resolveL1Base(L1_CATALOG, 'lemeng:retail:net_sales')
    const { selectSql } = compileL2([base], decl({ filters: [{ dim: 'system_book', op: '=', values: ['3120'] }] }))
    // 派生表里带过滤，外层再聚合 ⇒ 值表达式的限定名仍然可解析（派生表没改关系名）
    expect(selectSql).toContain('from (select sum(fct_retail_sale.net_amount) as value, system_book, bizday, org')
    expect(selectSql).toContain("where system_book = '3120'")
    expect(selectSql).toContain('group by system_book, bizday, org')
  })

  it('filter 值单引号双写（走 authz 的 sqlQuote 单一实现，不另写转义）', () => {
    const base = resolveL1Base(L1_CATALOG, 'lemeng:retail:net_sales')
    const { selectSql } = compileL2([base], decl({ filters: [{ dim: 'system_book', op: '=', values: ["a'b"] }] }))
    expect(selectSql).toContain(`= ${sqlQuote("a'b")}`)
  })

  it('★ 产物是纯 SELECT：无分号、无 DDL/DML 关键字（禁任意 SQL 的可机检落点）', () => {
    const base = resolveL1Base(L1_CATALOG, 'lemeng:retail:net_sales')
    const outputs = [
      compileL2([base], decl()).selectSql,
      compileL2([base], decl({ visibility: { dims: [] } })).selectSql,
      compileL2([base], decl({ filters: [{ dim: 'bizday', op: 'in', values: ['2026-01-01', '2026-01-02'] }] })).selectSql,
    ]
    for (const sql of outputs) {
      expect(sql).not.toContain(';')
      expect(sql.toLowerCase()).not.toMatch(/\b(insert|update|delete|drop|create|alter|grant|truncate|copy|attach)\b/)
      expect(sql.trim().toLowerCase().startsWith('select ')).toBe(true)
    }
  })
})

// ── 产物真的能跑（真库 + 替身表）────────────────────────────────────────────────────
// 为什么必须有这一段：只断言字符串 = 可能编出一个**自己都没跑过**的形状（例如派生表列名
// 不匹配、聚合层缺 GROUP BY）。替身表带 org 列，与 authz.authorize 拼出的
// `... where org = 'x' [group by …] limit N` 拼起来执行，验的是「authz 会真实拼出的那条 SQL」。
describePg('compileL2 产物在真库上可执行（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const SCHEMA = 't8_standin'

  afterAll(async () => {
    await pool.query(`drop schema if exists ${SCHEMA} cascade`).catch(() => {})
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.end().catch(() => {})
  })

  /** 造替身 mart：形状 = fct_retail_sale（含 org 列），并回填两租户数据。 */
  async function seedStandin() {
    await pool.query(`drop schema if exists ${SCHEMA} cascade`)
    await pool.query(`create schema ${SCHEMA}`)
    await pool.query(`create table ${SCHEMA}.fct_retail_sale (
      org text not null, system_book text not null, bizday date not null,
      net_amount numeric not null, order_count integer not null)`)

    // acme：3120 两天 + 64188 一天；beta 同形状（用来验主体钉死真的把 beta 挡在外面）
    const rows: Array<[string, string, string, number, number]> = [
      ['acme', '3120', '2026-01-01', 100, 2],
      ['acme', '3120', '2026-01-02', 50, 1],
      ['acme', '64188', '2026-01-01', 7, 1],
      ['beta', '3120', '2026-01-01', 999, 9],
    ]
    for (const r of rows) {
      await pool.query(
        `insert into ${SCHEMA}.fct_retail_sale (org, system_book, bizday, net_amount, order_count)
         values ($1, $2, $3, $4, $5)`,
        r,
      )
    }
  }

  /** 替身基底：与 l1() 同形，只把关系名指向替身 schema。 */
  const standinBase = (): MetricRow =>
    resolveL1Base(
      [l1({
        selectSql: `select sum(${SCHEMA}.fct_retail_sale.net_amount) as value, system_book, bizday from ${SCHEMA}.fct_retail_sale`,
      })],
      'lemeng:retail:net_sales',
    )

  /** 与 domain/authz.ts 的 authorize 同形地拼出最终 SQL（主体钉死 + 可选 GROUP BY + LIMIT）。 */
  const authorizeLike = (m: MetricDef, org: string, groupBy: string) =>
    `${m.selectSql} WHERE ${m.subjectColumn} = ${sqlQuote(org)}` +
    (groupBy ? ` GROUP BY ${groupBy}` : '') + ' LIMIT 1000'

  it('无 filters/无 visibility：按 L1 grain 出数，且只出本租户（主体钉死）', async () => {
    await seedStandin()
    const base = standinBase()
    const { selectSql } = compileL2([base], decl())
    const sql = authorizeLike({ ...base, selectSql }, 'acme', base.groupBy)

    const r = await pool.query(sql)
    // acme 三天各一行；beta 的 999 一行都不能出现（它是另一个租户）
    expect(r.rowCount).toBe(3)
    // bizday 是 date 列 ⇒ pg 回 Date 对象，别拿 String(date) 比（那是 "Thu Jan 01 2026 …"），
    // 也别拿 toISOString（它按 UTC 渲染：本地 +08 的 2026-01-01 会变成 '2025-12-31'）
    expect(Number(r.rows.find((x) => x.system_book === '3120' && localDay(x.bizday) === '2026-01-01')?.value)).toBe(100)
    expect(r.rows.some((x) => Number(x.value) === 999), 'beta 的行漏进来了').toBe(false)
  })

  it('visibility 裁到单维度：roll-up 正确（同一账套跨日求和）', async () => {
    await seedStandin()
    const base = standinBase()
    const { selectSql } = compileL2([base], decl({ visibility: { dims: ['system_book'] } }))
    const sql = authorizeLike({ ...base, selectSql }, 'acme', 'system_book')

    const r = await pool.query(sql)
    expect(r.rowCount).toBe(2)
    expect(Number(r.rows.find((x) => x.system_book === '3120').value)).toBe(150)
    expect(Number(r.rows.find((x) => x.system_book === '64188').value)).toBe(7)
  })

  it('filters 走派生表：过滤生效、且仍然只出本租户', async () => {
    await seedStandin()
    const base = standinBase()
    const { selectSql } = compileL2([base], decl({
      visibility: { dims: ['system_book'] },
      filters: [{ dim: 'system_book', op: '=', values: ['3120'] }],
    }))
    const sql = authorizeLike({ ...base, selectSql }, 'acme', 'system_book')

    const r = await pool.query(sql)
    expect(r.rowCount).toBe(1)
    expect(Number(r.rows[0].value)).toBe(150)
  })

  it('filters 用 in：多值过滤生效', async () => {
    await seedStandin()
    const base = standinBase()
    const { selectSql } = compileL2([base], decl({
      visibility: { dims: ['bizday'] },
      filters: [{ dim: 'system_book', op: 'in', values: ['3120', '64188'] }],
    }))
    const sql = authorizeLike({ ...base, selectSql }, 'acme', 'bizday')

    const r = await pool.query(sql)
    // acme 的两个业务日：01-01 = 100 + 7、01-02 = 50
    expect(r.rowCount).toBe(2)
    expect(Number(r.rows.find((x) => localDay(x.bizday) === '2026-01-02')?.value)).toBe(50)
  })

  it('★ 汇总形态（visibility 空）：不带维度也真跑得通（GROUP BY 空 ⇒ authz 不拼 GROUP BY）', async () => {
    await seedStandin()
    const base = standinBase()
    const { selectSql } = compileL2([base], decl({ visibility: { dims: [] } }))
    const sql = authorizeLike({ ...base, selectSql }, 'acme', '')

    const r = await pool.query(sql)
    expect(r.rowCount).toBe(1)
    expect(Number(r.rows[0].value)).toBe(157)
  })

  // ── B 中档（expr）在真库上：比例类测度的端到端（增补 §6.5 的「产物真的能跑」那一半）──────
  // 为什么必须有这一段：expr 的产物形状与 refine 同形，但**语义不同**——refine 是上滚，
  // expr 是**比值**。比值有两点只能靠执行验：① 每主体一行（不是按日展开）；② 0 分母得 NULL。
  // 字符串断言对这两点一字不判（`NULLIF` 在不在串里 ≠ 它真把 0 变成了 NULL）。
  it('★ expr：div(净销售额 / 订单数) —— 每主体一行的比值正确，且 0 分母 ⇒ NULL（不是 0）', async () => {
    await seedStandin()
    // 两条 L1 必须同关系 / 同 grain / 同主体列（否则 MIXED_BASE）—— l1() 的默认值已保证后两者
    const netSales = l1({
      selectSql: `select sum(${SCHEMA}.fct_retail_sale.net_amount) as value, system_book, bizday from ${SCHEMA}.fct_retail_sale`,
    })
    const orderCount = l1({
      id: 'lemeng:retail:order_count',
      title: '订单数',
      selectSql: `select sum(${SCHEMA}.fct_retail_sale.order_count) as value, system_book, bizday from ${SCHEMA}.fct_retail_sale`,
    })
    const { selectSql, groupBy } = compileL2([netSales, orderCount], {
      visibility: { dims: ['system_book'] },
      op: {
        kind: 'expr',
        expr: {
          kind: 'div',
          left: { kind: 'ref', id: netSales.id },
          right: { kind: 'ref', id: orderCount.id },
        },
      },
    })
    const sql = authorizeLike({ ...netSales, selectSql }, 'acme', groupBy)

    // 种子数据自身成对：3120 → net=150,cnt=3；64188 → net=7,cnt=1（不是另造一份数）
    const r = await pool.query(sql)
    expect(r.rowCount, '按 system_book 聚合应当每主体一行（跟着 bizday 展开就说明可见维度没生效）').toBe(2)
    expect(Number(r.rows.find((x) => x.system_book === '3120')?.value)).toBe(50)
    expect(Number(r.rows.find((x) => x.system_book === '64188')?.value)).toBe(7)

    // 0 分母：net=12 / cnt=0 ⇒ **NULL**（NULLIF 守卫的端到端证据；0 会污染下游均值/累计）
    const zeroBook = '90000'
    await pool.query(
      `insert into ${SCHEMA}.fct_retail_sale (org, system_book, bizday, net_amount, order_count)
       values ($1, $2, $3, $4, $5)`,
      ['acme', zeroBook, '2026-01-01', 12, 0],
    )
    try {
      const r2 = await pool.query(sql)
      expect(r2.rowCount).toBe(3)
      const zero = r2.rows.find((x) => x.system_book === zeroBook)
      expect(zero, '刚插进去的 0 分母行没出现在结果里').toBeDefined()
      expect(zero?.value, '0 分母算出了值（NULLIF 守卫没生效？）').toBeNull()
    } finally {
      // **只删本用例插的那一行**：替身 schema 是兄弟用例共用的（全局清理会砍掉它们的夹具）
      await pool.query(
        `delete from ${SCHEMA}.fct_retail_sale where org = $1 and system_book = $2 and bizday = $3`,
        ['acme', zeroBook, '2026-01-01'],
      )
    }
  })
})

// ── 客单价：与**手写**期望 SQL 逐字相等（增补 §6.5）──────────────────────────────
// 期望串是**手推**出来的，不是把编译产物粘回来（粘回来 = 恒真断言，一文不值）。推法：
//   ① ref → `parseL1Select(selectSql).expression` **逐字**（不重写口径）
//        ⇒ `sum(fct_retail_sale.net_amount)` / `sum(fct_retail_sale.order_count)`
//   ② div → `(左) / NULLIF((右), 0)`（renderExprNode 的 div 支；守卫由编译器注入）
//   ③ 产物 = `select <表达式> as value[, <可见维度>] from <关系>`（增补 §4.1）
//        可见维度省略 = 继承共享 grain（= 两条 L1 的 groupBy 全部）
// 两条 L1 的 select_sql 里**不写维度列**（维度由 groupBy 决定，唯一来源就是它）——
// 这正是 parseL1Select 契约允许的形态：`select <表达式> as value from <关系>`。
describe('L2 · B 中档 · 客单价逐字（增补 §6.5）', () => {
  const netSales: MetricRow = {
    ...l1(),
    id: 'lemeng:retail:net_sales',
    title: '净销售额',
    selectSql: 'select sum(fct_retail_sale.net_amount) as value from fct_retail_sale',
    groupBy: 'system_book, bizday',
    subjectColumn: 'system_book',
  }
  const orderCount: MetricRow = {
    ...netSales,
    id: 'lemeng:retail:order_count',
    title: '订单数',
    selectSql: 'select sum(fct_retail_sale.order_count) as value from fct_retail_sale',
  }

  it('div(ref:net_sales, ref:order_count) 的 selectSql 逐字相等', () => {
    const out = compileL2([netSales, orderCount], {
      op: {
        kind: 'expr',
        expr: { kind: 'div', left: { kind: 'ref', id: netSales.id }, right: { kind: 'ref', id: orderCount.id } },
      },
    })
    expect(out.selectSql).toBe(
      'select (sum(fct_retail_sale.net_amount)) / NULLIF((sum(fct_retail_sale.order_count)), 0) as value, system_book, bizday from fct_retail_sale',
    )
    expect(out.groupBy).toBe('system_book, bizday')
    expect(out.subjectColumn).toBe('system_book')
  })

  it('可见维度收窄后，表达式部分逐字不变（只有维度列表变）', () => {
    const out = compileL2([netSales, orderCount], {
      visibility: { dims: ['system_book'] },
      op: {
        kind: 'expr',
        expr: { kind: 'div', left: { kind: 'ref', id: netSales.id }, right: { kind: 'ref', id: orderCount.id } },
      },
    })
    expect(out.selectSql).toBe(
      'select (sum(fct_retail_sale.net_amount)) / NULLIF((sum(fct_retail_sale.order_count)), 0) as value, system_book from fct_retail_sale',
    )
    expect(out.groupBy).toBe('system_book')
  })
})

describe('L2 · B 中档（受限表达式）', () => {
  const base = l1()
  // 第二条 L1 必须是「同关系 / 同 grain / 同主体列」的克隆 —— 只换 id。
  const catalog = [base, { ...base, id: 'standin:clone' }]

  /** 取抛出的错误码与消息；不抛返回 {}（期望抛时它会自然让断言失败）。 */
  const errorOf = (fn: () => unknown): { code?: string; message?: string } => {
    try {
      fn()
    } catch (e) {
      const err = e as { code?: string; message?: string }
      return { code: err.code, message: err.message }
    }
    return {}
  }

  const ref = (id: string): ExprNode => ({ kind: 'ref', id })

  it('div(ref, ref) ⇒ 除法守卫由编译器注入（NULLIF，0 分母得 NULL）；title/description/subjectColumn 来自编译产物', () => {
    const out = compileL2(catalog, {
      op: { kind: 'expr', expr: { kind: 'div', left: ref(base.id), right: ref('standin:clone') } },
    })
    expect(out.selectSql).toContain('NULLIF(')
    expect(out.selectSql).toContain(' as value')
    expect(out.selectSql).toContain(' from ')
    expect(out.title).toBe(`派生(${base.id} / standin:clone)`)
    expect(out.description).toBe(`L2 派生自 (${base.id}, standin:clone)`)
    expect(out.subjectColumn).toBe(base.subjectColumn)
  })

  it('alias 优先于派生名', () => {
    const out = compileL2(catalog, {
      alias: '客单价',
      op: { kind: 'expr', expr: ref(base.id) },
    })
    expect(out.title).toBe('客单价')
  })

  it('同一 ref 出现两次 ⇒ 只解析一次、渲染成同一段 expression（title 里也只出现一次）', () => {
    const out = compileL2(catalog, {
      op: { kind: 'expr', expr: { kind: 'add', left: ref(base.id), right: ref(base.id) } },
    })
    expect(out.title).toBe(`派生(${base.id})`)
    expect(out.description).toBe(`L2 派生自 (${base.id})`)
  })

  it('ref 未命中 L1 词表 ⇒ L1_BASE_NOT_FOUND（message 点名该 ref）', () => {
    const got = errorOf(() => compileL2(catalog, { op: { kind: 'expr', expr: ref('no:such:l1') } }))
    expect(got.code).toBe('L1_BASE_NOT_FOUND')
    expect(got.message).toContain('no:such:l1')
  })

  it('refs 跨主体列 ⇒ MIXED_BASE（点出两侧的主体列）', () => {
    const other = { ...base, id: 'standin:other-subject', subjectColumn: `${base.subjectColumn}_x` }
    const got = errorOf(() => compileL2([...catalog, other], {
      op: { kind: 'expr', expr: { kind: 'add', left: ref(base.id), right: ref(other.id) } },
    }))
    expect(got.code).toBe('MIXED_BASE')
    expect(got.message).toContain(other.id)
  })

  it('refs 跨 grain（同关系、同主体列）⇒ MIXED_BASE', () => {
    const other = { ...base, id: 'standin:other-grain', groupBy: `${base.groupBy}, extra_dim` }
    const got = errorOf(() => compileL2([...catalog, other], {
      op: { kind: 'expr', expr: { kind: 'add', left: ref(base.id), right: ref(other.id) } },
    }))
    expect(got.code).toBe('MIXED_BASE')
    expect(got.message).toContain('grain')
  })

  it('纯字面量 expr ⇒ BAD_DECL（拼不出 from 子句）', () => {
    const got = errorOf(() => compileL2(catalog, { op: { kind: 'expr', expr: { kind: 'num', value: 1 } } }))
    expect(got.code).toBe('BAD_DECL')
  })

  it('表达式树深 9（上限 8 层）⇒ EXPR_DEPTH_EXCEEDED', () => {
    let deep: ExprNode = ref(base.id)
    for (let i = 0; i < 8; i++) deep = { kind: 'add', left: deep, right: { kind: 'num', value: 1 } }
    const got = errorOf(() => compileL2(catalog, { op: { kind: 'expr', expr: deep } }))
    expect(got.code).toBe('EXPR_DEPTH_EXCEEDED')
    expect(got.message).toMatch(/表达式树深 9/)
  })

  it('ref 出现 17 次（上限 16）⇒ EXPR_DEPTH_EXCEEDED；树很浅 ⇒ 证明计数的是"出现次数"而不是深度', () => {
    const balanced = (leaves: number): ExprNode => leaves === 1
      ? ref(base.id)
      : {
        kind: 'add',
        left: balanced(Math.floor(leaves / 2)),
        right: balanced(leaves - Math.floor(leaves / 2)),
      }
    const got = errorOf(() => compileL2(catalog, { op: { kind: 'expr', expr: balanced(17) } }))
    expect(got.code).toBe('EXPR_DEPTH_EXCEEDED')
    expect(got.message).toMatch(/ref 出现 17 次/)
  })

  it('expr 声明带 filters ⇒ OP_UNSUPPORTED —— 空数组也算"声明了"', () => {
    const got = errorOf(() => compileL2(catalog, {
      op: { kind: 'expr', expr: ref(base.id) },
      filters: [],
    }))
    expect(got.code).toBe('OP_UNSUPPORTED')
  })

  it('num 非有限数 ⇒ BAD_DECL（面级 schema 也拒，见 Task 2 的对偶用例）', () => {
    const got = errorOf(() => compileL2(catalog, {
      op: { kind: 'expr', expr: { kind: 'num', value: Number.NaN } },
    }))
    expect(got.code).toBe('BAD_DECL')
  })

  it('未知节点 kind ⇒ BAD_DECL（fail-closed，不许静默跳过）', () => {
    const pow = { kind: 'pow', left: ref(base.id), right: { kind: 'num', value: 2 } } as unknown as ExprNode
    expect(errorOf(() => compileL2(catalog, { op: { kind: 'expr', expr: pow } })).code).toBe('BAD_DECL')
  })

  it('未知 op.kind ⇒ OP_UNSUPPORTED（分派器兜底；面级会先以 INVALID_BODY 拦下，这是绕过面级的防线）', () => {
    const bogus = { op: { kind: 'aggregate' } } as unknown as L2Declaration
    expect(errorOf(() => compileL2(catalog, bogus)).code).toBe('OP_UNSUPPORTED')
  })

  it('非对象声明 ⇒ BAD_DECL', () => {
    expect(errorOf(() => compileL2(catalog, null as unknown as L2Declaration)).code).toBe('BAD_DECL')
  })

  it('collectRefIds：refine 取 baseMetric；expr 去重保序；形状不对返回 []（不抛）', () => {
    expect(collectRefIds({ baseMetric: base.id, op: { kind: 'refine' } })).toEqual([base.id])
    expect(collectRefIds({
      op: {
        kind: 'expr',
        expr: { kind: 'add', left: ref('a'), right: { kind: 'div', left: ref('b'), right: ref('a') } },
      },
    })).toEqual(['a', 'b'])
    expect(collectRefIds({} as unknown as L2Declaration)).toEqual([])
  })

  it('renderExprNode 逐节点：只有字面量渲染该点的片段，除零守卫在 div 上', () => {
    const refs = new Map([['a', 'sum(t.x)'], ['b', 'sum(t.y)']])
    expect(renderExprNode({ kind: 'num', value: 3 }, refs)).toBe('3')
    expect(renderExprNode(ref('a'), refs)).toBe('sum(t.x)')
    expect(renderExprNode({ kind: 'add', left: { kind: 'num', value: 1 }, right: { kind: 'num', value: 2 } }, refs))
      .toBe('(1) + (2)')
    expect(renderExprNode({ kind: 'sub', left: { kind: 'num', value: 1 }, right: { kind: 'num', value: 2 } }, refs))
      .toBe('(1) - (2)')
    expect(renderExprNode({ kind: 'mul', left: { kind: 'num', value: 1 }, right: { kind: 'num', value: 2 } }, refs))
      .toBe('(1) * (2)')
    expect(renderExprNode({ kind: 'div', left: { kind: 'num', value: 1 }, right: { kind: 'num', value: 2 } }, refs))
      .toBe('(1) / NULLIF((2), 0)')
    // ref 解析表缺项 ⇒ fail-closed（不是静默出空串）
    expect(errorOf(() => renderExprNode(ref('missing'), refs)).code).toBe('BAD_DECL')
  })

  it('expr 产物不含任何 DDL/DML 关键字（B 中档的安全属性，见 FORBIDDEN_SQL_RE）', () => {
    const out = compileL2(catalog, {
      op: {
        kind: 'expr',
        expr: { kind: 'div', left: ref(base.id), right: { kind: 'mul', left: ref('standin:clone'), right: { kind: 'num', value: 2 } } },
      },
    })
    expect(out.selectSql).not.toMatch(FORBIDDEN_SQL_RE)
  })
})

// ── 逐节点可达集：穷举单节点 + 组合片段的白名单（增补 §6.1）──────────────────────
// 「可达集」能逐节点枚举，是因为渲染**只有一点**（renderExprNode 的穷尽 switch，default 把
// node 赋给 never）。这里钉两件事：
//   ① 片段字符集（白名单正则）—— 任何节点都不许渲染出引号 / 分号 / DDL 关键字；
//   ② 括号结构可复现 —— 同一棵树两次渲染逐字相同（渲染必须是纯函数）。
// 组合片段的期望串是**按渲染规则手推**的（见下方用例内注释），不是把产物粘回来 —— 粘回来 =
// 恒真断言，一文不值（Step 4「客单价逐字」同理）。
describe('exceedsNesting：入口结构预检（#593）', () => {
  const nest = (n: number) => { let v: unknown = 1; for (let i = 0; i < n; i++) v = { k: v }; return v }
  const nestArr = (n: number) => { let v: unknown = 1; for (let i = 0; i < n; i++) v = [v]; return v }

  it('恰好等于上限 ⇒ 放行；超一层 ⇒ 拦下', () => {
    expect(exceedsNesting(nest(MAX_BODY_NESTING))).toBe(false)
    expect(exceedsNesting(nest(MAX_BODY_NESTING + 1))).toBe(true)
  })
  it('数组与对象同权计深', () => {
    expect(exceedsNesting(nestArr(MAX_BODY_NESTING + 1))).toBe(true)
  })
  it('宽而浅不误伤（上限判的是深度，不是规模）', () => {
    const wide: Record<string, number> = {}
    for (let i = 0; i < 5000; i++) wide[`k${i}`] = i
    expect(exceedsNesting(wide)).toBe(false)
  })
  it('标量/空/null 边界', () => {
    expect(exceedsNesting(null)).toBe(false)
    expect(exceedsNesting(1)).toBe(false)
    expect(exceedsNesting({})).toBe(false)
    expect(exceedsNesting([])).toBe(false)
  })
  it('病态深（实测爆点量级）⇒ 拦下且不抛（迭代实现自己不会爆栈）', () => {
    expect(exceedsNesting(nest(3200))).toBe(true)
  })
})

describe('L2 · B 中档 · 逐节点可达集（增补 §6.1）', () => {
  const REF_EXPR = new Map([['a', 'sum(t.x)'], ['b', 'sum(t.y)']])
  const num = (v: number): ExprNode => ({ kind: 'num', value: v })
  const ref = (id: string): ExprNode => ({ kind: 'ref', id })

  // 片段白名单：只许标识符、点、括号、四则、空白、数字、**逗号**。
  // 逗号只可能来自编译器注入的 `NULLIF((分母), 0)` 守卫（div 支），不是输入 ⇒ 白名单的本意
  // 「不许出现引号 / 分号 / DDL 关键字」不受损；也正因如此 div **不必**从扫描里摘出去。
  const FRAGMENT_RE = /^[A-Za-z0-9_.()+\-*,\/\s]+$/

  it('每个 node kind 渲染出的片段只含白名单字符', () => {
    const nodes: ExprNode[] = [
      num(3), ref('a'),
      { kind: 'add', left: num(1), right: num(2) },
      { kind: 'sub', left: num(1), right: num(2) },
      { kind: 'mul', left: num(1), right: num(2) },
      { kind: 'div', left: num(1), right: num(2) },
    ]
    for (const n of nodes) {
      const sql = renderExprNode(n, REF_EXPR)
      expect(sql).toMatch(FRAGMENT_RE)
    }
  })

  it('NULLIF 只可能出现在 div 上（其它 kind 不注入守卫）', () => {
    expect(renderExprNode({ kind: 'add', left: num(1), right: num(2) }, REF_EXPR)).not.toContain('NULLIF')
    expect(renderExprNode({ kind: 'sub', left: num(1), right: num(2) }, REF_EXPR)).not.toContain('NULLIF')
    expect(renderExprNode({ kind: 'mul', left: num(1), right: num(2) }, REF_EXPR)).not.toContain('NULLIF')
    expect(renderExprNode({ kind: 'div', left: num(1), right: num(2) }, REF_EXPR)).toContain('NULLIF')
  })

  // 手推（不是粘贴产物）：`add/sub/mul → (左) op (右)`；`num 3 → 3`；`div → (左) / NULLIF((右), 0)`。
  // 于是这棵树 = `((sum(t.x)) + (3)) / NULLIF(((sum(t.y)) * (2)), 0)`。
  // ⚠️ 注意每层括号都算：ref 那支**不再**额外加括号，是它外面的算符支加的（故 `(sum(t.x))` 双层）。
  it('嵌套渲染的括号结构可复现（同一棵树两次渲染逐字相同）', () => {
    const tree: ExprNode = {
      kind: 'div',
      left: { kind: 'add', left: ref('a'), right: num(3) },
      right: { kind: 'mul', left: ref('b'), right: num(2) },
    }
    expect(renderExprNode(tree, REF_EXPR)).toBe('((sum(t.x)) + (3)) / NULLIF(((sum(t.y)) * (2)), 0)')
    expect(renderExprNode(tree, REF_EXPR)).toBe(renderExprNode(tree, REF_EXPR))
  })
})

// ── 随机树 fuzz：1200 棵随机树 = 可达集的**上界**抽样（增广补 §6.3）────────────────
// 穷举（上一个块）证明「每个节点单独安全」；这里证明「**组合起来**也安全」——
// 随机长树，但产物恒是纯 SELECT、恒能被 parseL1Select 认回、恒带 ` as value`。
// 确定性 PRNG（LCG，同一个种子长同一棵树）⇒ fuzz 一旦失败可逐字复现，不是「偶发」。
describe('L2 · B 中档 · 随机树 fuzz（增广补 §6.3）', () => {
  const base = l1()
  const catalog = [base, { ...base, id: 'standin:clone' }]
  const ids = catalog.map((m) => m.id)

  /** 确定性 PRNG（LCG）：同一个种子永远长同一棵树 —— fuzz 失败必须可复现。 */
  const makeRng = (seed: number) => {
    let s = seed >>> 0
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 0x100000000
    }
  }

  /**
   * 随机树：叶子按 rng 交替 ref/num；到 level≥5 就强制收成叶子（避免把树长到量纲闸上）。
   * `st.refSeen` 保证**整棵树至少含一个 ref**：首片叶子强制收成 ref。
   * 为什么必须：零 ref 的纯字面量树按设计会被 compileExpr 判 `BAD_DECL`（"拼不出 from 子句"，
   * 上面 :572 已有用例单独钉住这一条）—— 混进 fuzz 只会让 catch 分支因为**别的理由**炸，
   * 既遮蔽真实覆盖、又不增加任何新信息。所以 fuzz 的输入域是「至少一个 ref 的树」。
   */
  const randomExpr = (rng: () => number, level: number, st: { refSeen: boolean }): ExprNode => {
    if (level >= 5 || rng() < 0.25) {
      if (!st.refSeen) {
        st.refSeen = true
        return { kind: 'ref', id: ids[Math.floor(rng() * ids.length)]! }
      }
      return rng() < 0.6
        ? { kind: 'ref', id: ids[Math.floor(rng() * ids.length)]! }
        : { kind: 'num', value: Math.floor(rng() * 100) + 1 }
    }
    const ops = ['add', 'sub', 'mul', 'div'] as const
    return {
      kind: ops[Math.floor(rng() * ops.length)]!,
      left: randomExpr(rng, level + 1, st),
      right: randomExpr(rng, level + 1, st),
    }
  }

  it('≥1000 棵随机树：编译产物恒是纯 SELECT 且不含任何 DDL/DML 关键字', () => {
    let compiled = 0
    for (let i = 0; i < 1200; i++) {
      const rng = makeRng(0x5eed + i)
      const decl = { op: { kind: 'expr', expr: randomExpr(rng, 1, { refSeen: false }) } } as L2Declaration
      let out
      try {
        out = compileL2(catalog, decl)
      } catch (e) {
        // 只允许量纲闸把它拦下（深度/引用条数）；其它错误码是真缺陷
        expect((e as { code?: string }).code).toBe('EXPR_DEPTH_EXCEEDED')
        continue
      }
      compiled += 1
      expect(() => parseL1Select(out.selectSql)).not.toThrow()
      expect(out.selectSql).not.toMatch(FORBIDDEN_SQL_RE)
      expect(out.selectSql).toContain(' as value')
    }
    // 别让"全都被拦下"伪装成通过
    expect(compiled).toBeGreaterThan(900)
  })
})
