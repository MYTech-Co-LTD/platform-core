// manage-face.test.ts —— manage 面总清单与预算（9 提案 + 2 需求台账 = 11）。
import { describe, expect, it } from 'vitest'
import { MANAGE_FACE_MAX_TOOLS, MANAGE_TOOLS, manageToolMeta } from './manage-face'
import { PIPELINE_TOOLS } from './pipelines/tools'
import { DEMAND_TOOLS } from './demand/tools'
import { analystToolNames } from './toolbox/registry'

const TOOL_NAME_RE = /^[A-Za-z0-9_.-]+$/

describe('MANAGE_TOOLS（manage 面总清单）', () => {
  it('恰 11 个工具 = 提案 9 + 需求台账 2，且等于预算', () => {
    expect(MANAGE_TOOLS.length).toBe(11)
    expect(MANAGE_TOOLS.length).toBe(MANAGE_FACE_MAX_TOOLS)
    expect(PIPELINE_TOOLS.length + DEMAND_TOOLS.length).toBe(MANAGE_FACE_MAX_TOOLS)
    expect(MANAGE_TOOLS.map((t) => t.name)).toEqual([
      ...PIPELINE_TOOLS.map((t) => t.name), 'list_demand_signals', 'dismiss_demand_signal',
    ])
  })
  it('命名合规、无内部重名、不与分析师面重名', () => {
    const names = MANAGE_TOOLS.map((t) => t.name)
    for (const n of names) expect(TOOL_NAME_RE.test(n)).toBe(true)
    expect(new Set(names).size).toBe(names.length)
    expect(names.filter((n) => analystToolNames().includes(n))).toEqual([])
  })
  it('需求台账两件：一个只读、一个写（写工具三件套齐备）', () => {
    expect(DEMAND_TOOLS.map((t) => t.name)).toEqual(['list_demand_signals', 'dismiss_demand_signal'])
    expect(DEMAND_TOOLS.map((t) => t.mutating)).toEqual([false, true])
    for (const t of DEMAND_TOOLS) {
      expect(t.requiredScope).toBe('data:manage')
      expect(t.annotations.readOnlyHint).toBe(!t.mutating)
      expect(t.title.length).toBeGreaterThan(0)
      expect(t.description.length).toBeGreaterThan(10)
      expect(t.inputSchema).toMatchObject({ type: 'object' })
    }
  })
  it('manageToolMeta：命中回元数据（含需求工具）、未知回 undefined', () => {
    expect(manageToolMeta('get_pipeline')?.group).toBe('pipeline')
    expect(manageToolMeta('dismiss_demand_signal')?.group).toBe('demand')
    expect(manageToolMeta('dismiss_demand_signal')?.mutating).toBe(true)
    expect(manageToolMeta('nope')).toBeUndefined()
  })
})
