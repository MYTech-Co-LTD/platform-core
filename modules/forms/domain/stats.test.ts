import { describe, expect, it } from 'vitest'
import type { FieldDecl, StatsViewDecl } from './contract'
import { StatsError, compileStats, resolveViewRequest, suggestStatsViews } from './stats'

// 运营实时统计（件④ / #2755）：**纯函数**编译——白名单字段/聚合 → 参数化 SQL。
// 纪律：org 只来自调用方（identity），字段名先按声明白名单校验后才进 SQL（值一律参数化），
// 不开放任意 JSON path / 表达式。错误一律机检码（StatsError.code）。

const FIELDS: FieldDecl[] = [
  { field: 'class', kind: 'enum', agg: ['count'], groupable: true },
  { field: 'score', kind: 'number', agg: ['sum', 'avg', 'min', 'max', 'count'] },
  { field: 'name', kind: 'string', agg: ['count'] },
  { field: 'biz_date', kind: 'date', agg: ['min', 'max', 'count'], groupable: true },
]

const SCOPE = { org: 'acme' }

const code = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    if (e instanceof StatsError) return e.code
    throw e
  }
  throw new Error('expected StatsError')
}

describe('compileStats：白名单编译成参数化 SQL', () => {
  it('sum + groupBy 编译成参数化 SQL', () => {
    const { sql, params } = compileStats(
      { assetId: 'f', groupBy: ['class'], measures: [{ field: 'score', agg: 'sum' }], limit: 10 },
      { fields: FIELDS },
      SCOPE,
    )
    expect(sql).toContain("payload->>'class'")
    expect(sql).toContain("sum((payload->>'score')::numeric)")
    expect(sql).toContain('group by 1')
    expect(sql).toContain('order by 1')
    expect(params).toContain('f')
    expect(params[0]).toBe('acme') // org 永远来自调用方，永不来自请求体
    expect(params).toContain(10)
  })

  it('org/assetId 固定在最前；请求体里的 org 字段被忽略', () => {
    const { sql, params } = compileStats(
      { assetId: 'f', org: 'evil', measures: [{ field: 'score', agg: 'sum' }] } as never,
      { fields: FIELDS },
      SCOPE,
    )
    expect(params.slice(0, 2)).toEqual(['acme', 'f'])
    expect(params).not.toContain('evil')
    expect(sql).toContain("kind = 'form_def'")
  })

  it('avg/min/max/count 各有形态；count(*) 用 field *', () => {
    const { sql } = compileStats(
      {
        assetId: 'f',
        measures: [
          { field: 'score', agg: 'avg' },
          { field: 'score', agg: 'min' },
          { field: 'biz_date', agg: 'max' },
          { field: '*', agg: 'count' },
        ],
      },
      { fields: FIELDS },
      SCOPE,
    )
    expect(sql).toContain('avg((payload->>\'score\')::numeric) as avg_score')
    expect(sql).toContain('min((payload->>\'score\')::numeric) as min_score')
    expect(sql).toContain('max((payload->>\'biz_date\')::date) as max_biz_date')
    expect(sql).toContain('count(*) as "count"')
  })

  it('日期过滤按 Asia/Shanghai 日界换算（from 含当日、to 含当日）', () => {
    const { sql, params } = compileStats(
      {
        assetId: 'f',
        measures: [{ field: 'score', agg: 'sum' }],
        filter: { submittedFrom: '2026-11-01', submittedTo: '2026-11-23' },
      },
      { fields: FIELDS },
      SCOPE,
    )
    expect(sql).toContain("at time zone 'Asia/Shanghai'")
    expect(sql).toMatch(/submitted_at >= \(\$3::date/)
    expect(sql).toMatch(/submitted_at < \(\(\(\$4::date/)
    expect(params).toContain('2026-11-01')
    expect(params).toContain('2026-11-23')
  })

  it('非法日期 / from > to ⇒ STATS_BAD_FILTER', () => {
    expect(
      code(() =>
        compileStats(
          { assetId: 'f', measures: [{ field: 'score', agg: 'sum' }], filter: { submittedFrom: '2026/11/01' } },
          { fields: FIELDS },
          SCOPE,
        ),
      ),
    ).toBe('STATS_BAD_FILTER')
    expect(
      code(() =>
        compileStats(
          {
            assetId: 'f',
            measures: [{ field: 'score', agg: 'sum' }],
            filter: { submittedFrom: '2026-11-23', submittedTo: '2026-11-01' },
          },
          { fields: FIELDS },
          SCOPE,
        ),
      ),
    ).toBe('STATS_BAD_FILTER')
  })

  it('where 值参数化；in 用 = any($n::text[])；数值比较带 ::numeric', () => {
    const { sql, params } = compileStats(
      {
        assetId: 'f',
        groupBy: ['class'],
        measures: [{ field: 'score', agg: 'sum' }],
        filter: {
          where: [
            { field: 'class', op: 'in', value: ['A', 'B'] },
            { field: 'score', op: 'gte', value: 60 },
            { field: 'name', op: 'neq', value: 'x' },
          ],
        },
      },
      { fields: FIELDS },
      SCOPE,
    )
    expect(sql).toContain("payload->>'class' = any($3::text[])")
    expect(sql).toContain("(payload->>'score')::numeric >= $4::numeric")
    expect(sql).toContain("payload->>'name' <> $5")
    expect(params).toContainEqual(['A', 'B'])
    expect(params).toContain(60)
    expect(params).toContain('x')
  })

  it('不接受的 op / 非标量值 ⇒ STATS_BAD_FILTER', () => {
    for (const bad of [
      { field: 'class', op: 'like', value: 'A' },
      { field: 'class', op: 'eq', value: { a: 1 } },
      { field: 'score', op: 'gte', value: [1] },
    ]) {
      expect(
        code(() =>
          compileStats(
            { assetId: 'f', measures: [{ field: 'score', agg: 'sum' }], filter: { where: [bad] } } as never,
            { fields: FIELDS },
            SCOPE,
          ),
        ),
        JSON.stringify(bad),
      ).toBe('STATS_BAD_FILTER')
    }
  })
})

describe('compileStats：负对照（白名单与上限）', () => {
  const run = (input: Record<string, unknown>) => () =>
    compileStats(
      { assetId: 'f', measures: [{ field: 'score', agg: 'sum' }], ...input } as never,
      { fields: FIELDS },
      SCOPE,
    )

  it('未声明字段 ⇒ STATS_FIELD_NOT_ALLOWED（groupBy / measures / where 三处）', () => {
    expect(code(run({ groupBy: ['ghost'] }))).toBe('STATS_FIELD_NOT_ALLOWED')
    expect(code(run({ measures: [{ field: 'ghost', agg: 'sum' }] }))).toBe('STATS_FIELD_NOT_ALLOWED')
    expect(code(run({ filter: { where: [{ field: 'ghost', op: 'eq', value: 'x' }] } }))).toBe(
      'STATS_FIELD_NOT_ALLOWED',
    )
  })

  it('sum 用在 string 字段 ⇒ STATS_AGG_TYPE_MISMATCH（独立于契约闸）', () => {
    expect(
      code(() =>
        compileStats(
          { assetId: 'f', measures: [{ field: 'name', agg: 'sum' }] },
          { fields: [{ field: 'name', kind: 'string', agg: ['sum'] }] }, // 伪造的非法声明
          SCOPE,
        ),
      ),
    ).toBe('STATS_AGG_TYPE_MISMATCH')
  })

  it('字段未声明该 agg ⇒ STATS_AGG_NOT_ALLOWED', () => {
    expect(code(run({ measures: [{ field: 'class', agg: 'avg' }] }))).toBe('STATS_AGG_NOT_ALLOWED')
  })

  it('groupBy 非 groupable 字段 ⇒ STATS_NOT_GROUPABLE', () => {
    expect(code(run({ groupBy: ['score'] }))).toBe('STATS_NOT_GROUPABLE')
  })

  it('limit 超上限 / 非正整数 ⇒ STATS_LIMIT_TOO_LARGE', () => {
    expect(code(run({ limit: 10000 }))).toBe('STATS_LIMIT_TOO_LARGE')
    expect(code(run({ limit: 0 }))).toBe('STATS_LIMIT_TOO_LARGE')
    expect(code(run({ limit: 1.5 }))).toBe('STATS_LIMIT_TOO_LARGE')
  })

  it('in 列表 >50 ⇒ STATS_IN_TOO_LARGE', () => {
    expect(
      code(
        run({
          filter: {
            where: [{ field: 'class', op: 'in', value: Array.from({ length: 51 }, (_, i) => `v${i}`) }],
          },
        }),
      ),
    ).toBe('STATS_IN_TOO_LARGE')
  })

  it('groupBy >3 / measures >5 / where >10 ⇒ 各自机检码', () => {
    expect(code(run({ groupBy: ['class', 'class', 'class', 'class'] }))).toBe('STATS_TOO_MANY_GROUP_BY')
    expect(
      code(run({ measures: Array.from({ length: 6 }, () => ({ field: 'score', agg: 'sum' })) })),
    ).toBe('STATS_TOO_MANY_MEASURES')
    expect(
      code(
        run({
          filter: { where: Array.from({ length: 11 }, () => ({ field: 'class', op: 'eq', value: 'A' })) },
        }),
      ),
    ).toBe('STATS_TOO_MANY_WHERE')
  })

  it('没有任何 measure ⇒ STATS_NO_MEASURE', () => {
    expect(
      code(() => compileStats({ assetId: 'f', measures: [] }, { fields: FIELDS }, SCOPE)),
    ).toBe('STATS_NO_MEASURE')
  })
})

describe('resolveViewRequest：预声明视图 → 查询入参', () => {
  const views: StatsViewDecl[] = [
    {
      key: 'by_class',
      label: '按班级',
      groupBy: ['class'],
      measures: [{ field: 'score', agg: 'sum' }],
      filter: { where: [{ field: 'class', op: 'in', value: ['A', 'B'] }] },
    },
  ]

  it('viewId 命中 ⇒ groupBy/measures/filter 取自视图；请求只覆盖日期窗', () => {
    const resolved = resolveViewRequest(
      { assetId: 'f', viewId: 'by_class', filter: { submittedFrom: '2026-11-01' } },
      views,
    )
    expect(resolved.groupBy).toEqual(['class'])
    expect(resolved.measures).toEqual([{ field: 'score', agg: 'sum' }])
    expect(resolved.filter?.where).toEqual([{ field: 'class', op: 'in', value: ['A', 'B'] }])
    expect(resolved.filter?.submittedFrom).toBe('2026-11-01')
  })

  it('viewId 不存在 ⇒ STATS_VIEW_NOT_FOUND', () => {
    expect(code(() => resolveViewRequest({ assetId: 'f', viewId: 'nope' }, views))).toBe('STATS_VIEW_NOT_FOUND')
  })

  it('无 viewId ⇒ 原样返回（ad-hoc 高级模式）', () => {
    const input = { assetId: 'f', groupBy: ['class'], measures: [{ field: 'score', agg: 'sum' } as const] }
    expect(resolveViewRequest(input, views)).toEqual(input)
  })
})

describe('suggestStatsViews：确定性兜底（AI 同创统计）', () => {
  it('数值字段 → sum/avg；enum/boolean/date → 可分组；至少一条合计视图', () => {
    const out = suggestStatsViews({
      type: 'object',
      properties: {
        class: { type: 'string', enum: ['A', 'B'], title: '班级' },
        score: { type: 'number', title: '得分' },
        done: { type: 'boolean' },
        bizDate: { type: 'string', format: 'date' },
      },
    })
    expect(out).not.toBeNull()
    const { fields, views } = out!
    expect(fields.find((f) => f.field === 'score')).toMatchObject({ kind: 'number', groupable: false })
    for (const g of ['class', 'done', 'bizDate']) {
      expect(fields.find((f) => f.field === g)?.groupable, g).toBe(true)
    }
    const total = views.find((v) => v.key === 'total')
    expect(total?.groupBy).toEqual([])
    expect(total?.measures).toEqual(
      expect.arrayContaining([
        { field: 'score', agg: 'sum' },
        { field: 'score', agg: 'avg' },
      ]),
    )
    // 每个可分组字段一条一维视图
    expect(views.find((v) => v.groupBy?.[0] === 'class')?.label).toBe('按班级')
    expect(views.find((v) => v.groupBy?.[0] === 'bizDate')).toBeDefined()
  })

  it('不猜自由文本字段做分组；数组/嵌套不摊平（date-time 按 string 计数，不分组）', () => {
    const out = suggestStatsViews({
      type: 'object',
      properties: {
        note: { type: 'string' },
        photos: { type: 'array', items: { type: 'string' } },
        nested: { type: 'object', properties: { x: { type: 'string' } } },
        at: { type: 'string', format: 'date-time' },
      },
    })
    expect(out).not.toBeNull()
    expect(out!.fields.map((f) => f.field)).toEqual(['note', 'at'])
    expect(out!.fields[0]).toMatchObject({ kind: 'string', groupable: false, agg: ['count'] })
    expect(out!.fields[1]).toMatchObject({ kind: 'string', groupable: false, agg: ['count'] })
    expect(out!.views).toEqual([
      { key: 'total', label: '合计', groupBy: [], measures: [{ field: 'note', agg: 'count' }] },
    ])
  })

  it('完全没有可统计字段 ⇒ null（不产空 dataPlane）', () => {
    expect(suggestStatsViews({ type: 'object', properties: { photos: { type: 'array', items: { type: 'string' } } } })).toBeNull()
    expect(suggestStatsViews({ type: 'object' })).toBeNull()
    expect(suggestStatsViews(null)).toBeNull()
  })

  it('产出的 dataPlane 能过 compileGate（表单 + 统计同创）', async () => {
    const { compileGate } = await import('./contract')
    const schema = {
      type: 'object',
      properties: {
        class: { type: 'string', enum: ['A', 'B'] },
        score: { type: 'number' },
        photos: { type: 'array', items: { type: 'string' } },
      },
    }
    const out = suggestStatsViews(schema)!
    const gate = compileGate({ schema, dataPlane: { fields: out.fields, stats: { enabled: true, views: out.views } } })
    expect(gate).toEqual({ ok: true })
  })
})
