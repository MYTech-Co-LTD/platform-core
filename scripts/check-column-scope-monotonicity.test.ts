// scripts/check-column-scope-monotonicity.test.ts — 血缘单调门的夹具测试（issue #780）。
//
// 手法与 check-data-contract.test.ts 一致：**在临时目录里造一棵最小的假仓**，按判据逐条变异，
// 确认门禁**真的会红**（本仓规矩：一个从不红的判据等于没有判据）。
//
// ⚠️ 特意留了一条「**查不到漏申报**」的用例——那是本门的**已知弱点**（完整性要 contract→marts
//    的列级血缘，仓内不存在）。钉住它 = 谁哪天声称「这门能抓漏申报」时，这里会提醒他去看文件头注。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { checkColumnScopeMonotonicity } from './check-column-scope-monotonicity.mjs'

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/**
 * 造一棵最小假仓：一份契约（可选打标）+ 一份 L1 声明（可选 required_scope / reads）。
 *
 * @param {{ sensitivity?: string, reads?: string[], requiredScope?: string }} [opts]
 * @returns {string} 临时仓根
 */
function fixture(opts: { sensitivity?: string, reads?: string[], requiredScope?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'colscope-'))
  roots.push(root)
  mkdirSync(join(root, 'contracts', 'common'), { recursive: true })
  mkdirSync(join(root, 'dbt', 'semantics'), { recursive: true })

  writeFileSync(join(root, 'contracts', 'common', 'lemeng.item.json'), JSON.stringify({
    contractVersion: 2,
    domain: 'lemeng',
    table: 'item',
    owner: 'data-platform',
    layout: { prefix: 'lemeng/dim_item', partitionStyle: 'hive', partitionBy: ['bizday'], fileName: 'all.parquet' },
    batch: { markerColumn: 'batch_id', type: 'varchar' },
    schemaVersion: 1,
    consumerVersion: 1,
    columns: [{
      name: 'item_cost_price',
      type: 'decimal',
      precision: 14,
      scale: 2,
      nullable: true,
      ...(opts.sensitivity === undefined ? {} : { sensitivity: opts.sensitivity }),
    }],
  }, null, 2))

  const lines = [
    'metrics:',
    "  - name: 'lemeng:item:gross_rate'",
    '    label: 毛利率',
    '    definition: 测试用',
    "    expression: 'sum(fct_item.item_cost_price)'",
    '    grain: [bizday]',
    '    source: lemeng',
    '    freshness_sla_days: 2',
  ]
  if (opts.reads !== undefined) {
    lines.push(`    reads: [${opts.reads.map((r) => `'${r}'`).join(', ')}]`)
  }
  if (opts.requiredScope !== undefined) {
    lines.push(`    required_scope: ${opts.requiredScope}`)
  }
  writeFileSync(join(root, 'dbt', 'semantics', 'l1_metrics.yml'), `${lines.join('\n')}\n`)
  return root
}

const COL = 'lemeng.item.item_cost_price'

describe('血缘单调门：判据', () => {
  it('源列敏感 + 指标读了它 + 指标无 required_scope ⇒ 违规，且点名指标与源列', () => {
    const v = checkColumnScopeMonotonicity(fixture({ sensitivity: 'cost', reads: [COL] }))
    expect(v).toHaveLength(1)
    expect(v[0]?.message).toContain(COL)
    expect(v[0]?.message).toContain('gross_rate')
  })

  it('指标声明了 required_scope ⇒ 不违规', () => {
    expect(
      checkColumnScopeMonotonicity(fixture({ sensitivity: 'cost', reads: [COL], requiredScope: 'data:cost' })),
    ).toEqual([])
  })

  it('源列显式 none ⇒ 不违规', () => {
    expect(
      checkColumnScopeMonotonicity(fixture({ sensitivity: 'none', reads: [COL] })),
    ).toEqual([])
  })

  it('源列没打标（缺省 = none）⇒ 不违规', () => {
    expect(checkColumnScopeMonotonicity(fixture({ reads: [COL] }))).toEqual([])
  })

  it('指标没申报 reads ⇒ 不违规（**已知弱点**：本门查不到漏申报）', () => {
    expect(checkColumnScopeMonotonicity(fixture({ sensitivity: 'cost' }))).toEqual([])
  })

  it('reads 指向契约里不存在的源列 ⇒ 违规，且报的是「列不存在」而非「没声明 scope」', () => {
    const v = checkColumnScopeMonotonicity(fixture({ sensitivity: 'cost', reads: ['lemeng.item.no_such_col'] }))
    expect(v).toHaveLength(1)
    expect(v[0]?.message).toContain('no_such_col')
    // ⚠️ 这两句是**变异确认逼出来的**：只断言「提到 no_such_col」时，把「列不存在」那条分支关掉，
    //    代码会 fall through 到「没声明 required_scope」那条，同样产出一条提到 no_such_col 的违规
    //    ⇒ 用例照样绿。必须认**是哪一条**。
    expect(v[0]?.message).toContain('契约里没有这一列')
    expect(v[0]?.message).not.toContain('required_scope')
  })

  it('多个指标各自判，违规逐条报', () => {
    const root = fixture({ sensitivity: 'cost', reads: [COL] })
    // 追加第二条同样读敏感列、同样没声明的指标
    writeFileSync(join(root, 'dbt', 'semantics', 'l1_metrics.yml'), [
      'metrics:',
      "  - name: 'lemeng:item:gross_rate'",
      '    label: 毛利率',
      '    definition: 测试用',
      "    expression: 'sum(fct_item.item_cost_price)'",
      '    grain: [bizday]',
      '    source: lemeng',
      '    freshness_sla_days: 2',
      `    reads: ['${COL}']`,
      "  - name: 'lemeng:item:cost_ratio'",
      '    label: 成本占比',
      '    definition: 测试用',
      "    expression: 'sum(fct_item.item_cost_price)'",
      '    grain: [bizday]',
      '    source: lemeng',
      '    freshness_sla_days: 2',
      `    reads: ['${COL}']`,
      '',
    ].join('\n'))
    const v = checkColumnScopeMonotonicity(root)
    expect(v).toHaveLength(2)
    const joined = v.map((x) => x.message).join('\n')
    expect(joined).toContain('gross_rate')
    expect(joined).toContain('cost_ratio')
  })
})
