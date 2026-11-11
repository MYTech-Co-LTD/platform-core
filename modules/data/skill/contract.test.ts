// contract.test.ts — 契约形状门：id 唯一 / 通道名唯一 / 必填字段齐全。
import { describe, expect, it } from 'vitest'
import { CONTRACT, SUPPORTED_CONTRACT_VERSION, contractViolations } from './contract'

const TOOL_NAME_RE = /^[A-Za-z0-9_.-]+$/
const GROUPS = new Set(['guide', 'discovery', 'query', 'health'])

describe('skill contract', () => {
  it('version 与运行时支持的版本一致（Wave 2.2 版本门）', () => {
    expect(Number.isInteger(CONTRACT.version)).toBe(true)
    expect(CONTRACT.version).toBe(SUPPORTED_CONTRACT_VERSION)
    expect(CONTRACT.tools.length).toBeGreaterThan(0)
  })

  it('工具 id 唯一（正文占位符与查找的主键）', () => {
    const ids = CONTRACT.tools.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
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

  it('analyst 工具必须声明 mcp 通道（否则会被 projections 静默丢弃）', () => {
    for (const tool of CONTRACT.tools) {
      if (tool.analyst) expect(tool.channels.mcp).toBeDefined()
    }
  })

  it('group 取值合法，requiredScope 为 string 或 null', () => {
    for (const tool of CONTRACT.tools) {
      expect(GROUPS.has(tool.group)).toBe(true)
      expect(tool.requiredScope === null || typeof tool.requiredScope === 'string').toBe(true)
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

describe('contractViolations（装载期版本/形状门的纯判定）', () => {
  const good = (): Record<string, unknown> => ({
    version: SUPPORTED_CONTRACT_VERSION,
    tools: [{
      id: 'sample', group: 'query', analyst: true, mutating: false, requiredScope: null,
      channels: { mcp: { name: 'sample_tool' } },
    }],
  })

  it('干净契约 ⇒ 无违规', () => {
    expect(contractViolations(good())).toEqual([])
  })

  it('版本漂移 ⇒ 指名道姓地报（改形状必须同时改 SUPPORTED_CONTRACT_VERSION）', () => {
    const raw = { ...good(), version: SUPPORTED_CONTRACT_VERSION + 1 }
    const out = contractViolations(raw)
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('SUPPORTED_CONTRACT_VERSION')
  })

  it('version 非整数 / tools 非数组 / 根不是对象 ⇒ 都报', () => {
    expect(contractViolations({ ...good(), version: '1' })[0]).toContain('version 必须是整数')
    expect(contractViolations({ ...good(), tools: [] })[0]).toContain('tools 必须是非空数组')
    expect(contractViolations(null)).toEqual(['契约根必须是对象'])
  })

  it('工具级：id 重复 / 组别非法 / 通道未知 / 通道名非法 都报', () => {
    const dup = good()
    const tools = dup.tools as unknown[]
    tools.push({ ...(tools[0] as Record<string, unknown>) })
    expect(contractViolations(dup).some((v) => v.includes("重复"))).toBe(true)

    const badGroup = good()
    ;(badGroup.tools as Record<string, unknown>[])[0]!.group = 'nope'
    expect(contractViolations(badGroup).some((v) => v.includes('.group'))).toBe(true)

    const badChannel = good()
    ;((badChannel.tools as Record<string, unknown>[])[0]!.channels as Record<string, unknown>).web = { name: 'x' }
    expect(contractViolations(badChannel).some((v) => v.includes('不是已知通道'))).toBe(true)

    const badName = good()
    ;((badName.tools as Record<string, unknown>[])[0]!.channels as Record<string, unknown>).mcp = { name: 'bad name!' }
    expect(contractViolations(badName).some((v) => v.includes('.name'))).toBe(true)
  })
})
