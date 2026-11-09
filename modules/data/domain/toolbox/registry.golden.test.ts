// registry.golden.test.ts — 迁移前后 MCP 工具面逐字一致的快照门。
// 这个快照在重构前生成；重构后必须**不更新快照**也通过。
import { describe, expect, it } from 'vitest'
import { ANALYST_TOOLS } from './registry'

describe('MCP 分析师面 golden', () => {
  it('ANALYST_TOOLS 逐字快照', () => {
    expect(ANALYST_TOOLS).toMatchSnapshot()
  })
})
