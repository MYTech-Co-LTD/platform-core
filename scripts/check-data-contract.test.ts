// scripts/check-data-contract.test.ts — 数据契约注册门禁的夹具测试。
//
// 手法与 check-data-plane-lock.test.ts 一致：**在临时目录里造一棵最小的假仓**，然后按判据逐条
// 变异，确认门禁**真的会红**（本仓规矩：一个从不红的判据等于没有判据）。
// 取列器另有一组单元用例——它要能同时认对「投影列」和**不认**「类型名 / 表别名」。

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

import {
  checkDataContract,
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
 *           srcSchema?: Array<{name: string, type: string}> }} [over]
 * @returns {string} 临时仓根
 */
function fixture(over: {
  contractCols?: string[]
  pipelineCols?: string[]
  stagingCols?: string[]
  schemaVersion?: number | null
  consumerVersion?: number | null
  pipelineText?: string
  sinkKey?: string
  srcSchema?: Array<{ name: string, type: string }>
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
    columns: cc.map((name) => ({ name, type: 'varchar', nullable: true })),
  }
  const sv = over.schemaVersion === undefined ? 1 : over.schemaVersion
  if (sv !== null) contract.schemaVersion = sv
  const cv = over.consumerVersion === undefined ? sv : over.consumerVersion
  if (cv !== null) contract.consumerVersion = cv

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
            sql:
              over.pipelineText ??
              `SELECT ${pc.map((c) => `CAST(b.${c} AS VARCHAR) AS ${c}`).join(', ')}\n` +
                `FROM input b CROSS JOIN UNNEST(from_json(CAST(b.d AS JSON), '["JSON"]')) AS u(d)`,
          },
        },
      },
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
