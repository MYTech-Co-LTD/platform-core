import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './defs'
import { sandboxViolations, validateContractDraft, validatePipelineDraft } from './validate'

const goodPipeline = {
  name: 'lemeng.x.y', nodes: [
    { id: 's1', type: 'source', data: { componentId: 'src.rest', properties: {} } },
    { id: 'k1', type: 'sink', data: { componentId: 'snk.minio', properties: { key: '__sandbox/lemeng/x/all.parquet' } } },
  ], edges: [{ source: 's1', target: 'k1' }],
}
const goodContract = {
  contractVersion: 2, domain: 'lemeng', table: 'x', owner: 'data-platform',
  layout: { prefix: 'lemeng/x', partitionStyle: 'hive', partitionBy: ['bizday'], fileName: 'all.parquet' },
  batch: { markerColumn: 'batch_id', type: 'varchar', unique: false },
  columns: [{ name: 'batch_id', type: 'varchar', nullable: false }],
}

describe('validatePipelineDraft', () => {
  it('合法草案零 issue', () => expect(validatePipelineDraft(goodPipeline)).toEqual([]))
  it('缺 name / nodes 非数组 / 无 source / 无 sink ⇒ 各自一条 issue', () => {
    expect(validatePipelineDraft({}).map((i) => i.path)).toContain('name')
    expect(validatePipelineDraft({ name: 'x', nodes: {}, edges: [] }).map((i) => i.path)).toContain('nodes')
    expect(validatePipelineDraft({ name: 'x', nodes: [{ id: 'k', type: 'sink', data: { componentId: 'snk.minio' } }], edges: [] })
      .map((i) => i.message).join()).toContain('source')
    expect(validatePipelineDraft({ name: 'x', nodes: [{ id: 's', type: 'source', data: { componentId: 'src.rest' } }], edges: [] })
      .map((i) => i.message).join()).toContain('sink')
  })
  it('节点 id 重复 / 边指向不存在的节点 / type 非法 ⇒ 定位到具体路径', () => {
    const dup = validatePipelineDraft({
      name: 'x',
      nodes: [{ id: 'a', type: 'source', data: { componentId: 'src.rest' } }, { id: 'a', type: 'sink', data: { componentId: 'snk.csv', properties: { path: '/workspace/logs/sandbox/x.csv' } } }],
      edges: [],
    })
    expect(dup.some((i) => i.message.includes('重复'))).toBe(true)
    const badEdge = validatePipelineDraft({ ...goodPipeline, edges: [{ source: 's1', target: 'zzz' }] })
    expect(badEdge.some((i) => i.path === 'edges[0].target')).toBe(true)
    const badType = validatePipelineDraft({ ...goodPipeline, nodes: [{ id: 'a', type: 'weird', data: {} }] })
    expect(badType.some((i) => i.message.includes('type'))).toBe(true)
  })
  // 校验器不得比引擎严：`qa.contract` 判据写 `type:"quality"`，引擎照跑
  // （docs/data-platform-handbook.md 实测；仓内 lemeng.purchase.analysis.l0.3120.json 即此）。
  it("'quality'（qa.contract）是引擎真实词汇 ⇒ 零 issue", () => {
    const doc = {
      ...goodPipeline,
      nodes: [...goodPipeline.nodes, { id: 'q1', type: 'quality', data: { componentId: 'qa.contract' } }],
    }
    expect(validatePipelineDraft(doc)).toEqual([])
  })
  // sink 要求只对**薄管线**成立：ctl.foreach 驱动把活派给子管线，自身没有 sink 是正常形态
  // （仓内 lemeng.recon.preagg.backfill.json）。source 要求仍无条件。
  it('ctl.foreach 驱动的编排管线没有 sink ⇒ 零 issue；非驱动管线照旧要 sink', () => {
    const driver = {
      name: 'x', nodes: [
        { id: 's1', type: 'source', data: { componentId: 'src.minio' } },
        { id: 'f1', type: 'transform', data: { componentId: 'ctl.foreach' } },
      ], edges: [],
    }
    expect(validatePipelineDraft(driver)).toEqual([])
    const noSink = {
      name: 'x', nodes: [{ id: 's1', type: 'source', data: { componentId: 'src.minio' } }], edges: [],
    }
    expect(validatePipelineDraft(noSink).map((i) => i.message).join()).toContain('sink')
    // source 要求无条件：驱动管线也必须有 source。
    const noSource = {
      name: 'x', nodes: [{ id: 'f1', type: 'transform', data: { componentId: 'ctl.foreach' } }], edges: [],
    }
    expect(validatePipelineDraft(noSource).map((i) => i.message).join()).toContain('source')
    // 驱动型只认 transform：别的类型挂上 ctl.foreach **不构成**豁免（否则 sink 要求可被静默绕过）。
    const misTyped = {
      name: 'x', nodes: [{ id: 's1', type: 'source', data: { componentId: 'ctl.foreach' } }], edges: [],
    }
    expect(validatePipelineDraft(misTyped).map((i) => i.message).join()).toContain('sink')
  })
})

// 语料测试：仓内**每一条**在跑的管线都必须零 issue。校验器比引擎严 = 真草案被拒
// （propose_* / run_pipeline_sandbox），比引擎松 = 假绿；语料是这条边界的唯一事实源。
describe('validatePipelineDraft —— 仓内语料', () => {
  it('deploy/duckle/console/pipelines/*.json 逐条零 issue', () => {
    const dir = join(REPO_ROOT, 'deploy/duckle/console/pipelines')
    const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      const doc: unknown = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      // 断言消息带文件名：红了要一眼看出是哪条管线。
      expect(validatePipelineDraft(doc), f).toEqual([])
    }
  })
})

describe('validateContractDraft', () => {
  it('合法契约零 issue', () => expect(validateContractDraft(goodContract)).toEqual([]))
  it('contractVersion ≠ 2 / 缺 domain / 非法 layout / 无列 ⇒ 各自一条', () => {
    expect(validateContractDraft({ ...goodContract, contractVersion: 1 }).map((i) => i.path)).toContain('contractVersion')
    expect(validateContractDraft({ ...goodContract, domain: 'Bad-Domain' }).map((i) => i.path)).toContain('domain')
    expect(validateContractDraft({ ...goodContract, layout: { ...goodContract.layout, fileName: 'x.parquet' } })
      .map((i) => i.path)).toContain('layout.fileName')
    expect(validateContractDraft({ ...goodContract, columns: [] }).map((i) => i.path)).toContain('columns')
  })
})

describe('sandboxViolations', () => {
  it('合法沙箱草案零违规', () => expect(sandboxViolations(goodPipeline)).toEqual([]))
  it('湖写入不在 __sandbox/ 下 ⇒ 违规', () => {
    const bad = { ...goodPipeline, nodes: [{ id: 'k', type: 'sink', data: { componentId: 'snk.minio', properties: { key: 'lemeng/x/all.parquet' } } }] }
    expect(sandboxViolations(bad).map((i) => i.path)).toEqual(['nodes[0].data.properties.key'])
  })
  it('本地落盘不在 /workspace/logs/sandbox/ 下 ⇒ 违规', () => {
    const bad = { ...goodPipeline, nodes: [{ id: 'k', type: 'sink', data: { componentId: 'snk.csv', properties: { path: '/workspace/logs/x.csv' } } }] }
    expect(sandboxViolations(bad)).toHaveLength(1)
  })
  it('webhook 出口 ⇒ 违规（沙箱不得对外发数据）', () => {
    const bad = { ...goodPipeline, nodes: [{ id: 'w', type: 'sink', data: { componentId: 'snk.webhook', properties: { url: 'https://x' } } }] }
    expect(sandboxViolations(bad)[0].message).toContain('webhook')
  })
  // 前缀必须按**规范化后**的路径判：字面 startsWith 会放过「写着沙箱、实际写生产」的形状（#1005）。
  it('湖写入的绕过形状一律违规（.. / 编码 / 大小写 / 绝对 / 反斜杠 / 无文件名）', () => {
    const draft = (key: string) => ({
      ...goodPipeline,
      nodes: [{ id: 'k', type: 'sink', data: { componentId: 'snk.minio', properties: { key } } }],
    })
    for (const key of [
      '__sandbox/../prod/x.parquet',      // 字面通过、语义越界
      'a/../../__sandbox/x',              // 回退越过根
      '__sandbox/%2e%2e/prod/x',          // 编码的 ..
      '__sandbox/..%2fprod/x',            // 编码的 /
      '__SANDBOX/x',                      // S3 键区分大小写 ⇒ 另一个前缀
      '__sandbox',                        // 没有文件名（目录本身不是产物）
      '__sandbox/',                       // 同上
      '/__sandbox/x',                     // 绝对路径 ≠ 相对键
      '__sandbox/x\\..\\y',               // 反斜杠：不同平台语义不同，判不了就拒
      '__sandbox/%252e%252e/x',           // 多重编码：不猜层数
    ]) {
      expect(sandboxViolations(draft(key)), key).toHaveLength(1)
    }
  })
  it('合法但非规范的形状放行（折叠后仍在沙箱内，不是一刀切拒绝）', () => {
    const draft = (key: string) => ({
      ...goodPipeline,
      nodes: [{ id: 'k', type: 'sink', data: { componentId: 'snk.minio', properties: { key } } }],
    })
    for (const key of ['__sandbox//lemeng/x.parquet', './__sandbox/./lemeng/x.parquet']) {
      expect(sandboxViolations(draft(key)), key).toEqual([])
    }
  })
  it('本地落盘同样按规范化判（越界 / 相对 / 大小写）', () => {
    const draft = (path: string) => ({
      ...goodPipeline,
      nodes: [{ id: 'k', type: 'sink', data: { componentId: 'snk.csv', properties: { path } } }],
    })
    for (const path of [
      '/workspace/logs/sandbox/../prod/x.csv',
      '/workspace/logs/sandbox/../../etc/passwd',
      'workspace/logs/sandbox/x.csv',
      '/workspace/logs/SANDBOX/x.csv',
    ]) {
      expect(sandboxViolations(draft(path)), path).toHaveLength(1)
    }
    expect(sandboxViolations(draft('/workspace/logs/sandbox//sub/./x.csv'))).toEqual([])
  })
  // allowlist：未知写入组件与误标类型的写组件都不能漏（denylist 只拦了 snk.webhook 一个）。
  it('写入组件走 allowlist（未知组件 / 误标 type 的写组件都违规）', () => {
    const unknown = { ...goodPipeline, nodes: [{ id: 'k', type: 'sink', data: { componentId: 'snk.ftp', properties: {} } }] }
    // 断言**理由**而不只是条数：退回 denylist 时 snk.ftp 会掉进 csv 那条前缀分支，
    // 照样产出 1 条违规 —— 只数条数的话这条用例抓不到退化（变异检查实测）。
    expect(sandboxViolations(unknown)).toHaveLength(1)
    expect(sandboxViolations(unknown)[0].message).toContain('只允许写入')
    const misTyped = {
      ...goodPipeline,
      nodes: [{ id: 'w', type: 'transform', data: { componentId: 'snk.webhook', properties: { url: 'https://x' } } }],
    }
    expect(sandboxViolations(misTyped)).toHaveLength(1)
    // 非写组件不受影响（quality 节点照旧放行）。
    const quality = { ...goodPipeline, nodes: [...goodPipeline.nodes, { id: 'q1', type: 'quality', data: { componentId: 'qa.contract' } }] }
    expect(sandboxViolations(quality)).toEqual([])
  })
})
