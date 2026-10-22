import { chmodSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { contractFor, loadContracts, loadPipelines, loadSchedules, rootsOf } from './defs'
import type { PipelineRoots } from './defs'

const root = mkdtempSync(join(tmpdir(), 'pl-defs-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function seed(rel: string, body: unknown): void {
  const p = join(root, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
}
seed('deploy/duckle/console/pipelines/lemeng.a.b.json', {
  name: 'lemeng.a.b', version: 1,
  nodes: [
    { id: 's1', type: 'source', data: { componentId: 'src.rest', properties: {} } },
    { id: 't1', type: 'transform', data: { componentId: 'tr.sql', properties: {} } },
    // `type:'quality'` 是引擎的真实词汇（qa.contract），必须计入 counts 不能被吞。
    { id: 'q1', type: 'quality', data: { componentId: 'qa.contract', properties: {} } },
    { id: 'k1', type: 'sink', data: { componentId: 'snk.minio', properties: { key: 'lemeng/a/system_book=1/all.parquet' } } },
    { id: 'k2', type: 'sink', data: { componentId: 'snk.csv', properties: { path: '/workspace/logs/a.csv' } } },
  ],
  edges: [],
})
seed('deploy/duckle/console/pipelines/broken.json', '{ not json')
seed('deploy/duckle/console/schedules/3120.json', [
  { id: 'panel-1', pipeline_id: 'lemeng.a.b', name: 'lemeng.a.b', enabled: true, kind: { type: 'cron', expr: '*/5 * * * *' }, timezone: 'Asia/Shanghai' },
  { id: 'panel-2', pipeline_id: 'gone.away', name: 'gone.away', enabled: false, kind: { type: 'interval', seconds: 60 } },
])
seed('contracts/common/lemeng.a.json', {
  contractVersion: 2, domain: 'lemeng', table: 'a', owner: 'data-platform', columns: [{ name: 'x', type: 'varchar' }],
  layout: { prefix: 'lemeng/a', partitionStyle: 'hive', partitionBy: ['d'], fileName: 'all.parquet' },
})
seed('contracts/common/_schema.schema.json', { title: 'infra' })

const roots = rootsOf({}, root)

describe('rootsOf', () => {
  it('显式基准目录可解析仓内路径；env 可覆盖', () => {
    expect(rootsOf({}, '/repo')).toEqual({ pipelinesRoot: '/repo/deploy/duckle/console', contractsRoot: '/repo/contracts' })
    expect(rootsOf({ DATA_PIPELINES_ROOT: '/p', DATA_CONTRACTS_ROOT: '/c' }, '/repo')).toEqual({ pipelinesRoot: '/p', contractsRoot: '/c' })
  })
  // 回归（生产事故面）：镜像 CMD 是 `pnpm --filter @platform/server start`，pnpm 把 cwd 设为
  // apps/server ⇒ 旧实现（缺省 = process.cwd()）解析出 apps/server/contracts（不存在），
  // list_pipelines/get_pipeline 恒 unknown。vitest 的 cwd = modules/data，旧实现同样落空。
  // 锚点不依赖实现：契约根的父目录必须是仓根标记 pnpm-workspace.yaml 所在处。
  it('缺省根按模块位置解析（与 cwd 无关），锚在仓根', () => {
    const { pipelinesRoot, contractsRoot } = rootsOf({})
    expect(existsSync(join(dirname(contractsRoot), 'pnpm-workspace.yaml'))).toBe(true)
    expect(existsSync(join(pipelinesRoot, 'pipelines'))).toBe(true)
  })
})

describe('loadPipelines', () => {
  it('按文件名取 id、统计节点类型（含 quality）、收集湖写入 key；坏 JSON 进 warnings 不抛', () => {
    const { defs, warnings, readable, incomplete } = loadPipelines(roots)
    expect([...defs.keys()]).toEqual(['lemeng.a.b'])
    const d = defs.get('lemeng.a.b')!
    expect(d.name).toBe('lemeng.a.b')
    expect(d.counts).toEqual({ source: 1, transform: 1, sink: 2, control: 0, quality: 1 })
    expect(d.lakeKeys).toEqual(['lemeng/a/system_book=1/all.parquet'])
    expect(warnings.some((w) => w.includes('broken.json'))).toBe(true)
    expect(readable).toBe(true)
    // 有坏件 ⇒ 读不全（缺席的 id 不等于不存在）。
    expect(incomplete).toBe(true)
  })
  it('目录不存在 ⇒ 空 + warning + readable=false + incomplete=true（不抛）', () => {
    expect(loadPipelines(rootsOf({}, '/definitely/not/here'))).toEqual({
      defs: new Map(), warnings: [expect.stringContaining('pipelines')], readable: false, incomplete: true,
    })
  })
  it('全部读全 ⇒ incomplete=false；非法文件名 / 不可解析各置 true', () => {
    const clean = tmpRoot()
    clean.seed('pipelines/ok.json', { name: 'ok', nodes: [], edges: [] })
    expect(loadPipelines(clean.roots).incomplete).toBe(false)

    clean.seed('pipelines/bad name!.json', { name: 'x', nodes: [], edges: [] })
    expect(loadPipelines(clean.roots).incomplete).toBe(true)

    const torn = tmpRoot()
    torn.seed('pipelines/ok.json', { name: 'ok', nodes: [], edges: [] })
    torn.seed('pipelines/torn.json', '{ not json')
    expect(loadPipelines(torn.roots).incomplete).toBe(true)
  })
})

/** 每个用例独立临时根：读面三棵树的「读不全」必须能单独构造，混在一个根里会互相污染。 */
function tmpRoot(): { dir: string; roots: PipelineRoots; seed: (rel: string, body: unknown) => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pl-defs-case-'))
  made.push(dir)
  return {
    dir, roots: rootsOf({}, dir),
    seed: (rel: string, body: unknown): void => {
      const p = join(dir, 'deploy/duckle/console', rel)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
    },
  }
}
const made: string[] = []
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })

describe('loadSchedules', () => {
  it('按 pipeline_id 归并，cron 抽平，interval 型 cron=null；读全 ⇒ incomplete=false', () => {
    const { byPipeline, incomplete } = loadSchedules(roots)
    expect(byPipeline.get('lemeng.a.b')).toEqual([
      { source: '3120', pipelineId: 'lemeng.a.b', enabled: true, cron: '*/5 * * * *', timezone: 'Asia/Shanghai' },
    ])
    expect(byPipeline.get('gone.away')?.[0]).toMatchObject({ enabled: false, cron: null, timezone: null })
    expect(incomplete).toBe(false)
  })
  it('调度根不可读 ⇒ incomplete=true（不抛）', () => {
    const t = tmpRoot()
    t.seed('pipelines/ok.json', { name: 'ok', nodes: [], edges: [] })
    expect(loadSchedules(t.roots)).toEqual({
      byPipeline: new Map(), warnings: [expect.stringContaining('schedules')], incomplete: true,
    })
  })
  it('文件不是数组 / 条目不是对象 / 缺 pipeline_id ⇒ 都置 incomplete=true', () => {
    const notArray = tmpRoot()
    notArray.seed('schedules/3120.json', { pipeline_id: 'a.b' })
    expect(loadSchedules(notArray.roots).incomplete).toBe(true)

    const notObj = tmpRoot()
    notObj.seed('schedules/3120.json', ['nope', { pipeline_id: 'a.b', kind: {} }])
    const noObj = loadSchedules(notObj.roots)
    expect(noObj.incomplete).toBe(true)
    expect(noObj.byPipeline.get('a.b')).toHaveLength(1)

    const noPid = tmpRoot()
    noPid.seed('schedules/3120.json', [{ enabled: true, kind: {} }])
    expect(loadSchedules(noPid.roots).incomplete).toBe(true)
  })
})

describe('loadContracts / contractFor', () => {
  it('跳过 _ 前缀基础设施文件', () => {
    const { contracts } = loadContracts(roots)
    expect(contracts.map((c) => c.id)).toEqual(['lemeng.a'])
    expect(contracts[0]).toMatchObject({ domain: 'lemeng', table: 'a', columns: 1 })
  })
  it('契约根不可读 ⇒ incomplete=true 且 duplicateIds 为空（读不到 ≠ 没重复）', () => {
    expect(loadContracts(rootsOf({}, '/definitely/not/here'))).toEqual({
      contracts: [], warnings: [expect.stringContaining('contracts')], incomplete: true, duplicateIds: [],
    })
  })
  it('contractFor：最长 domain.table 前缀命中；无命中回 null', () => {
    const { contracts } = loadContracts(roots)
    expect(contractFor('lemeng.a.tick', contracts)?.id).toBe('lemeng.a')
    expect(contractFor('lemeng.zzz', contracts)).toBeNull()
  })
  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    '领域目录不可读 ⇒ 进 warnings，其余领域照常返回',
    () => {
      const locked = join(root, 'contracts/locked')
      seed('contracts/locked/x.json', { domain: 'locked', table: 'x', columns: [] })
      chmodSync(locked, 0o000)
      try {
        const { contracts, warnings } = loadContracts(roots)
        expect(contracts.map((c) => c.id)).toEqual(['lemeng.a'])
        expect(warnings.some((w) => w.includes('locked'))).toBe(true)
      } finally {
        chmodSync(locked, 0o755)
      }
    },
  )
})

// 客户级覆盖是**两层**（contracts/customers/<客户>/<源>.<表>.json，contracts/customers/README.md）。
// 每个用例用独立临时根：契约面是共享状态，混在一个根里会互相污染断言。
describe('loadContracts —— customers/<客户>/ 两层覆盖', () => {
  const made: { dir: string; roots: PipelineRoots; seed: (rel: string, body: unknown) => void }[] = []
  const mkRoot = (): (typeof made)[number] => {
    const dir = mkdtempSync(join(tmpdir(), 'pl-defs-cust-'))
    const r = {
      dir,
      roots: rootsOf({}, dir),
      seed: (rel: string, body: unknown): void => {
        const p = join(dir, rel)
        mkdirSync(join(p, '..'), { recursive: true })
        writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
      },
    }
    made.push(r)
    return r
  }
  const contractDoc = (table = 'a') => ({
    contractVersion: 2, domain: 'lemeng', table, owner: 'data-platform', columns: [{ name: 'x', type: 'varchar' }],
    layout: { prefix: `lemeng/${table}`, partitionStyle: 'hive', partitionBy: ['d'], fileName: 'all.parquet' },
  })
  afterAll(() => {
    for (const m of made) {
      // chmod 000 的目录先恢复，否则 rmSync 在 macOS 上清不掉。
      try { chmodSync(join(m.dir, 'contracts/customers/acme'), 0o755) } catch { /* 不存在/无权都无所谓 */ }
      rmSync(m.dir, { recursive: true, force: true })
    }
  })

  it('两层客户覆盖能被发现：path 是仓内相对路径，跳过 _ 前缀与非 .json', () => {
    const m = mkRoot()
    m.seed('contracts/customers/acme/lemeng.a.json', contractDoc())
    m.seed('contracts/customers/acme/_template.contract.json', { title: 'infra' })
    m.seed('contracts/customers/acme/README.md', '# 说明')
    const { contracts, warnings, incomplete } = loadContracts(m.roots)
    expect(contracts.map((c) => c.path)).toEqual(['contracts/customers/acme/lemeng.a.json'])
    expect(contracts[0]).toMatchObject({ id: 'lemeng.a', domain: 'lemeng', table: 'a' })
    expect(warnings).toEqual([])
    expect(incomplete).toBe(false)
  })
  it('同 id 多份（common + customers/acme）⇒ warning 点名两份 path + duplicateIds；但**不是**读不全', () => {
    const m = mkRoot()
    m.seed('contracts/common/lemeng.a.json', contractDoc())
    m.seed('contracts/customers/acme/lemeng.a.json', contractDoc())
    const { contracts, warnings, incomplete, duplicateIds } = loadContracts(m.roots)
    expect(contracts.map((c) => c.path)).toEqual([
      'contracts/common/lemeng.a.json', 'contracts/customers/acme/lemeng.a.json',
    ])
    const dup = warnings.find((w) => w.includes('契约 id 重复'))
    expect(dup).toContain('contracts/common/lemeng.a.json')
    expect(dup).toContain('contracts/customers/acme/lemeng.a.json')
    expect(dup).toContain('优先级未定案')
    // 机器通道：contractFor 只取第一份 ⇒ 调用方要能知道这个 id 有歧义。
    expect(duplicateIds).toEqual(['lemeng.a'])
    expect(incomplete).toBe(false)
  })
  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    '客户目录不可读 ⇒ warning + incomplete=true，其余契约照常返回',
    () => {
      const m = mkRoot()
      m.seed('contracts/common/lemeng.a.json', contractDoc())
      m.seed('contracts/customers/acme/lemeng.b.json', contractDoc('b'))
      chmodSync(join(m.dir, 'contracts/customers/acme'), 0o000)
      try {
        const { contracts, warnings, incomplete } = loadContracts(m.roots)
        expect(contracts.map((c) => c.id)).toEqual(['lemeng.a'])
        expect(warnings.some((w) => w.includes('customers/acme'))).toBe(true)
        expect(incomplete).toBe(true)
      } finally {
        chmodSync(join(m.dir, 'contracts/customers/acme'), 0o755)
      }
    },
  )
  it('坏件 ⇒ incomplete=true（有契约没读进来，不能当「没有」）', () => {
    const m = mkRoot()
    m.seed('contracts/common/lemeng.a.json', contractDoc())
    m.seed('contracts/common/broken.json', '{not json')
    const { contracts, incomplete } = loadContracts(m.roots)
    expect(contracts.map((c) => c.id)).toEqual(['lemeng.a'])
    expect(incomplete).toBe(true)
  })
})
