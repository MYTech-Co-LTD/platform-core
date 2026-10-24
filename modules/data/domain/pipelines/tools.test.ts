import { describe, expect, it } from 'vitest'
import { PIPELINE_FACE_MAX_TOOLS, PIPELINE_TOOLS, pipelineToolMeta, pipelineToolNames } from './tools'
import { analystToolNames } from '../toolbox/registry'

const TOOL_NAME_RE = /^[A-Za-z0-9_.-]+$/

describe('PIPELINE_TOOLS（提案面元数据）', () => {
  it('恰 8 个工具，名与 spec §7 逐字一致', () => {
    expect(pipelineToolNames()).toEqual([
      'list_pipelines', 'get_pipeline', 'list_pipeline_runs', 'get_pipeline_run',
      'run_pipeline_sandbox', 'propose_pipeline_change', 'propose_contract_change',
      'apply_pipeline_proposal',
    ])
    expect(PIPELINE_TOOLS.length).toBe(PIPELINE_FACE_MAX_TOOLS)
  })
  it('命名合规、无内部重名、不与分析师面重名', () => {
    const names = pipelineToolNames()
    for (const n of names) expect(TOOL_NAME_RE.test(n)).toBe(true)
    expect(new Set(names).size).toBe(names.length)
    expect(names.filter((n) => analystToolNames().includes(n))).toEqual([])
  })
  it('写工具三件套齐备（annotations / requiredScope / mutating），读工具 readOnlyHint=true', () => {
    for (const t of PIPELINE_TOOLS) {
      expect(t.requiredScope).toBe('data:manage')
      expect(t.annotations).toBeDefined()
      if (t.mutating) {
        expect(t.annotations.readOnlyHint).toBe(false)
      } else {
        expect(t.annotations.readOnlyHint).toBe(true)
      }
    }
    expect(PIPELINE_TOOLS.filter((t) => t.mutating).map((t) => t.name)).toEqual([
      'run_pipeline_sandbox', 'propose_pipeline_change', 'propose_contract_change',
      'apply_pipeline_proposal',
    ])
  })
  it('每个工具都有非空 title/description 与 object 型 inputSchema', () => {
    for (const t of PIPELINE_TOOLS) {
      expect(t.title.length).toBeGreaterThan(0)
      expect(t.description.length).toBeGreaterThan(10)
      expect(t.inputSchema).toMatchObject({ type: 'object' })
    }
  })
  it('pipelineToolMeta：命中回元数据、未知回 undefined', () => {
    expect(pipelineToolMeta('get_pipeline')?.mutating).toBe(false)
    expect(pipelineToolMeta('nope')).toBeUndefined()
  })
})
