// registry.golden.test.ts — ANALYST_TOOLS 内部元数据快照门（回归用，不是 wire 契约）。
// 内部元数据字段（如 Task 5 的 faceScope / requiredScope）可随计划**有意**更新快照；
// MCP wire 形状由 routes/mcp-faces.test.ts 的 tools/list key 集断言钉住（协议字段不外泄）。
import { describe, expect, it } from 'vitest'
import { ANALYST_TOOLS } from './registry'

describe('MCP 分析师面 golden', () => {
  it('ANALYST_TOOLS 逐字快照', () => {
    expect(ANALYST_TOOLS).toMatchSnapshot()
  })
})
