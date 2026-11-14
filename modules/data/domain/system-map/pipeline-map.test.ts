import { describe, expect, it } from 'vitest'
import { accountOf, buildPipelineMap, lakeConsumers, liveStatusOf } from './pipeline-map'

const base = {
  staging: ['stg_lemeng_retail_order_line', 'stg_lemeng_branch_expense'],
  marts: [
    { name: 'fct_retail_sale', refs: ['stg_lemeng_retail_order_line'] },
    { name: 'fct_retail_profit', refs: ['stg_lemeng_retail_order_line', 'stg_lemeng_branch_expense'] },
  ],
}

describe('buildPipelineMap', () => {
  it('三层对齐：资产 → staging（命名约定）→ marts（ref 反查）', () => {
    const m = buildPipelineMap({
      ...base,
      pipelines: [
        { id: 'lemeng.retail_order_line.l0.3120', lakeKeys: ['lemeng/retail_order_line/system_book=${ENV:SYSTEM_BOOK}/bizday=${date-1d}/all.parquet'] },
        { id: 'lemeng.retail_order_line.l0.64188', lakeKeys: ['lemeng/retail_order_line/system_book=${ENV:SYSTEM_BOOK}/all.parquet'] },
      ],
      schedules: new Map([
        ['lemeng.retail_order_line.l0.3120', [{ source: '3120', cron: '0 5 * * *', enabled: true }]],
      ]),
    })
    const asset = m.assets.find((a) => a.lake === 'lemeng/retail_order_line')!
    expect(asset.staging).toBe('stg_lemeng_retail_order_line')
    expect(asset.marts).toEqual(['fct_retail_profit', 'fct_retail_sale'])
    expect(asset.pipelines.map((p) => p.id)).toEqual([
      'lemeng.retail_order_line.l0.3120', 'lemeng.retail_order_line.l0.64188',
    ])
    // 有调度的那条带 cron；没有调度记录的那条 enabled=false（不是「已停用」，是「没登记」）
    expect(asset.pipelines[0]).toMatchObject({ cron: '0 5 * * *', enabled: true, account: '3120', scheduled: true })
    expect(asset.pipelines[1]).toMatchObject({ cron: null, enabled: false, account: '64188', scheduled: false })
  })

  it('没有 staging 的资产标 null（断点）并给告警', () => {
    const m = buildPipelineMap({
      ...base,
      pipelines: [{ id: 'lemeng/no_staging.l0', lakeKeys: ['lemeng/no_staging/bizday=1/all.parquet'] }],
      schedules: new Map(),
    })
    expect(m.assets[0]).toMatchObject({ lake: 'lemeng/no_staging', staging: null, marts: [] })
    expect(m.warnings.join('\n')).toContain('没有 staging 也没有视图消费')
  })

  it('孤儿 staging：有模型但没有任何管线写它', () => {
    const m = buildPipelineMap({
      ...base,
      pipelines: [{ id: 'lemeng/retail_order_line', lakeKeys: ['lemeng/retail_order_line/a.parquet'] }],
      schedules: new Map(),
    })
    // 注意：pipeline id 用点号；这里只验证 staging 侧判定
    expect(m.orphanStaging).toEqual(['stg_lemeng_branch_expense'])
  })

  it('同一资产被多账套管线写 ⇒ 合并成一个资产节点', () => {
    const m = buildPipelineMap({
      ...base,
      pipelines: [
        { id: 'lemeng/branch_expense.l0.3120', lakeKeys: ['lemeng/branch_expense/bizday=1/all.parquet'] },
        { id: 'lemeng/branch_expense.l0.64188', lakeKeys: ['lemeng/branch_expense/bizday=1/all.parquet'] },
      ],
      schedules: new Map(),
    })
    expect(m.assets).toHaveLength(1)
    expect(m.assets[0]!.pipelines).toHaveLength(2)
  })

  it('契约优先：lemeng/dim_branch 的 staging 是 stg_lemeng_branch（命名约定会误判成断点）', () => {
    const m = buildPipelineMap({
      pipelines: [{ id: 'lemeng.dim.branch.l0', lakeKeys: ['lemeng/dim_branch/snapshot=1/all.parquet'] }],
      schedules: new Map(),
      contractLakes: new Map([['stg_lemeng_branch', 'lemeng/dim_branch']]),
      staging: ['stg_lemeng_branch'],
      marts: [],
    })
    expect(m.assets[0]).toMatchObject({ lake: 'lemeng/dim_branch', staging: 'stg_lemeng_branch' })
    expect(m.orphanStaging).toEqual([])
    expect(m.warnings).toEqual([])
  })

  it('有视图消费 ⇒ 不算断点（retail_order_line_month 这类只给 drill 用的资产）', () => {
    const m = buildPipelineMap({
      pipelines: [{ id: 'lemeng.retail_order_line.month.compact', lakeKeys: ['lemeng/retail_order_line_month/_MONTH/a.parquet'] }],
      schedules: new Map(),
      contractLakes: new Map(),
      consumers: new Map([['lemeng/retail_order_line_month', ['vw_lemeng_retail_order_line']]]),
      staging: [],
      marts: [],
    })
    expect(m.assets[0]).toMatchObject({ staging: null, views: ['vw_lemeng_retail_order_line'] })
    expect(m.warnings).toEqual([])
  })

  it('lakeConsumers：先展开 var，且前缀必须整段命中（item 不命中 item_price）', () => {
    const models = [
      { name: 'vw_a', sql: "from read_parquet('s3://{{ var(\"zos_bucket\") }}/{{ var(\"lemeng_item_prefix\") }}/*/a.parquet')" },
      { name: 'vw_b', sql: "from read_parquet('s3://b/lemeng/item_price/*/a.parquet')" },
    ]
    const out = lakeConsumers(models, ['lemeng/item', 'lemeng/item_price'], { lemeng_item_prefix: 'lemeng/dim_item' })
    expect(out.get('lemeng/item_price')).toEqual(['vw_b'])
    expect(out.get('lemeng/item')).toBeUndefined() // dim_item 与 item 是两条前缀，别互相串
  })

  it('summary 由 domain 出数：assets / withStaging / broken / unscheduled 与规则一致', () => {
    const m = buildPipelineMap({
      ...base,
      pipelines: [
        { id: 'lemeng/retail_order_line.l0', lakeKeys: ['lemeng/retail_order_line/a.parquet'] },
        { id: 'lemeng/no_staging.l0', lakeKeys: ['lemeng/no_staging/a.parquet'] },
        { id: 'lemeng/dim.branch.l0', lakeKeys: ['lemeng/dim_branch/a.parquet'] },
      ],
      schedules: new Map([['lemeng/retail_order_line.l0', [{ source: '3120', cron: '0 5 * * *', enabled: true }]]]),
      contractLakes: new Map([['stg_lemeng_branch', 'lemeng/dim_branch']]),
      consumers: new Map([['lemeng/no_staging', ['vw_x']]]),
      staging: ['stg_lemeng_retail_order_line', 'stg_lemeng_branch'],
    })
    expect(m.summary).toEqual({ assets: 3, withStaging: 2, broken: 0, orphans: 2, parentDriven: 0 })
  })

  it('父驱动的管线不算「未接入」（retail_order_line.day 由 windows.l1 每日调用）', () => {
    const m = buildPipelineMap({
      ...base,
      pipelines: [{ id: 'lemeng.retail_order_line.day', lakeKeys: ['lemeng/retail_order_line/a.parquet'] }],
      schedules: new Map(),
      contractLakes: new Map(),
      parents: new Map([['lemeng.retail_order_line.day', ['lemeng.retail.windows.l1']]]),
      staging: ['stg_lemeng_retail_order_line'],
    })
    expect(m.assets[0]!.pipelines[0]).toMatchObject({ driver: 'parent', parentIds: ['lemeng.retail.windows.l1'] })
    expect(m.summary).toMatchObject({ orphans: 0, parentDriven: 1 })
  })

  it('liveStatusOf：父驱动取父的状态（子管线自身记录陈旧不算数）', () => {
    const child = { id: 'c', driver: 'parent' as const, parentIds: ['p'] }
    const runs = { c: [{ status: 'failed' }], p: [{ status: 'ok' }] }
    expect(liveStatusOf(child, runs)).toBe('ok')
    expect(liveStatusOf({ id: 'c', driver: 'schedule' as const, parentIds: [] }, runs)).toBe('failed')
    expect(liveStatusOf({ id: 'x', driver: 'parent' as const, parentIds: ['gone'] }, {})).toBe('unknown')
  })

  it('accountOf：尾段是数字才算账套', () => {
    expect(accountOf('lemeng.x.l0.3120')).toBe('3120')
    expect(accountOf('lemeng.retail.tick.l1')).toBeNull()
  })
})
