import { describe, expect, it } from 'vitest'
import { accountOf, buildPipelineMap } from './pipeline-map'

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
    expect(asset.pipelines[0]).toMatchObject({ cron: '0 5 * * *', enabled: true, account: '3120' })
    expect(asset.pipelines[1]).toMatchObject({ cron: null, enabled: false, account: '64188' })
  })

  it('没有 staging 的资产标 null（断点）并给告警', () => {
    const m = buildPipelineMap({
      ...base,
      pipelines: [{ id: 'lemeng/no_staging.l0', lakeKeys: ['lemeng/no_staging/bizday=1/all.parquet'] }],
      schedules: new Map(),
    })
    expect(m.assets[0]).toMatchObject({ lake: 'lemeng/no_staging', staging: null, marts: [] })
    expect(m.warnings.join('\n')).toContain('没有对应的 staging 模型')
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

  it('accountOf：尾段是数字才算账套', () => {
    expect(accountOf('lemeng.x.l0.3120')).toBe('3120')
    expect(accountOf('lemeng.retail.tick.l1')).toBeNull()
  })
})
