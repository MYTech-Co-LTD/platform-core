// scripts/gen-data-projection.test.ts — 契约生成器的夹具测试（tmpdir 假仓，不碰真库/真仓）。
//
// 手法与 check-data-contract.test.ts 同源：在临时目录里造一棵最小假仓（契约 + 生产者管线 +
// 投影节点），再按判据逐条变异，确认生成器**真的会红**（本仓规矩：一个从不红的判据等于没有判据）。
// ⚠️ 假仓里的管线**必须带 `snk.*` 节点**——生成器用 B10 规则② 的判据找生产者
//    （`findProducerPipelines` 只认写了 prefix 的 `snk.*`），只放 `code.sql` 定位不到。

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import {
  buildPipelineSelect,
  buildStagingSelect,
  extractPipelineExprs,
  rewriteSelectList,
  runGenerate,
  sqlType,
} from './gen-data-projection.mjs'

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/**
 * 造一棵最小假仓：一份契约 + 一条生产者管线（含投影节点与 `snk.*`）。
 *
 * @param {Record<string, string>} expr 列名 → 投影表达式（契约序 = 该对象的键序）
 * @param {{ contractHasExpr?: boolean }} [opts]
 * @returns {string} 临时仓根
 */
function fixture(expr: Record<string, string>, opts: { contractHasExpr?: boolean } = {}): string {
  const names = Object.keys(expr)
  const root = mkdtempSync(join(tmpdir(), 'gdp-'))
  roots.push(root)
  mkdirSync(join(root, 'contracts/common'), { recursive: true })
  mkdirSync(join(root, 'deploy/duckle/console/pipelines'), { recursive: true })
  const cols = names.map((n) => ({
    name: n,
    type: 'varchar',
    nullable: true,
    ...(opts.contractHasExpr === false ? {} : { expr: expr[n] }),
  }))
  writeFileSync(
    join(root, 'contracts/common/x.y.json'),
    JSON.stringify(
      {
        contractVersion: 2,
        schemaVersion: 1,
        consumerVersion: 1,
        domain: 'x',
        table: 'y',
        owner: 't',
        layout: { prefix: 'x/y', partitionStyle: 'hive', partitionBy: [names[0]], fileName: 'all.parquet' },
        batch: { markerColumn: names[0], type: 'varchar' },
        columns: cols,
      },
      null,
      2,
    ),
  )
  const select = 'SELECT\n' + names.map((n) => `  ${expr[n]} AS ${n}`).join(',\n')
  writeFileSync(
    join(root, 'deploy/duckle/console/pipelines/x.y.p.json'),
    JSON.stringify(
      {
        nodes: [
          {
            id: 'flat',
            data: {
              componentId: 'code.sql',
              properties: { sql: `${select}\nFROM input o\nCROSS JOIN UNNEST(x) AS u(d)` },
            },
          },
          {
            id: 'snk',
            data: { componentId: 'snk.minio', properties: { bucket: 'b', key: 'x/y/system_book=1/all.parquet' } },
          },
        ],
      },
      null,
      2,
    ),
  )
  return root
}

describe('生成器 ③', () => {
  it('selectListBounds/rewrite 只换列区，FROM 之后逐字不动', () => {
    const sql = 'SELECT\n  a AS x\nFROM input o\nCROSS JOIN UNNEST(y) AS u(d)'
    const next = rewriteSelectList(sql, buildPipelineSelect([{ name: 'x', expr: 'CAST(b AS INT)' }]))
    expect(next).toBe('SELECT\n  CAST(b AS INT) AS x\nFROM input o\nCROSS JOIN UNNEST(y) AS u(d)')
  })

  it('extractPipelineExprs 从现有投影反抽 expr', () => {
    const sql = 'SELECT\n  a AS x,\n  CAST(f(g), 2) AS y\nFROM input o'
    expect(extractPipelineExprs(sql)).toEqual({ x: 'a', y: 'CAST(f(g), 2)' })
  })

  it('契约已有 expr ⇒ 生成 == 现有（幂等，零 diff）', () => {
    const root = fixture({ x: 'CAST(a AS VARCHAR)', y: "'lit'" })
    expect(runGenerate(root, { check: true })).toBe(0)
  })

  it('契约 expr 与投影不一致 ⇒ --check 非零', () => {
    const root = fixture({ x: 'CAST(a AS VARCHAR)', y: "'lit'" })
    const f = join(root, 'deploy/duckle/console/pipelines/x.y.p.json')
    const d = JSON.parse(readFileSync(f, 'utf8'))
    d.nodes[0].data.properties.sql = d.nodes[0].data.properties.sql.replace("'lit'", "'other'")
    writeFileSync(f, JSON.stringify(d, null, 2))
    expect(runGenerate(root, { check: true })).toBe(1)
  })
})

describe('生成器 ④', () => {
  it('类型映射：decimal→numeric、integer→int、varchar 原样', () => {
    expect(sqlType({ type: 'decimal' })).toBe('numeric')
    expect(sqlType({ type: 'integer' })).toBe('int')
    expect(sqlType({ type: 'varchar' })).toBe('varchar')
  })

  it('org 注入在 system_book 之后，其它列按契约序', () => {
    const out = buildStagingSelect(
      [
        { name: 'batch_id', type: 'varchar' },
        { name: 'system_book', type: 'varchar' },
        { name: 'amt', type: 'decimal' },
      ],
      'system_book',
    )
    expect(out).toBe(
      "select\n  r['batch_id']::varchar as batch_id,\n  r['system_book']::varchar as system_book,\n  {{ subject_org() }}       as org,\n  r['amt']::numeric as amt",
    )
  })
})
