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
  seedContractText,
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
  it('整数族**逐列保宽**：integer→int、bigint→bigint、smallint→smallint', () => {
    // 塌成 `int` 会把契约的 bigint 列静默窄化（实测 3000000000::BIGINT::int 直接 out of range）。
    expect(sqlType({ type: 'integer' })).toBe('int')
    expect(sqlType({ type: 'bigint' })).toBe('bigint')
    expect(sqlType({ type: 'smallint' })).toBe('smallint')
  })

  it('decimal 带 precision/scale ⇒ numeric(p,s)；缺则裸 numeric', () => {
    // 塌成裸 `numeric` 在 DuckDB 是 DECIMAL(18,3)，会把 (18,8) 静默截到 3 位小数。
    expect(sqlType({ type: 'decimal', precision: 18, scale: 8 })).toBe('numeric(18,8)')
    expect(sqlType({ type: 'decimal', precision: 14, scale: 2 })).toBe('numeric(14,2)')
    expect(sqlType({ type: 'decimal' })).toBe('numeric')
  })

  it('其余类型逐字照抄契约', () => {
    expect(sqlType({ type: 'varchar' })).toBe('varchar')
    expect(sqlType({ type: 'boolean' })).toBe('boolean')
    expect(sqlType({ type: 'date' })).toBe('date')
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

  it('decimal(p,s)、bigint、boolean 在列区里逐列照抄类型', () => {
    const out = buildStagingSelect(
      [
        { name: 'created_by', type: 'bigint' },
        { name: 'flag', type: 'boolean' },
        { name: 'price', type: 'decimal', precision: 18, scale: 8 },
      ],
      'created_by',
    )
    expect(out).toBe(
      "select\n  r['created_by']::bigint as created_by,\n  {{ subject_org() }}       as org,\n  r['flag']::boolean as flag,\n  r['price']::numeric(18,8) as price",
    )
  })
})

describe('生成器 --seed（反抽 expr 回填契约）', () => {
  it('从现存投影回填**缺失**的 expr（多行列对象形态）', () => {
    const root = fixture({ x: 'CAST(a AS VARCHAR)', y: "'lit'" }, { contractHasExpr: false })
    const rel = join(root, 'contracts/common/x.y.json')
    expect(JSON.parse(readFileSync(rel, 'utf8')).columns.every((c: { expr?: string }) => c.expr === undefined)).toBe(
      true,
    )
    expect(runGenerate(root, { seed: true })).toBe(0)
    const cols = JSON.parse(readFileSync(rel, 'utf8')).columns as { name: string; expr?: string }[]
    expect(cols.find((c) => c.name === 'x')?.expr).toBe('CAST(a AS VARCHAR)')
    expect(cols.find((c) => c.name === 'y')?.expr).toBe("'lit'")
    // 回填后：生成 == 现存投影（③ 零 diff）
    expect(runGenerate(root, { check: true })).toBe(0)
  })

  it('单行列对象形态也支持（真契约的形态）', () => {
    const text = '{\n  "columns": [\n    { "name": "a", "type": "varchar" },\n    { "name": "b", "type": "varchar" }\n  ]\n}\n'
    const out = seedContractText(text, { a: 'CAST(x AS VARCHAR)' })
    expect(out).toBe(
      '{\n  "columns": [\n    { "name": "a", "type": "varchar", "expr": "CAST(x AS VARCHAR)" },\n    { "name": "b", "type": "varchar" }\n  ]\n}\n',
    )
    expect(JSON.parse(out).columns[0].expr).toBe('CAST(x AS VARCHAR)')
  })

  it('已有 expr 不覆盖，且重复跑幂等（只填空缺项）', () => {
    const root = fixture({ x: 'CAST(a AS VARCHAR)', y: "'lit'" }, { contractHasExpr: false })
    runGenerate(root, { seed: true })
    const rel = join(root, 'contracts/common/x.y.json')
    const afterFirst = readFileSync(rel, 'utf8')
    expect(runGenerate(root, { seed: true })).toBe(0)
    expect(readFileSync(rel, 'utf8')).toBe(afterFirst)
  })

  it('目标列定位不到 ⇒ 抛错（不产半成品）', () => {
    expect(() => seedContractText('{ "columns": [ { "name": "a", "type": "varchar" } ] }', { missing: 'x' })).toThrow(
      /找不到列 missing/,
    )
  })
})
