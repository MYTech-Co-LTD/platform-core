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
  rewriteAllSelectLists,
  rewriteSelectList,
  runGenerate,
  seedContractText,
  selectListBoundsAll,
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

// ── 多投影位点（2026-10-20，architecture.md §5.3 冷/热两种布局）──────────────────
// 判据必须能变异确认：①两位点都重写；②单投影时与 rewriteSelectList 逐字等价；
// ③选列区里有嵌套 select ⇒ 抛错而非猜（否则内层 select 会被一起重写、静默写坏）。
describe('rewriteAllSelectLists（多投影位点）', () => {
  // ⚠️ 不能带前置 CTE：那会被当成第 1 个位点、选列区跨到主 FROM ⇒ 被「嵌套 select」安全阀拦下
  //    （staging 模型就是两个平铺 select，无 CTE；见 gen-data-projection.mjs 的同名注释）
  const twoSites = [
    'select',
    '  r[\'a\'] as a',
    'from read_parquet(\'cold\') r',
    'union all',
    'select',
    '  r[\'a\'] as a',
    'from read_parquet(\'hot\') r',
    'where not exists (select 1 from read_parquet(\'m\') m)',
    '',
  ].join('\n')

  it('两位点都被重写，FROM 及其后逐字保留', () => {
    expect(selectListBoundsAll(twoSites)).toHaveLength(2)
    const out = rewriteAllSelectLists(twoSites, 'NEW')
    expect(out.match(/NEW/g)).toHaveLength(2)
    expect(out).toContain("from read_parquet('cold') r")
    expect(out).toContain("from read_parquet('hot') r")
    expect(out).toContain("where not exists (select 1 from read_parquet('m') m)")
  })

  it('单个位点时与 rewriteSelectList 逐字等价', () => {
    const one = ['select', "  r['a'] as a", "from read_parquet('p') r", ''].join('\n')
    expect(rewriteAllSelectLists(one, 'NEW')).toBe(rewriteSelectList(one, 'NEW'))
  })

  it('选列区里有嵌套 select ⇒ 抛错（不猜）', () => {
    const nested = ['select', '  (select max(z) from t) as a', "from read_parquet('p') r", ''].join('\n')
    expect(() => selectListBoundsAll(nested)).toThrow(/嵌套 select/)
  })
})

// ── 视图面（2026-10-21，明细读面 Phase 0 / Task 1）─────────────────────────────────
// 视图 `vw_*` 的列区必须**与 staging 同源**（同一个 `buildStagingSelect`）。两份列清单各写一份
// 迟早漂开：漂开不会报错，只会让视图多/少一列，然后下游按名字取列时才炸。
// 视图模型由 Task 2 创建 ⇒ 本任务对「不存在的视图文件」**静默跳过**。

/** 视图骨架里的两处投影位点（冷/热两段平铺 select，与真仓 staging 同形、不带前置 CTE）。 */
function twoSite(selectList: string): string {
  return [
    selectList,
    "from read_parquet('cold') r",
    'union all',
    selectList,
    "from read_parquet('hot') r",
    '',
  ].join('\n')
}

/** 视图骨架的占位列区：故意与生成物不同（生成器必须把它覆盖掉）。 */
const VIEW_SKELETON_COLS = "  r['sale_money']::varchar as sale_money"

/**
 * 在既有假仓上补「staging 模型（已归一）+ 视图骨架（占位列区）」。
 * staging 写成**已归一**态，是为了让两条视图用例的成败只取决于视图面：
 * 否则 staging 自身待改会先把 `--check` 弄红，用例就成了空转绿。
 */
function fixtureWithViewSkeleton(): string {
  const root = fixture({
    batch_id: 'CAST(a AS VARCHAR)',
    system_book: 'CAST(b AS VARCHAR)',
    sale_money: 'CAST(c AS VARCHAR)',
  })
  const cols = [
    { name: 'batch_id', type: 'varchar' },
    { name: 'system_book', type: 'varchar' },
    { name: 'sale_money', type: 'varchar' },
  ]
  mkdirSync(join(root, 'dbt/models/x/staging'), { recursive: true })
  mkdirSync(join(root, 'dbt/models/common/views'), { recursive: true })
  writeFileSync(
    join(root, 'dbt/models/x/staging/stg_x_y.sql'),
    twoSite(buildStagingSelect(cols, 'system_book')),
  )
  writeFileSync(join(root, 'dbt/models/common/views/vw_x_y.sql'), twoSite(`select\n${VIEW_SKELETON_COLS}`))
  return root
}

/** 模型里每一处投影位点的列区文本（多位点时逐个比，不能只比第一处）。 */
function selectListsOf(sql: string): string[] {
  return selectListBoundsAll(sql).map((b) => sql.slice(b.selectStart, b.fromStart))
}

describe('生成器 ④b（视图面）', () => {
  it('视图面：vw_ 模型的 SELECT 列表与 staging 同源生成', () => {
    const root = fixtureWithViewSkeleton()
    const code = runGenerate(root, {})
    const view = readFileSync(join(root, 'dbt/models/common/views/vw_x_y.sql'), 'utf8')
    const stg = readFileSync(join(root, 'dbt/models/x/staging/stg_x_y.sql'), 'utf8')
    // 列区与 staging 逐字相同（同一 buildStagingSelect），且两处位点都是
    expect(selectListsOf(view)).toEqual(selectListsOf(stg))
    expect(view).not.toContain('sale_money_x')
    expect(view).toContain("  {{ subject_org() }}       as org,")
    expect(code).toBe(0)
  })

  it('视图面：手改视图列区 ⇒ --check 报红', () => {
    const root = fixtureWithViewSkeleton()
    // 先到稳态（staging/管线/视图都 == 生成物），再把改动只落在视图上
    runGenerate(root, {})
    const p = join(root, 'dbt/models/common/views/vw_x_y.sql')
    writeFileSync(p, readFileSync(p, 'utf8').replace('as sale_money', 'as sale_money_x'))
    expect(runGenerate(root, { check: true })).toBe(1)
  })
})

describe('selectListBoundsAll：内联子查询不算投影位点', () => {
  it('where … not exists (select 1 from …) 不被当成第 3 个位点', () => {
    const sql = [
      'select',
      "  r['a'] as a",
      "from read_parquet('cold') r",
      'union all',
      'select',
      "  r['a'] as a",
      "from read_parquet('hot') r",
      "where not exists (select 1 from read_parquet('m') m where m.b = r['b'])",
      '',
    ].join('\n')
    expect(selectListBoundsAll(sql)).toHaveLength(2)
  })
})
