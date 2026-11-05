// private-measure.test.ts — W2 私有测度档（`basis='column_agg'`）的编译与三闸。
//
// 本文件钉的是**「列级单聚合」能变成合法 L1 同形 SQL，且只能作用在白名单内的关系/列上**：
//   ① 编译形状：与 L1 同一份形状契约（`parseL1Select`）——运行期 authorize/掩码/行域零新路径；
//   ② 三道 fail-closed 闸：relation ∈ L1 已用 marts / column ∈ 实际列 / dims 合法；
//   ③ 白名单**每次现算**（不跨请求缓存）——L1 变更后不得用陈旧集合放行。
//
// 「私有测度不可被 L2 ref 引用」的断言在 semantic-compiler.test.ts（resolveL1Base 的归属），
// 本文件只钉住「column_agg 行不授予白名单」这一侧（两处合起来才是完整的单向门）。
import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import type { MetricRow } from './metric-store'
import {
  FORBIDDEN_SQL_RE,
  SemanticCompileError,
  compileColumnAgg,
  parseL1Select,
  COLUMN_AGG_FUNCS,
} from './semantic-compiler'
import type { ColumnAggFunc } from './semantic-compiler'
import { loadRelationColumns, validatePrivateMeasure } from './private-measure'
import type { PrivateMeasureDeps, RelationColumn } from './private-measure'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

/** L1 夹具（形状 = sync 物化的产物；本档只关心 select_sql/关系/掩码三面）。 */
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
    sourceSystem: 'lemeng',
    updatedBy: null,
    version: 1,
    totalable: false,
    slaDays: 1,
    freshnessRelations: [],
    masks: null,
    entity: null,
    synonyms: [],
    certified: 'certified',
    createdBy: null,
    bizDescription: null,
    unit: null,
    caliberNote: null,
    basis: 'l1_tree',
    archivedAt: null,
    ...over,
  }
}

/** 一个 L1 词表：净销售额 + 订单数（同关系），关系白名单 = `fct_retail_sale`。 */
const L1_CATALOG: MetricRow[] = [
  l1(),
  l1({
    id: 'lemeng:retail:order_count',
    title: '订单数',
    selectSql: 'select sum(fct_retail_sale.order_count) as value, system_book, bizday from fct_retail_sale',
  }),
]

/** 替身实际列（information_schema 的**归一形状**：name + data_type）。 */
const COLUMNS: RelationColumn[] = [
  { name: 'org', dataType: 'text' },
  { name: 'system_book', dataType: 'text' },
  { name: 'bizday', dataType: 'date' },
  { name: 'branch_num', dataType: 'text' },
  { name: 'net_amount', dataType: 'numeric' },
  { name: 'order_count', dataType: 'integer' },
  { name: 'cost', dataType: 'numeric' },
]

/** 注入了两个加载器的 deps（本文件的纯用例都不碰真库）。 */
function deps(
  catalog: readonly MetricRow[] = L1_CATALOG,
  columns: readonly RelationColumn[] = COLUMNS,
  over: Partial<PrivateMeasureDeps> = {},
): PrivateMeasureDeps {
  return {
    // 两个加载器都注入 ⇒ pool 不被触达（真池只在默认路径用）
    pool: {} as Pool,
    loadCatalog: async () => [...catalog],
    loadColumns: async () => [...columns],
    ...over,
  }
}

const input = (over: Record<string, unknown> = {}) => ({
  agg: 'sum' as ColumnAggFunc,
  column: 'net_amount',
  dims: ['system_book'],
  relation: 'fct_retail_sale',
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

// ── ① 编译形状 ────────────────────────────────────────────────────────────────
describe('compileColumnAgg：列级单聚合 → L1 同形 select_sql', () => {
  it('sum + 无维度：形状与 L1 逐字同形（`select <expr> as value from <relation>`）', () => {
    expect(compileColumnAgg({ agg: 'sum', column: 'net_amount', dims: [], relation: 'fct_retail_sale' }))
      .toEqual({
        selectSql: 'select sum(net_amount) as value from fct_retail_sale',
        groupBy: '',
        subjectColumn: 'org',
        params: {},
      })
  })

  it('sum + 维度：维度按给定顺序进 SELECT 与 GROUP BY（同 L1 的 grain 拼法）', () => {
    expect(compileColumnAgg({
      agg: 'sum', column: 'net_amount',
      dims: ['system_book', 'bizday'], relation: 'fct_retail_sale',
    })).toEqual({
      selectSql: 'select sum(net_amount) as value, system_book, bizday from fct_retail_sale',
      groupBy: 'system_book, bizday',
      subjectColumn: 'org',
      params: { bizday: { type: 'date_range', column: 'bizday' } },
    })
  })

  it('#1417：dims 含 bizday ⇒ 产出 date_range 参数（否则私有测度只能全时段累计）', () => {
    expect(compileColumnAgg({
      agg: 'sum', column: 'order_count',
      dims: ['system_book', 'bizday', 'branch_num'], relation: 'fct_branch_day_activity',
    }).params).toEqual({ bizday: { type: 'date_range', column: 'bizday' } })
    expect(compileColumnAgg({
      agg: 'sum', column: 'order_count', dims: ['branch_num'], relation: 'fct_branch_day_activity',
    }).params).toEqual({})
  })

  it('count_distinct 映射为 count(distinct <col>)（不是自己的函数名）', () => {
    expect(compileColumnAgg({ agg: 'count_distinct', column: 'branch_num', relation: 'fct_retail_sale' }).selectSql)
      .toBe('select count(distinct branch_num) as value from fct_retail_sale')
  })

  it('闭集内的每个聚合函数都映射成显式 SQL 函数（表驱动，防漏一个）', () => {
    const expected: Record<ColumnAggFunc, string> = {
      sum: 'sum(net_amount)', count: 'count(net_amount)', avg: 'avg(net_amount)',
      min: 'min(net_amount)', max: 'max(net_amount)', count_distinct: 'count(distinct net_amount)',
    }
    for (const agg of COLUMN_AGG_FUNCS) {
      expect(compileColumnAgg({ agg, column: 'net_amount', relation: 'fct_retail_sale' }).selectSql)
        .toBe(`select ${expected[agg]} as value from fct_retail_sale`)
    }
    expect(Object.keys(expected).sort()).toEqual([...COLUMN_AGG_FUNCS].sort())
  })

  it('★ 编译产物必须过同一份形状契约（parseL1Select）——这是「零新运行期路径」的可机检落点', () => {
    for (const agg of COLUMN_AGG_FUNCS) {
      for (const dims of [[], ['system_book'], ['system_book', 'bizday']] as const) {
        const out = compileColumnAgg({ agg, column: 'net_amount', dims, relation: 'fct_retail_sale' })
        const parsed = parseL1Select(out.selectSql)
        expect(parsed.relation).toBe('fct_retail_sale')
        expect(parsed.expression).toBe(out.selectSql.slice('select '.length, out.selectSql.indexOf(' as value')))
      }
    }
  })

  it('保留字列名/维度名加双引号（裸拼会被当语法关键字），产物仍过 parseL1Select', () => {
    const out = compileColumnAgg({
      agg: 'sum', column: 'order', dims: ['group', 'column'], relation: 'fct_retail_sale',
    })
    expect(out.selectSql).toBe('select sum("order") as value, "group", "column" from fct_retail_sale')
    expect(out.groupBy).toBe('"group", "column"')
    expect(parseL1Select(out.selectSql).relation).toBe('fct_retail_sale')
  })

  it('schema 限定的关系名可编译（单租户/私有化形态）', () => {
    expect(compileColumnAgg({ agg: 'sum', column: 'x', relation: 'dbt.fct_x' }).selectSql)
      .toBe('select sum(x) as value from dbt.fct_x')
  })

  it('dims 去重但保序（重复维度不进 GROUP BY 两次）', () => {
    const out = compileColumnAgg({
      agg: 'sum', column: 'net_amount',
      dims: ['bizday', 'system_book', 'bizday'], relation: 'fct_retail_sale',
    })
    expect(out.groupBy).toBe('bizday, system_book')
  })

  it('产物永不含写/DDL 关键字、不以分号收尾（禁任意 SQL 的可机检落点）', () => {
    const out = compileColumnAgg({ agg: 'sum', column: 'net_amount', dims: ['system_book'], relation: 'fct_retail_sale' })
    expect(FORBIDDEN_SQL_RE.test(out.selectSql)).toBe(false)
    expect(out.selectSql.includes(';')).toBe(false)
  })

  it('注入面 fail-closed：非标识符的 column / dims / relation 一律抛 BAD_COLUMN_AGG', () => {
    const cases: Array<Record<string, unknown>> = [
      { column: 'net_amount; drop table x' },
      { column: 'net amount' },
      { column: 'sum(net_amount)' },
      { column: '' },
      { relation: 'fct_retail_sale; --' },
      { relation: 'fct_retail_sale, other' },
      { relation: '' },
      { dims: ['system_book) or 1=1 --'] },
      { dims: ['system book'] },
      { dims: 'system_book' },
    ]
    for (const over of cases) {
      expectThrow(() => compileColumnAgg({ ...input(), ...over } as never), 'BAD_COLUMN_AGG')
    }
  })

  it('聚合函数不在闭集 ⇒ 抛 BAD_COLUMN_AGG（不猜、不放宽）', () => {
    expectThrow(() => compileColumnAgg({ ...input(), agg: 'median' } as never), 'BAD_COLUMN_AGG')
    expectThrow(() => compileColumnAgg({ ...input(), agg: undefined } as never), 'BAD_COLUMN_AGG')
  })
})

// ── ② 三道闸（判别式结果，不抛）────────────────────────────────────────────────
describe('validatePrivateMeasure：白名单 + 实际列 + 维度约束（fail-closed）', () => {
  it('全过 ⇒ {ok:true}', async () => {
    expect(await validatePrivateMeasure(deps(), input())).toEqual({ ok: true })
  })

  it('闸①：relation 不在 L1 已用 marts ⇒ RELATION_NOT_ALLOWED', async () => {
    const out = await validatePrivateMeasure(deps(), input({ relation: 'fct_unknown' }))
    expect(out).toMatchObject({ ok: false, code: 'RELATION_NOT_ALLOWED' })
  })

  it('闸①：L1 的坏 select_sql 不授予任何关系（坏行跳过，不抛、不放行）', async () => {
    const bad = l1({ selectSql: 'not a select at all' })
    const out = await validatePrivateMeasure(deps([bad]), input())
    expect(out).toMatchObject({ ok: false, code: 'RELATION_NOT_ALLOWED' })
  })

  it('闸①：column_agg 行永不进 L1 白名单（即使它写着 source=l1）', async () => {
    // 脏数据形态：source 是 l1 但档是 column_agg ⇒ 不授予关系（单向门，防私有测度自举）
    const dirty = l1({ basis: 'column_agg' })
    const out = await validatePrivateMeasure(deps([dirty]), input())
    expect(out).toMatchObject({ ok: false, code: 'RELATION_NOT_ALLOWED' })
  })

  it('★ 白名单每次现算：第一次过、L1 撤掉后第二次必须拒（无跨请求缓存）', async () => {
    let catalog: MetricRow[] = [...L1_CATALOG]
    const d = deps([], COLUMNS, { loadCatalog: async () => catalog })
    expect(await validatePrivateMeasure(d, input())).toEqual({ ok: true })
    catalog = []
    expect(await validatePrivateMeasure(d, input())).toMatchObject({ ok: false, code: 'RELATION_NOT_ALLOWED' })
  })

  it('闸②：measure 列不在实际列里 ⇒ COLUMN_NOT_FOUND', async () => {
    const out = await validatePrivateMeasure(deps(), input({ column: 'no_such_col' }))
    expect(out).toMatchObject({ ok: false, code: 'COLUMN_NOT_FOUND' })
  })

  it('闸②：sum/avg/min/max 要求数值列 ⇒ 文本列给 COLUMN_NOT_NUMERIC', async () => {
    for (const agg of ['sum', 'avg', 'min', 'max'] as const) {
      const out = await validatePrivateMeasure(deps(), input({ agg, column: 'system_book' }))
      expect(out, `agg=${agg}`).toMatchObject({ ok: false, code: 'COLUMN_NOT_NUMERIC' })
    }
  })

  it('闸②：count / count_distinct 不要求数值（文本列可数）', async () => {
    expect(await validatePrivateMeasure(deps(), input({ agg: 'count', column: 'branch_num' })))
      .toEqual({ ok: true })
    expect(await validatePrivateMeasure(deps(), input({ agg: 'count_distinct', column: 'branch_num' })))
      .toEqual({ ok: true })
  })

  it('闸③：任一 dim 不在实际列里 ⇒ DIM_NOT_FOUND（点名是哪一列）', async () => {
    const out = await validatePrivateMeasure(deps(), input({ dims: ['system_book', 'no_such_dim'] }))
    expect(out).toMatchObject({ ok: false, code: 'DIM_NOT_FOUND' })
    expect((out as { detail?: string }).detail).toContain('no_such_dim')
  })

  it('闸③：dims 不得含 measure 列 ⇒ DIM_IS_MEASURE', async () => {
    const out = await validatePrivateMeasure(deps(), input({ dims: ['net_amount'] }))
    expect(out).toMatchObject({ ok: false, code: 'DIM_IS_MEASURE' })
  })

  it('闸③（spec §4.2-3）：dims 不得含被掩码的列 ⇒ DIM_MASKED', async () => {
    const masked = l1({
      masks: [{ column: 'fct_retail_sale.cost', kind: 'nullify', grantedBy: 'data:precise' }],
    })
    const out = await validatePrivateMeasure(deps([masked]), input({ dims: ['cost'] }))
    expect(out).toMatchObject({ ok: false, code: 'DIM_MASKED' })
  })

  it('★ 闸②：measure 列被掩码 ⇒ MEASURE_MASKED（限定名声明；裸列名聚合运行期命中不了）', async () => {
    const masked = l1({
      masks: [{ column: 'fct_retail_sale.cost', kind: 'round', step: 3, grantedBy: 'data:precise' }],
    })
    // cost 是数值列（类型闸会过）⇒ 拒的理由只能是掩码，不是 COLUMN_NOT_NUMERIC。
    const out = await validatePrivateMeasure(deps([masked]), input({ agg: 'sum', column: 'cost', dims: [] }))
    expect(out).toMatchObject({ ok: false, code: 'MEASURE_MASKED' })
    expect((out as { detail?: string }).detail).toContain('fct_retail_sale.cost')
  })

  it('★ 闸②：掩码目标无关系前缀 ⇒ 视为同关系（保守拒）；前缀是别的关系 ⇒ 不拒', async () => {
    const unqualified = l1({
      masks: [{ column: 'cost', kind: 'nullify', grantedBy: 'data:precise' }],
    })
    expect(await validatePrivateMeasure(deps([unqualified]), input({ agg: 'sum', column: 'cost', dims: [] })))
      .toMatchObject({ ok: false, code: 'MEASURE_MASKED' })

    const otherRelation = l1({
      masks: [{ column: 'fct_other.cost', kind: 'nullify', grantedBy: 'data:precise' }],
    })
    expect(await validatePrivateMeasure(deps([otherRelation]), input({ agg: 'sum', column: 'cost', dims: [] })))
      .toEqual({ ok: true })
  })

  it('★ 闸②：该关系上有整值掩码的 L1 ⇒ RELATION_MASKED（整值不进 L2 mask_spec，运行期无法传播）', async () => {
    const whole = l1({
      masks: [{ column: null, kind: 'nullify', grantedBy: 'data:precise' }],
    })
    const out = await validatePrivateMeasure(deps([whole]), input({ agg: 'sum', column: 'net_amount', dims: [] }))
    expect(out).toMatchObject({ ok: false, code: 'RELATION_MASKED' })
  })

  it('关系在 L1 白名单但库侧看不到任何列 ⇒ COLUMNS_UNAVAILABLE（环境/可见性问题，不是用户列名错）', async () => {
    const out = await validatePrivateMeasure(deps(L1_CATALOG, []), input())
    expect(out).toMatchObject({ ok: false, code: 'COLUMNS_UNAVAILABLE' })
  })

  it('输入形状错 ⇒ BAD_INPUT；聚合函数越界 ⇒ UNKNOWN_AGG（分类码可机检）', async () => {
    expect(await validatePrivateMeasure(deps(), input({ agg: 'median' })))
      .toMatchObject({ ok: false, code: 'UNKNOWN_AGG' })
    for (const bad of [
      input({ column: 42 }),
      input({ relation: 'fct; drop table x' }),
      input({ dims: 'system_book' }),
      input({ dims: ['system book'] }),
      null,
    ]) {
      expect(await validatePrivateMeasure(deps(), bad as never)).toMatchObject({ ok: false, code: 'BAD_INPUT' })
    }
  })

  it('默认加载器路径不接受「未配置数据面」的含混成功：deps 无 warehouse 且无 loadColumns 时抛（不静默放行）', async () => {
    // 本机没配 DATA_WAREHOUSE_URL ⇒ warehousePool() 抛 DATA_WAREHOUSE_UNCONFIGURED；
    // 该错误必须**冒出**（调用方把它当 500），绝不能被折成 ok。
    const prev = process.env.DATA_WAREHOUSE_URL
    process.env.DATA_WAREHOUSE_URL = ''
    try {
      await expect(validatePrivateMeasure(deps(L1_CATALOG, COLUMNS, { loadColumns: undefined }), input()))
        .rejects.toThrow(/DATA_WAREHOUSE_UNCONFIGURED|数据面/)
    } finally {
      if (prev === undefined) delete process.env.DATA_WAREHOUSE_URL
      else process.env.DATA_WAREHOUSE_URL = prev
    }
  })
})

// ── ③ 默认列加载器真的读 information_schema（需要 DATABASE_URL）──────────────────
describePg('loadRelationColumns：读 mart 实际列（需要 DATABASE_URL）', () => {
  // 本机/CI 用 DATABASE_URL 兜底（生产是两个库：平台 platform / 数据面 warehouse——形参由调用方给）
  const wh = new Pool({ connectionString: process.env.DATA_WAREHOUSE_URL ?? dbUrl })
  const SCHEMA = 'pm_standin'

  afterAll(async () => {
    await wh.query(`drop schema if exists ${SCHEMA} cascade`).catch(() => {})
    expect(wh.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await wh.end().catch(() => {})
  })

  async function seed() {
    await wh.query(`drop schema if exists ${SCHEMA} cascade`)
    await wh.query(`create schema ${SCHEMA}`)
    await wh.query(`create table ${SCHEMA}.fct_retail_sale (
      org text not null, system_book text, bizday date, net_amount numeric(12,2), order_count integer)`)
  }

  it('返回实际列名与类型（不含从不存在的列）', async () => {
    await seed()
    const cols = await loadRelationColumns(wh, `${SCHEMA}.fct_retail_sale`)
    expect(cols.map((c) => c.name)).toEqual(['org', 'system_book', 'bizday', 'net_amount', 'order_count'])
    expect(cols.find((c) => c.name === 'net_amount')?.dataType).toBe('numeric')
    expect(cols.find((c) => c.name === 'order_count')?.dataType).toBe('integer')
    expect(cols.find((c) => c.name === 'bizday')?.dataType).toBe('date')
  })

  it('不存在的 schema/表 ⇒ 空数组（调用方据此给 COLUMNS_UNAVAILABLE，不抛）', async () => {
    expect(await loadRelationColumns(wh, `${SCHEMA}.no_such_table`)).toEqual([])
  })

  it('非标识符关系名被拒（本函数也可被单独调用，不靠上游校验）', async () => {
    await expect(loadRelationColumns(wh, `${SCHEMA}.fct; drop table x`)).rejects.toThrow()
    await expect(loadRelationColumns(wh, 'a.b.c')).rejects.toThrow()
  })
})
