import { describe, expect, it } from 'vitest'
import { buildMetricLineage, plainDescription } from './lineage'

const BASE = {
  metricId: 'lemeng:retail:net_sales',
  title: '净销售额',
  contract: {
    id: 'lemeng.retail_order_line',
    columns: [
      { name: 'bizday', type: 'date', description: '**业务日**（hive 分区键）' },
      { name: 'sale_money', type: 'numeric', description: '销售金额' },
      { name: 'order_total_money', type: 'numeric', description: '整单金额（staging 不用）' },
    ],
    layout: { prefix: 'lemeng/retail_order_line', partitionBy: ['system_book', 'bizday', 'hour'], fileName: 'all.parquet', partitionStyle: 'hive' },
  },
  staging: {
    model: 'stg_lemeng_retail_order_line',
    columns: [
      { name: 'bizday', description: '业务日，显式 cast 回 date' },
      { name: 'sale_money', description: '销售金额（透传）' },
      { name: 'org', description: '主体列（dbt 注入）' },
    ],
  },
  marts: {
    model: 'fct_retail_sale',
    columns: [
      { name: 'bizday', description: '业务日' },
      { name: 'sale_amount', description: '销售侧金额' },
      { name: 'net_amount', description: '净销售额 = sale_amount − return_amount' },
    ],
  },
} as const

describe('buildMetricLineage', () => {
  it('三层字段与状态：源层丢掉 order_total_money；staging 新增 org；marts 聚合出金额', () => {
    const l = buildMetricLineage(BASE as never)
    expect(l.source.columns.map((c) => [c.name, c.status])).toEqual([
      ['bizday', 'passthrough'],
      ['sale_money', 'passthrough'],
      ['order_total_money', 'dropped'],
    ])
    expect(l.staging.columns.find((c) => c.name === 'org')?.status).toBe('added')
    expect(l.marts.columns.find((c) => c.name === 'sale_amount')?.status).toBe('aggregate')
    expect(l.marts.columns.find((c) => c.name === 'bizday')?.status).toBe('passthrough')
  })

  it('湖形态取自契约 layout（前缀/分区/文件名/分区风格）', () => {
    const l = buildMetricLineage(BASE as never)
    expect(l.lake).toEqual({
      prefix: 'lemeng/retail_order_line',
      partitions: ['system_book', 'bizday', 'hour'],
      fileName: 'all.parquet',
      partitionStyle: 'hive',
    })
  })

  it('缺声明 ⇒ 空清单 + note（未知 ≠ 没有），不编字段', () => {
    const l = buildMetricLineage({
      metricId: 'm', title: 't', contract: null,
      staging: { model: 'stg_x', columns: [] },
      marts: { model: 'fct_x', columns: [] },
    })
    expect(l.source.columns).toEqual([])
    expect(l.lake).toBeNull()
    expect(l.notes.length).toBe(3)
  })

  it('描述去 markdown 记号并收敛空白', () => {
    expect(plainDescription(' **业务日**（hive\n  分区键） ')).toBe('业务日（hive 分区键）')
  })
})
