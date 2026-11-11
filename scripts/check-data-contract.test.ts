// scripts/check-data-contract.test.ts — 数据契约注册门禁的夹具测试。
//
// 手法与 check-data-plane-lock.test.ts 一致：**在临时目录里造一棵最小的假仓**，然后按判据逐条
// 变异，确认门禁**真的会红**（本仓规矩：一个从不红的判据等于没有判据）。
// 取列器另有一组单元用例——它要能同时认对「投影列」和**不认**「类型名 / 表别名」。

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

import {
  checkDataContract,
  crossFieldViolations,
  extractPipelineAliases,
  extractStagingAliases,
} from './check-data-contract.mjs'

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/** 列集：契约 / 管线 / staging 三处同源，改一处即应红。 */
const COLS = ['batch_id', 'system_book', 'bizday', 'amount']

/**
 * 造一棵最小假仓。`over` 里的字段用来做变异。
 *
 * @param {{ contractCols?: string[], pipelineCols?: string[], stagingCols?: string[],
 *           schemaVersion?: number | null, consumerVersion?: number | null,
 *           pipelineText?: string, sinkKey?: string,
 *           srcSchema?: Array<{name: string, type: string}>,
 *           sensitivity?: Record<string, string> }} [over]
 * @returns {string} 临时仓根
 */
function fixture(over: {
  contractCols?: string[]
  pipelineCols?: string[]
  stagingCols?: string[]
  schemaVersion?: number | null
  consumerVersion?: number | null
  pipelineText?: string
  extraProjection?: 'same' | 'different'
  sinkKey?: string
  srcSchema?: Array<{ name: string, type: string }>
  sensitivity?: Record<string, string>
} = {}): string {
  const cc = over.contractCols ?? COLS
  const pc = over.pipelineCols ?? cc
  const sc = over.stagingCols ?? cc
  const contract: Record<string, unknown> = {
    contractVersion: 1,
    domain: 'x',
    table: 'y',
    owner: 't',
    layout: { prefix: 'x/y', partitionStyle: 'hive', partitionBy: ['bizday'], fileName: 'all.parquet' },
    batch: { markerColumn: 'batch_id', type: 'varchar' },
    columns: cc.map((name) => ({
      // 分区键列不得 nullable=true（§4.2 ⑥）——夹具的 `bizday` 就是分区键，故这里显式非空
      name, type: 'varchar', nullable: name !== 'bizday',
      ...(over.sensitivity?.[name] ? { sensitivity: over.sensitivity[name] } : {}),
    })),
  }
  const sv = over.schemaVersion === undefined ? 1 : over.schemaVersion
  if (sv !== null) contract.schemaVersion = sv
  const cv = over.consumerVersion === undefined ? sv : over.consumerVersion
  if (cv !== null) contract.consumerVersion = cv

  /** 契约投影 SQL（逐页投影形态下 N 个节点共用同一条）。 */
  const flatSql =
    over.pipelineText ??
    `SELECT ${pc.map((c) => `CAST(b.${c} AS VARCHAR) AS ${c}`).join(', ')}\n` +
      `FROM input b CROSS JOIN UNNEST(from_json(CAST(b.d AS JSON), '["JSON"]')) AS u(d)`

  const pipeline = {
    nodes: [
      // 数据链：src.rest → ctl.merge → flat（新判据 ④ 只看 `ctl.merge` 的直接 src.rest 父）
      { id: 'src1', data: { componentId: 'src.rest', schema: over.srcSchema ?? [...pc.map((c) => ({ name: c, type: 'string' })), { name: 'd', type: 'json' }] } },
      { id: 'mrg', data: { componentId: 'ctl.merge' } },
      {
        id: 'flat',
        data: {
          componentId: 'code.sql',
          properties: {
            // 故意混入两种**不是投影列**的形态：`CAST(x AS JSON)`（大写类型名）与
            // `AS u(d)`（表别名带括号）——取列器必须都不认。
            sql: flatSql,
          },
        },
      },
      // 逐页投影形态：第二个也命中契约的 code.sql（`same` = 同一条 SQL ⇒ 合法；
      // `different` = 另一条也命中的 SQL ⇒ 两套投影各说各话，必须红）
      ...(over.extraProjection
        ? [
            {
              id: 'flat2',
              data: {
                componentId: 'code.sql',
                properties: { sql: over.extraProjection === 'same' ? flatSql : `${flatSql}\n-- variant` },
              },
            },
          ]
        : []),
      // 另一个 code.sql 节点（守卫/回执），列集与契约不同 —— 必须**不被**当成投影
      { id: 'summ', data: { componentId: 'code.sql', properties: { sql: "SELECT 'r' AS run_token, 'ok' AS status" } }, },
      // 生产者是靠**文本里出现 prefix** 机械推导的；真实管线由 sink 的 key 承载它
      { id: 'sink', data: { componentId: 'snk.minio', properties: { key: over.sinkKey ?? 'x/y/bizday=${D}/all.parquet' } } },
    ],
    edges: [
      { id: 'e1', source: 'src1', target: 'mrg' },
      { id: 'e2', source: 'mrg', target: 'flat' },
    ],
  }
  const staging = ['select', ...sc.map((c) => `  r['${c}'] as ${c},`), '  {{ subject_org() }} as org', 'from t'].join('\n')

  const root = mkdtempSync(join(tmpdir(), 'ddc-'))
  roots.push(root)
  mkdirSync(join(root, 'contracts/common'), { recursive: true })
  mkdirSync(join(root, 'deploy/duckle/console/pipelines'), { recursive: true })
  mkdirSync(join(root, 'dbt/models/common/staging'), { recursive: true })
  writeFileSync(join(root, 'contracts/common/x.y.json'), JSON.stringify(contract, null, 2))
  writeFileSync(join(root, 'deploy/duckle/console/pipelines/x.y.p.json'), JSON.stringify(pipeline, null, 2))
  writeFileSync(join(root, 'dbt/models/common/staging/stg_x_y.sql'), staging)
  return root
}

describe('取列器：认对投影，不认类型名与表别名', () => {
  it('管线侧排除 `CAST(… AS JSON)` 与 `AS u(d)`', () => {
    expect(
      extractPipelineAliases(
        "SELECT CAST(a.x AS VARCHAR) AS amount FROM input a CROSS JOIN UNNEST(from_json(CAST(a.d AS JSON), '[\"JSON\"]')) AS u(d)",
      ),
    ).toEqual(['amount'])
  })

  it('管线侧先掩注释（注释里的 `AS foo` 不算）', () => {
    expect(extractPipelineAliases('-- AS noise\nSELECT 1 AS real')).toEqual(['real'])
  })

  it('staging 侧先掩注释（散文里的 "as" 不算）', () => {
    expect(extractStagingAliases('-- this reads as a table\nselect\n  r[\'a\'] as a\nfrom t')).toEqual(['a'])
  })
})

describe('check-data-contract', () => {
  it('三方同源 ⇒ 不报', () => {
    expect(checkDataContract(fixture())).toEqual([])
  })

  it('尾列缺失 + 版本号已跟上 ⇒ 红（点名「迁移没做完就改版本号」）', () => {
    const v = checkDataContract(fixture({ stagingCols: COLS.slice(0, -1) }))
    expect(v).toHaveLength(1)
    expect(v[0]!.message).toContain('迁移没做完就改版本号')
    expect(v[0]!.message).toContain('amount')
  })

  it('**展开期**：consumerVersion 落后 + staging 是同序前缀 ⇒ 不红，但打提示', () => {
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => logs.push(String(m)))
    const v = checkDataContract(fixture({ stagingCols: COLS.slice(0, -1), schemaVersion: 2, consumerVersion: 1 }))
    spy.mockRestore()
    expect(v).toEqual([])
    expect(logs.join('\n')).toContain('展开期中')
  })

  it('中间少一列（不是前缀）⇒ 红', () => {
    const v = checkDataContract(fixture({ stagingCols: ['batch_id', 'bizday', 'amount'] }))
    expect(v).toHaveLength(1)
    expect(v[0]!.message).toContain('同序前缀')
  })

  it('consumerVersion > schemaVersion ⇒ 红', () => {
    const v = checkDataContract(fixture({ schemaVersion: 1, consumerVersion: 2 }))
    expect(v).toHaveLength(1)
    expect(v[0]!.message).toContain('消费者读的版本还不存在')
  })

  it('缺 consumerVersion ⇒ 红', () => {
    const v = checkDataContract(fixture({ consumerVersion: null }))
    expect(v).toHaveLength(1)
    expect(v[0]!.message).toContain('consumerVersion')
  })

  it('管线投影少一列 ⇒ 红（点名「恰好一个」判据）', () => {
    const v = checkDataContract(fixture({ pipelineCols: COLS.slice(0, -1) }))
    expect(v).toHaveLength(1)
    expect(v[0]!.message).toContain('恰好一个')
  })

  it('逐页投影：N 个命中但**同一条 SQL** ⇒ 不红（perPageTransform 形态）', () => {
    expect(checkDataContract(fixture({ extraProjection: 'same' }))).toEqual([])
  })

  it('逐页投影：两条**不同的** SQL 都命中 ⇒ 红（两套投影各说各话）', () => {
    const v = checkDataContract(fixture({ extraProjection: 'different' }))
    expect(v).toHaveLength(1)
    expect(v[0]!.message).toContain('去重 SQL 2 条')
  })

  it('列序不同也算红（同序是有意义的判据）', () => {
    const swapped = [...COLS].reverse()
    const v = checkDataContract(fixture({ pipelineCols: swapped }))
    expect(v).toHaveLength(1)
  })

  it('投影引用的字段没在 src.rest 申报 ⇒ 红（空响应才会炸的那一类）', () => {
    // 2026-10-05 实测（#432 的教训）：只改 flatten 的 SQL、没改 src.rest 的 data.schema
    // ⇒ **非空窗口照常成功**、只有空窗 Binder Error（24 窗里只炸 1 个）。
    const v = checkDataContract(fixture({ srcSchema: [{ name: 'batch_id', type: 'string' }, { name: 'd', type: 'json' }] }))
    expect(v).toHaveLength(1)
    expect(v[0]!.message).toContain('amount')
    expect(v[0]!.message).toContain('src.rest')
  })

  it('申报齐全 ⇒ 不报（对照组）', () => {
    expect(checkDataContract(fixture({ srcSchema: [...COLS.map((c) => ({ name: c, type: 'string' })), { name: 'd', type: 'json' }] }))).toEqual([])
  })

  it('契约缺 schemaVersion ⇒ 红', () => {
    // schemaVersion 缺失时 consumerVersion 也无从默认 ⇒ 两条都报（各自点名）
    const v = checkDataContract(fixture({ schemaVersion: null }))
    expect(v.map((x) => x.message).join('\n')).toContain('schemaVersion')
  })

  it('没有生产者（没有任何管线写着该 prefix）⇒ 红', () => {
    const v = checkDataContract(fixture({ sinkKey: 'other/table/bizday=${D}/all.parquet' }))
    expect(v).toHaveLength(1)
    expect(v[0]!.message).toContain('没有生产者')
  })

  it('只读不写（src.* 引用 prefix、无 snk.*）不是生产者 ⇒ 不参与列比对（#447 收窄）', () => {
    const root = fixture()
    // 读者：只在 src.minio 的 key 里引用 prefix，没有任何 snk.* 写它。
    // 旧判定（文本含 prefix 即生产者）会把它拉去比对 code.sql 投影 ⇒ 红；
    // 收窄后豁免 ⇒ 整仓绿。判据/对账类管线（lemeng.recon.preagg）首撞的正是这个形状。
    writeFileSync(
      join(root, 'deploy/duckle/console/pipelines/x.y.reader.json'),
      JSON.stringify(
        {
          nodes: [
            { id: 'r', data: { componentId: 'src.minio', properties: { bucket: 'b', key: 'x/y/bizday=2026-01-01/**/*.parquet', glob: true } } },
            { id: 'agg', data: { componentId: 'code.sql', properties: { sql: 'SELECT 1 AS whatever' } } },
          ],
          edges: [],
        },
        null,
        2,
      ),
    )
    expect(checkDataContract(root)).toEqual([])
  })

  it('同一 prefix 的**每个**生产者都要对（两个文件，一个错 ⇒ 红）', () => {
    const root = fixture()
    writeFileSync(
      join(root, 'deploy/duckle/console/pipelines/x.y.q.json'),
      JSON.stringify(
        {
          nodes: [
            {
              id: 'flat',
              data: {
                componentId: 'code.sql',
                properties: { sql: "SELECT CAST(b.batch_id AS VARCHAR) AS batch_id FROM input b" },
              },
            },
            // 它也必须**是**这张表的生产者（写着同一个 prefix），否则这条用例测的就不是「两个生产者」了
            { id: 'sink', data: { componentId: 'snk.minio', properties: { key: 'x/y/bizday=${D}/all.parquet' } } },
          ],
          edges: [],
        },
        null,
        2,
      ),
    )
    const v = checkDataContract(root)
    expect(v).toHaveLength(1)
    expect(v[0]!.file).toContain('x.y.q.json')
  })
})

describe('sensitivity 闭集（元 schema 无校验器 ⇒ 这里才是真闸）', () => {
  it('打错的值必须报违规——否则血缘门会把它当「不敏感」静默放行', () => {
    const root = fixture({ sensitivity: { amount: 'coast' } }) // 注意是 coast 不是 cost
    const v = checkDataContract(root)
    expect(v).toHaveLength(1)
    expect(v[0]!.message).toContain('sensitivity')
    expect(v[0]!.message).toContain('coast')
  })

  it('合法值（cost）不报违规', () => {
    expect(checkDataContract(fixture({ sensitivity: { amount: 'cost' } }))).toHaveLength(0)
  })

  it('不声明 sensitivity 不报违规（缺省 = none）', () => {
    expect(checkDataContract(fixture())).toHaveLength(0)
  })
})

describe('跨字段约束六条（contracts/README §4.2；元 schema 表达不了，这里是唯一机检）', () => {
  it('① 分区键不是已声明列 ⇒ 红', () => {
    const root = fixture()
    const p = join(root, 'contracts/common/x.y.json')
    const doc = JSON.parse(readFileSync(p, 'utf8'))
    doc.layout.partitionBy = ['bizday', 'no_such_col']
    writeFileSync(p, JSON.stringify(doc))
    const v = checkDataContract(root)
    expect(v.some((x) => x.message.includes('no_such_col') && x.message.includes('§4.2 ①'))).toBe(true)
  })

  it('① 显式别名例外：lemeng/recon_source 的 `chunk` 目录 ↔ `chunk_no` 列；换 domain 不成立', () => {
    const base = {
      domain: 'lemeng', table: 'recon_source', prefix: 'lemeng/recon_source',
      partitionBy: ['system_book', 'bizday', 'chunk'], markerColumn: 'batch_id',
      columns: [
        { name: 'batch_id', type: 'varchar', nullable: false },
        { name: 'system_book', type: 'int', nullable: false },
        { name: 'bizday', type: 'varchar', nullable: false },
        { name: 'chunk_no', type: 'int', nullable: false },
      ],
    }
    expect(crossFieldViolations(base)).toEqual([])
    // 例外按 `domain/table` 精确匹配，不是「找不到列就放过」
    expect(crossFieldViolations({ ...base, domain: 'x' }).some((m) => m.includes('chunk'))).toBe(true)
  })

  it('② prefix ≠ domain/table ⇒ 红；维度面 x/dim_y 放行', () => {
    const bad = fixture()
    const bp = join(bad, 'contracts/common/x.y.json')
    const bdoc = JSON.parse(readFileSync(bp, 'utf8'))
    bdoc.layout.prefix = 'wrong/prefix'
    writeFileSync(bp, JSON.stringify(bdoc))
    expect(checkDataContract(bad).some((x) => x.message.includes('§4.2 ②'))).toBe(true)

    const dim = fixture()
    const dp = join(dim, 'contracts/common/x.y.json')
    const ddoc = JSON.parse(readFileSync(dp, 'utf8'))
    ddoc.layout.prefix = 'x/dim_y'
    writeFileSync(dp, JSON.stringify(ddoc))
    expect(checkDataContract(dim).some((x) => x.message.includes('§4.2 ②'))).toBe(false)
  })

  it('③ 列名重复 ⇒ 红', () => {
    const root = fixture({ contractCols: COLS, pipelineCols: COLS, stagingCols: COLS })
    const p = join(root, 'contracts/common/x.y.json')
    const doc = JSON.parse(readFileSync(p, 'utf8'))
    doc.columns = [...doc.columns, { name: 'amount', type: 'varchar', nullable: true }]
    writeFileSync(p, JSON.stringify(doc))
    expect(checkDataContract(root).some((x) => x.message.includes('§4.2 ③'))).toBe(true)
  })

  it('④ batch.markerColumn 不是已声明列 ⇒ 红', () => {
    const root = fixture()
    const p = join(root, 'contracts/common/x.y.json')
    const doc = JSON.parse(readFileSync(p, 'utf8'))
    doc.batch.markerColumn = 'nope'
    writeFileSync(p, JSON.stringify(doc))
    expect(checkDataContract(root).some((x) => x.message.includes('§4.2 ④'))).toBe(true)
  })

  it('⑤ decimal scale > precision ⇒ 红', () => {
    const root = fixture()
    const p = join(root, 'contracts/common/x.y.json')
    const doc = JSON.parse(readFileSync(p, 'utf8'))
    doc.columns[0] = { name: doc.columns[0].name, type: 'decimal', precision: 5, scale: 7, nullable: false }
    writeFileSync(p, JSON.stringify(doc))
    expect(checkDataContract(root).some((x) => x.message.includes('§4.2 ⑤'))).toBe(true)
  })

  it('⑥ 分区键列 nullable=true ⇒ 红', () => {
    const root = fixture()
    const p = join(root, 'contracts/common/x.y.json')
    const doc = JSON.parse(readFileSync(p, 'utf8'))
    doc.columns = doc.columns.map((c: Record<string, unknown>) =>
      c.name === 'bizday' ? { ...c, nullable: true } : c)
    writeFileSync(p, JSON.stringify(doc))
    expect(checkDataContract(root).some((x) => x.message.includes('§4.2 ⑥'))).toBe(true)
  })
})
