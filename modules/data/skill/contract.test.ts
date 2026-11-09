// contract.test.ts — 契约形状门：通道名唯一、必填字段齐全、占位符可解析。
import { describe, expect, it } from 'vitest'
import { CONTRACT } from './contract'

const TOOL_NAME_RE = /^[A-Za-z0-9_.-]+$/

describe('skill contract', () => {
  it('version 为正整数，至少有一个工具', () => {
    expect(Number.isInteger(CONTRACT.version)).toBe(true)
    expect(CONTRACT.version).toBeGreaterThan(0)
    expect(CONTRACT.tools.length).toBeGreaterThan(0)
  })

  it('每个工具至少一个通道；通道名唯一且合法', () => {
    const seen = { mcp: new Set<string>(), openclaw: new Set<string>() }
    for (const tool of CONTRACT.tools) {
      const channels = Object.keys(tool.channels) as Array<keyof typeof seen>
      expect(channels.length).toBeGreaterThan(0)
      for (const ch of channels) {
        const face = tool.channels[ch]!
        expect(TOOL_NAME_RE.test(face.name)).toBe(true)
        expect(seen[ch].has(face.name)).toBe(false)
        seen[ch].add(face.name)
      }
    }
  })

  it('必填字段齐全', () => {
    for (const tool of CONTRACT.tools) {
      expect(tool.id).toBeTruthy()
      expect(tool.title).toBeTruthy()
      expect(typeof tool.analyst).toBe('boolean')
      expect(typeof tool.mutating).toBe('boolean')
      expect(tool.annotations).toBeTruthy()
      for (const face of Object.values(tool.channels)) {
        expect(face!.description).toBeTruthy()
        expect(face!.inputSchema).toBeTruthy()
      }
    }
  })

  it('query_detail 与 list_metrics 是静态工具（不进 ANALYST_TOOLS）', () => {
    const byId = new Map(CONTRACT.tools.map((t) => [t.id, t]))
    expect(byId.get('query_detail')?.analyst).toBe(false)
    expect(byId.get('list_metrics')?.analyst).toBe(false)
  })
})
