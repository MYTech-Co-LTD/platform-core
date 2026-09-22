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
  SemanticCompileError,
  compileL2,
  dimensionNamesOf,
  parseL1Select,
  resolveL1Base,
} from './semantic-compiler'

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
    id: 'retail:net_sales',
    title: '净销售额',
    description: '有效零售订单的成交金额合计',
    requiredScope: null,
    subjectColumn: 'org',
    selectSql: 'select sum(fct_retail_sale.net_amount) as value, system_book, bizday from fct_retail_sale',
    groupBy: 'system_book, bizday',
    params: {},
    source: 'l1',
    ...over,
  }
}

/** L1 词表：两条声明（第二条用来验「维度只属于自己那条」）。 */
const L1_CATALOG: MetricRow[] = [
  l1(),
  l1({
    id: 'retail:order_count',
    title: '订单数',
    selectSql: 'select sum(fct_retail_sale.order_count) as value, system_book, bizday from fct_retail_sale',
  }),
]

/** 最小合法声明；各用例只覆盖自己关心的字段。 */
const decl = (over: Partial<Parameters<typeof compileL2>[1]> = {}) => ({
  baseMetric: 'retail:net_sales',
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
    expect(resolveL1Base(L1_CATALOG, 'retail:net_sales').title).toBe('净销售额')
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
    const base = resolveL1Base(L1_CATALOG, 'retail:net_sales')
    expectThrow(
      () => compileL2(base, decl({ op: { kind: 'expression' } as unknown as { kind: 'refine' } })),
      'OP_UNSUPPORTED',
    )
  })

  it('filters 的维度名不在 L1 声明 ⇒ 抛 UNKNOWN_DIM（并点名是哪个维度）', () => {
    const base = resolveL1Base(L1_CATALOG, 'retail:net_sales')
    expectThrow(
      () => compileL2(base, decl({ filters: [{ dim: 'store_id', op: '=', values: ['S1'] }] })),
      'UNKNOWN_DIM',
    )
  })

  it('visibility 的维度名不在 L1 声明 ⇒ 抛 UNKNOWN_DIM', () => {
    const base = resolveL1Base(L1_CATALOG, 'retail:net_sales')
    expectThrow(
      () => compileL2(base, decl({ visibility: { dims: ['system_book', 'store_id'] } })),
      'UNKNOWN_DIM',
    )
  })

  it('维度名不是标识符（想借维度名注入）⇒ 抛 UNKNOWN_DIM', () => {
    const base = resolveL1Base(L1_CATALOG, 'retail:net_sales')
    expectThrow(
      () => compileL2(base, decl({ visibility: { dims: ['system_book) or 1=1 --'] } })),
      'UNKNOWN_DIM',
    )
  })

  it('= 只许一个值、in 至少要一个值 ⇒ 否则抛 BAD_FILTER', () => {
    const base = resolveL1Base(L1_CATALOG, 'retail:net_sales')
    expectThrow(() => compileL2(base, decl({ filters: [{ dim: 'bizday', op: '=', values: [] }] })), 'BAD_FILTER')
    expectThrow(
      () => compileL2(base, decl({ filters: [{ dim: 'bizday', op: '=', values: ['a', 'b'] }] })),
      'BAD_FILTER',
    )
    expectThrow(() => compileL2(base, decl({ filters: [{ dim: 'bizday', op: 'in', values: [] }] })), 'BAD_FILTER')
  })
})

describe('compileL2：产物形状', () => {
  it('不声明 visibility ⇒ 维度继承 L1 的 grain，标题仍是 L1 标题', () => {
    const base = resolveL1Base(L1_CATALOG, 'retail:net_sales')
    const { selectSql, title, groupBy } = compileL2(base, decl())
    expect(title).toBe('净销售额')
    expect(selectSql).toBe('select sum(fct_retail_sale.net_amount) as value, system_book, bizday from fct_retail_sale')
    // groupBy 一并回：落库要它（data.metrics.group_by 必填），且必须与 SELECT 的维度同源
    expect(groupBy).toBe('system_book, bizday')
  })

  it('groupBy 与 SELECT 的可见维度**同源**（裁剪后两边一起变，不会各说各话）', () => {
    const base = resolveL1Base(L1_CATALOG, 'retail:net_sales')
    const { selectSql, groupBy } = compileL2(base, decl({ visibility: { dims: ['bizday'] } }))
    expect(groupBy).toBe('bizday')
    expect(selectSql).toContain(', bizday')
    expect(selectSql).not.toContain('system_book')
  })

  it('visibility 重复维度去重（同一个维度写两遍不该让 SELECT 出现重复列）', () => {
    const base = resolveL1Base(L1_CATALOG, 'retail:net_sales')
    const { selectSql, groupBy } = compileL2(base, decl({ visibility: { dims: ['bizday', 'bizday'] } }))
    expect(groupBy).toBe('bizday')
    expect(selectSql).toBe('select sum(fct_retail_sale.net_amount) as value, bizday from fct_retail_sale')
  })

  it('filters 形态下 groupBy 也回可见维度（派生表那支同样不能漏）', () => {
    const base = resolveL1Base(L1_CATALOG, 'retail:net_sales')
    const { groupBy } = compileL2(base, decl({
      visibility: { dims: ['system_book'] },
      filters: [{ dim: 'bizday', op: '=', values: ['2026-01-01'] }],
    }))
    expect(groupBy).toBe('system_book')
  })

  it('alias ⇒ 标题换成别名（口径不变，只是换个叫法）', () => {
    const base = resolveL1Base(L1_CATALOG, 'retail:net_sales')
    expect(compileL2(base, decl({ alias: '熊喵净销售' })).title).toBe('熊喵净销售')
  })

  it('visibility.dims 裁掉维度（裁剪只少不多）', () => {
    const base = resolveL1Base(L1_CATALOG, 'retail:net_sales')
    const { selectSql } = compileL2(base, decl({ visibility: { dims: ['system_book'] } }))
    expect(selectSql).toContain('system_book')
    expect(selectSql).not.toContain('bizday')
  })

  it('visibility.dims 空数组 ⇒ 只出汇总值（不带任何维度）', () => {
    const base = resolveL1Base(L1_CATALOG, 'retail:net_sales')
    const { selectSql } = compileL2(base, decl({ visibility: { dims: [] } }))
    expect(selectSql).toBe('select sum(fct_retail_sale.net_amount) as value from fct_retail_sale')
  })

  it('L2 不改 L1 口径：值表达式逐字来自 base（不是 L2 自己写的）', () => {
    const base = resolveL1Base(L1_CATALOG, 'retail:net_sales')
    const { selectSql } = compileL2(base, decl({ alias: 'x', visibility: { dims: ['bizday'] } }))
    expect(selectSql).toContain('sum(fct_retail_sale.net_amount) as value')
  })

  it('filters 走 FROM 派生表：值表达式与关系名原样保留（schema 限定形态也不破）', () => {
    const base = resolveL1Base(L1_CATALOG, 'retail:net_sales')
    const { selectSql } = compileL2(base, decl({ filters: [{ dim: 'system_book', op: '=', values: ['3120'] }] }))
    // 派生表里带过滤，外层再聚合 ⇒ 值表达式的限定名仍然可解析（派生表没改关系名）
    expect(selectSql).toContain('from (select sum(fct_retail_sale.net_amount) as value, system_book, bizday, org')
    expect(selectSql).toContain("where system_book = '3120'")
    expect(selectSql).toContain('group by system_book, bizday, org')
  })

  it('filter 值单引号双写（走 authz 的 sqlQuote 单一实现，不另写转义）', () => {
    const base = resolveL1Base(L1_CATALOG, 'retail:net_sales')
    const { selectSql } = compileL2(base, decl({ filters: [{ dim: 'system_book', op: '=', values: ["a'b"] }] }))
    expect(selectSql).toContain(`= ${sqlQuote("a'b")}`)
  })

  it('★ 产物是纯 SELECT：无分号、无 DDL/DML 关键字（禁任意 SQL 的可机检落点）', () => {
    const base = resolveL1Base(L1_CATALOG, 'retail:net_sales')
    const outputs = [
      compileL2(base, decl()).selectSql,
      compileL2(base, decl({ visibility: { dims: [] } })).selectSql,
      compileL2(base, decl({ filters: [{ dim: 'bizday', op: 'in', values: ['2026-01-01', '2026-01-02'] }] })).selectSql,
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
  const standinBase = (): MetricDef =>
    resolveL1Base(
      [l1({
        selectSql: `select sum(${SCHEMA}.fct_retail_sale.net_amount) as value, system_book, bizday from ${SCHEMA}.fct_retail_sale`,
      })],
      'retail:net_sales',
    )

  /** 与 domain/authz.ts 的 authorize 同形地拼出最终 SQL（主体钉死 + 可选 GROUP BY + LIMIT）。 */
  const authorizeLike = (m: MetricDef, org: string, groupBy: string) =>
    `${m.selectSql} WHERE ${m.subjectColumn} = ${sqlQuote(org)}` +
    (groupBy ? ` GROUP BY ${groupBy}` : '') + ' LIMIT 1000'

  it('无 filters/无 visibility：按 L1 grain 出数，且只出本租户（主体钉死）', async () => {
    await seedStandin()
    const base = standinBase()
    const { selectSql } = compileL2(base, decl())
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
    const { selectSql } = compileL2(base, decl({ visibility: { dims: ['system_book'] } }))
    const sql = authorizeLike({ ...base, selectSql }, 'acme', 'system_book')

    const r = await pool.query(sql)
    expect(r.rowCount).toBe(2)
    expect(Number(r.rows.find((x) => x.system_book === '3120').value)).toBe(150)
    expect(Number(r.rows.find((x) => x.system_book === '64188').value)).toBe(7)
  })

  it('filters 走派生表：过滤生效、且仍然只出本租户', async () => {
    await seedStandin()
    const base = standinBase()
    const { selectSql } = compileL2(base, decl({
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
    const { selectSql } = compileL2(base, decl({
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
    const { selectSql } = compileL2(base, decl({ visibility: { dims: [] } }))
    const sql = authorizeLike({ ...base, selectSql }, 'acme', '')

    const r = await pool.query(sql)
    expect(r.rowCount).toBe(1)
    expect(Number(r.rows[0].value)).toBe(157)
  })
})
