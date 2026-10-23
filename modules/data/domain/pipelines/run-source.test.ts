import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MAX_PER_PIPELINE, runSourceFromEnv } from './run-source'

const root = mkdtempSync(join(tmpdir(), 'run-src-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** 造一个 workspace 目录：`<root>/<name>/` + `runs/` 的文件与 `receipts/` 的收据。 */
const ws = (
  name: string, files: Record<string, unknown>, receipts: Record<string, unknown> = {},
): string => {
  const dir = join(root, name)
  mkdirSync(join(dir, 'receipts'), { recursive: true })
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), JSON.stringify(body))
  for (const [f, body] of Object.entries(receipts)) writeFileSync(join(dir, 'receipts', f), JSON.stringify(body))
  return dir
}
const listEntry = (runId: string, at: string, status = 'ok') => ({
  run_id: runId, at, status, duration_ms: 10, rows: 3, node_count: 2, trigger: 'scheduled',
})

const a = ws('3120', {
  'lemeng.a.json': [listEntry('run-1', '2026-10-22T02:00:00Z'), listEntry('run-2', '2026-10-22T01:00:00Z', 'error')],
  'lemeng.b.json': [listEntry('run-3', '2026-10-22T03:00:00Z')],
  // 同名管线在另一个账套各有一份：必须带 source 区分，不能合并。
  'dup.json': [listEntry('run-d1', '2026-10-22T04:00:00Z')],
}, {
  'run-old.json': {
    runId: 'run-old', trigger: 'manual', state: 'finished', at: '2026-09-01T00:00:00Z',
    status: 'ok', pipelineName: 'lemeng.a', startedAt: '2026-09-01T00:00:01Z', queueMs: 0,
    nodes: { sink: { status: 'ok', rows: 7 } }, durationMs: 99,
  },
})
const b = ws('64188', { 'dup.json': [listEntry('run-d2', '2026-10-22T05:00:00Z')] })
const env = { DATA_RUN_DIRS: `3120=${a},64188=${b}` }

describe('runSourceFromEnv —— seam 守卫', () => {
  it('未配置 / 空白 ⇒ null（不接通就是 null，不造空来源）', () => {
    expect(runSourceFromEnv({})).toBeNull()
    expect(runSourceFromEnv({ DATA_RUN_DIRS: '   ' })).toBeNull()
  })
  it('配置畸形 ⇒ 返回会报错的来源（不静默降级成「未接通」）', async () => {
    for (const raw of ['3120', '3120=relative/dir', '= /x', 'a=/x,a=/y', 'bad name=/x']) {
      const src = runSourceFromEnv({ DATA_RUN_DIRS: raw })
      expect(src, raw).not.toBeNull()
      const r = await src!.list({ limit: 5 })
      expect(r.unreadable.some((u) => u.workspace === '(config)'), raw).toBe(true)
      const g = await src!.get('run-1')
      expect(g.unreadable.some((u) => u.workspace === '(config)'), raw).toBe(true)
      expect(g.absenceProven).toBe(false)
    }
  })
})

describe('list', () => {
  it('跨文件、跨账套合并；按 startedAt 倒序；带 source；limit 生效', async () => {
    const r = await runSourceFromEnv(env)!.list({ limit: 3 })
    expect(r.runs.map((x) => x.runId)).toEqual(['run-d2', 'run-d1', 'run-3'])
    expect(r.runs[0].source).toBe('64188')
    expect(r.runs[1].source).toBe('3120')
    expect(r.scanned).toBe(5) // 截断前总数：3120 的 4 条 + 64188 的 1 条
    expect(r.truncated).toBe(true)
    expect(r.unreadable).toEqual([])
  })
  it('pipelineId 收窄到单文件；status 归一 error→failed 且保留 rawStatus', async () => {
    const r = await runSourceFromEnv(env)!.list({ pipelineId: 'lemeng.a', limit: 20 })
    expect(r.runs.map((x) => x.runId)).toEqual(['run-1', 'run-2'])
    expect(r.runs[1]).toMatchObject({
      status: 'failed', rawStatus: 'error', pipelineId: 'lemeng.a', source: '3120',
    })
    expect(r.unreadable).toEqual([])
    expect(r.warnings).toEqual([])
  })
  it('pipelineId 非法 ⇒ 不触盘，回 (param) 不可读（fail closed）', async () => {
    const r = await runSourceFromEnv(env)!.list({ pipelineId: '../../etc/passwd', limit: 5 })
    expect(r.runs).toEqual([])
    expect(r.unreadable[0]).toMatchObject({ workspace: '(param)' })
  })
  it('饱和：任一被扫描文件达到 50 条 ⇒ truncated（即便 limit 足够）', async () => {
    const big = ws('big', {
      'p.json': Array.from({ length: MAX_PER_PIPELINE }, (_, i) =>
        listEntry(`run-${i}`, `2026-10-22T00:${String(i).padStart(2, '0')}:00Z`)),
    })
    const r = await runSourceFromEnv({ DATA_RUN_DIRS: `big=${big}` })!.list({ limit: MAX_PER_PIPELINE })
    expect(r.runs).toHaveLength(MAX_PER_PIPELINE)
    expect(r.truncated).toBe(true)
  })
  it('坏件不拖垮整表：warnings 点名，好文件照常返回', async () => {
    const bad = ws('bad', { 'ok.json': [listEntry('run-x', '2026-10-22T00:00:00Z')] })
    writeFileSync(join(bad, 'torn.json'), '{ not json')
    const r = await runSourceFromEnv({ DATA_RUN_DIRS: `bad=${bad}` })!.list({ limit: 20 })
    expect(r.runs.map((x) => x.runId)).toEqual(['run-x'])
    expect(r.warnings.some((w) => w.includes('torn.json'))).toBe(true)
  })
  it('来源目录不可读 ⇒ unreadable 点名（≠ 空结果）', async () => {
    const r = await runSourceFromEnv({ DATA_RUN_DIRS: `gone=${join(root, 'no-such')}` })!.list({ limit: 20 })
    expect(r.runs).toEqual([])
    expect(r.unreadable[0].workspace).toBe('gone')
  })
  it('非 JSON 数组的记录文件 ⇒ warnings，不当作「没有运行」', async () => {
    const odd = ws('odd', { 'p.json': { not: 'an array' } })
    const r = await runSourceFromEnv({ DATA_RUN_DIRS: `odd=${odd}` })!.list({ limit: 20 })
    expect(r.runs).toEqual([])
    expect(r.warnings.some((w) => w.includes('不是记录数组'))).toBe(true)
  })
})

describe('get', () => {
  it('直读收据命中（即便不在 per-管线记录里）', async () => {
    const r = await runSourceFromEnv(env)!.get('run-old')
    expect(r.run).toMatchObject({
      runId: 'run-old', pipelineId: 'lemeng.a', status: 'ok', durationMs: 99, source: '3120',
    })
    expect(r.receipt).toBeDefined()
  })
  it('收据缺席但 per-管线记录在 ⇒ 扫描回退命中', async () => {
    const r = await runSourceFromEnv(env)!.get('run-2')
    expect(r.run).toMatchObject({ runId: 'run-2', status: 'failed', pipelineId: 'lemeng.a' })
  })
  it('两处都没有且无饱和 ⇒ absenceProven', async () => {
    const r = await runSourceFromEnv(env)!.get('run-typo')
    expect(r.run).toBeNull()
    expect(r.absenceProven).toBe(true)
  })
  it('任一窗口饱和 ⇒ absenceProven=false（不说成「没跑过」）', async () => {
    const big = ws('big2', {
      'p.json': Array.from({ length: MAX_PER_PIPELINE }, (_, i) =>
        listEntry(`run-${i}`, `2026-10-22T00:${String(i).padStart(2, '0')}:00Z`)),
    })
    const r = await runSourceFromEnv({ DATA_RUN_DIRS: `big2=${big}` })!.get('run-typo')
    expect(r.run).toBeNull()
    expect(r.absenceProven).toBe(false)
  })
  it('来源不可读 ⇒ absenceProven=false 且点名来源', async () => {
    const r = await runSourceFromEnv({ DATA_RUN_DIRS: `gone=${join(root, 'no-such')}` })!.get('run-x')
    expect(r.run).toBeNull()
    expect(r.absenceProven).toBe(false)
    expect(r.unreadable[0].workspace).toBe('gone')
  })
  it('畸形 runId ⇒ 不触盘，回 (param) 不可读', async () => {
    for (const id of ['../../etc/passwd', 'a/b', '.hidden', '']) {
      const r = await runSourceFromEnv(env)!.get(id)
      expect(r.run).toBeNull()
      expect(r.absenceProven).toBe(false)
      expect(r.unreadable[0].workspace).toBe('(param)')
    }
  })
  it('状态归一保留引擎词汇（interrupted / cancelled 不被折叠）', async () => {
    const s = ws('states', {
      'p.json': [
        listEntry('run-i', '2026-10-22T02:00:00Z', 'interrupted'),
        listEntry('run-c', '2026-10-22T01:00:00Z', 'cancelled'),
        listEntry('run-w', '2026-10-22T00:00:00Z', 'weird'),
      ],
    })
    const r = await runSourceFromEnv({ DATA_RUN_DIRS: `states=${s}` })!.list({ limit: 10 })
    expect(r.runs.find((x) => x.runId === 'run-i')?.status).toBe('interrupted')
    expect(r.runs.find((x) => x.runId === 'run-c')?.status).toBe('cancelled')
    expect(r.runs.find((x) => x.runId === 'run-w')).toMatchObject({ status: 'unknown', rawStatus: 'weird' })
  })
})
