// scripts/check-data-lanes.test.ts — A4/A5 静态门禁的 fixture 测试。
//
// 断言面刻意落在「报了什么错 + 提到哪个模型/分钟」上：只断 `length > 0` 分不清门禁退化，
// 断全量文案会把改文案变成假红。每个用例都是**只改一处**的变异，基线本身必须真合规。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { checkDataLanes } from './check-data-lanes.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const tmpRoots: string[] = []

/** 建临时 fixture 根；files: 相对路径 → 内容。 */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'platform-data-lanes-'))
  tmpRoots.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

afterAll(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true })
})

const MODEL = (kind: string) => `{{ config(materialized='${kind}') }}\nselect 1\n`

function lanesConfig(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    lanes: {
      retail_10m: { models: ['fct_retail_sale'], schedule: { buildOffsetMinutes: 2 } },
      nonretail_1h: {
        schedule: { startMinuteCst: 5, maxGapMinutes: 15 },
        domains: { d: ['fct_a'] },
      },
      daily_report: { models: ['fct_b'] },
      ...over,
    },
  })
}

function schedules(): Record<string, string> {
  const base = (tick: string, extra: Array<{ id: string; expr: string }>) => JSON.stringify([
    { id: tick, enabled: true, kind: { type: 'cron', expr: '*/10 9-23,0-1' }, timezone: 'Asia/Shanghai' },
    ...extra.map((e) => ({ id: e.id, enabled: true, kind: { type: 'cron', expr: e.expr }, timezone: 'Asia/Shanghai' })),
  ])
  return {
    'deploy/duckle/console/schedules/3120.json': base('panel.tick', [
      { id: 'src.22', expr: '22 9-23 * * *' },
      { id: 'src.58', expr: '58 9-23 * * *' },
    ]),
    'deploy/duckle/console/schedules/64188.json': base('panel.tick', [
      { id: 'src.46', expr: '46 9-23 * * *' },
    ]),
  }
}

const REGISTRY = "  { key: 'data.dbt_tick', scope: 'data', cron: '2-59/10 1-17 * * *', timezone: 'UTC' },\n"
  + "  hourlyLaneJob('d', 5, 'd'),\n"

function baseFiles(over: { lanes?: string; registry?: string; models?: Record<string, string> } = {}): Record<string, string> {
  return {
    'scripts/lemeng/data-lanes.json': over.lanes ?? lanesConfig(),
    'deploy/duckle/console/schedules/3120.json': schedules()['deploy/duckle/console/schedules/3120.json'],
    'deploy/duckle/console/schedules/64188.json': schedules()['deploy/duckle/console/schedules/64188.json'],
    'apps/server/src/scheduler/registry.ts': over.registry ?? REGISTRY,
    'dbt/models/lemeng/marts/fct_retail_sale.sql': MODEL('incremental'),
    'dbt/models/lemeng/marts/fct_a.sql': MODEL('incremental'),
    'dbt/models/lemeng/marts/fct_b.sql': MODEL('incremental'),
    'dbt/models/lemeng/marts/dim_t.sql': MODEL('table'),
    ...(over.models ?? {}),
  }
}

describe('check-data-lanes · 基线', () => {
  it('合规 fixture 全绿', () => {
    const { ok, errors } = checkDataLanes(fixture(baseFiles()))
    expect(ok, errors.join('\n')).toBe(true)
  })

  it('真仓自检绿（车道清单与 dbt 模型 / 排班 / registry 对齐）', () => {
    const { ok, errors, stats } = checkDataLanes(repoRoot)
    expect(ok, errors.join('\n')).toBe(true)
    expect(stats.incremental).toBeGreaterThan(0)
  })
})

describe('check-data-lanes · A4 变异', () => {
  it('新增增量模型忘分车道 ⇒ 红并点名', () => {
    const { ok, errors } = checkDataLanes(fixture(baseFiles({
      models: { 'dbt/models/lemeng/marts/fct_orphan.sql': MODEL('incremental') },
    })))
    expect(ok).toBe(false)
    expect(errors.join('\n')).toContain('增量模型未归属车道：fct_orphan')
  })

  it('同一模型出现在两个车道 ⇒ 红并点名', () => {
    const lanes = JSON.stringify({
      lanes: {
        retail_10m: { models: ['fct_retail_sale'], schedule: { buildOffsetMinutes: 2 } },
        nonretail_1h: {
          schedule: { startMinuteCst: 5, maxGapMinutes: 15 },
          domains: { d: ['fct_a'], e: ['fct_a'] },
        },
        daily_report: { models: ['fct_b'] },
      },
    })
    const { ok, errors } = checkDataLanes(fixture(baseFiles({ lanes })))
    expect(ok).toBe(false)
    expect(errors.join('\n')).toContain('fct_a 同时属于')
  })

  it('配置了不存在的模型 ⇒ 红', () => {
    const lanes = lanesConfig({ daily_report: { models: ['fct_ghost'] } })
    const { ok, errors } = checkDataLanes(fixture(baseFiles({ lanes })))
    expect(ok).toBe(false)
    expect(errors.join('\n')).toContain('配置了不存在的模型：fct_ghost')
  })

  it('把 table 模型塞进增量车道 ⇒ 红', () => {
    const lanes = lanesConfig({ daily_report: { models: ['dim_t'] } })
    const { ok, errors } = checkDataLanes(fixture(baseFiles({ lanes })))
    expect(ok).toBe(false)
    expect(errors.join('\n')).toContain('不允许包含 table 模型：dim_t')
  })

  it('10m 车道越界（D2 定案只允许 fct_retail_sale）⇒ 红', () => {
    const lanes = lanesConfig({ retail_10m: { models: ['fct_a'], schedule: { buildOffsetMinutes: 2 } } })
    const { ok, errors } = checkDataLanes(fixture(baseFiles({ lanes })))
    expect(ok).toBe(false)
    expect(errors.join('\n')).toContain('retail_10m 只允许 fct_retail_sale')
  })
})

describe('check-data-lanes · A3 变异', () => {
  it('配置了域但没有 registry job ⇒ 红', () => {
    const lanes = lanesConfig({
      daily_report: { models: [] },
      nonretail_1h: {
        schedule: { startMinuteCst: 5, maxGapMinutes: 15 },
        domains: { d: ['fct_a'], e: ['fct_b'] },
      },
    })
    const { ok, errors } = checkDataLanes(fixture(baseFiles({ lanes })))
    expect(ok).toBe(false)
    expect(errors.join('\n')).toContain("没有对应的 hourlyLaneJob('e')")
  })

  it('registry 里有配置域之外的 lane job ⇒ 红', () => {
    const registry = "  { key: 'data.dbt_tick', scope: 'data', cron: '2-59/10 1-17 * * *', timezone: 'UTC' },\n"
      + "  hourlyLaneJob('d', 5, 'd'),\n  hourlyLaneJob('ghost', 6, 'g'),\n"
    const { ok, errors } = checkDataLanes(fixture(baseFiles({ registry })))
    expect(ok).toBe(false)
    expect(errors.join('\n')).toContain("hourlyLaneJob('ghost')")
  })
})

describe('check-data-lanes · A5 变异', () => {
  it('1h 起点离最后采集太远 ⇒ 红', () => {
    const lanes = lanesConfig({
      nonretail_1h: { schedule: { startMinuteCst: 50, maxGapMinutes: 15 }, domains: { d: ['fct_a'] } },
    })
    const { ok, errors } = checkDataLanes(fixture(baseFiles({ lanes })))
    expect(ok).toBe(false)
    expect(errors.join('\n')).toContain('有 52 分钟 > maxGapMinutes=15')
  })

  it('1h 起点与最后采集同分钟 ⇒ 红', () => {
    const lanes = lanesConfig({
      nonretail_1h: { schedule: { startMinuteCst: 58, maxGapMinutes: 15 }, domains: { d: ['fct_a'] } },
    })
    const { ok, errors } = checkDataLanes(fixture(baseFiles({ lanes })))
    expect(ok).toBe(false)
    expect(errors.join('\n')).toContain('同分钟')
  })

  it('registry 物化偏移与配置不一致 ⇒ 红', () => {
    const registry = "  { key: 'data.dbt_tick', scope: 'data', cron: '3-59/10 1-17 * * *', timezone: 'UTC' },\n"
    const { ok, errors } = checkDataLanes(fixture(baseFiles({ registry })))
    expect(ok).toBe(false)
    expect(errors.join('\n')).toContain('物化偏移 3')
  })
})
