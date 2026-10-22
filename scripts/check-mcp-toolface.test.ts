// scripts/check-mcp-toolface.test.ts — 门禁判据纯函数 + 对真仓清单的断言。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// .mjs 经显式路径 import（scripts 内互相引用的既有手法）；ANALYST_TOOLS 经 .ts 后缀（tsx/vitest 均可解析）
import { checkToolface } from './check-mcp-toolface.mjs'
import { ANALYST_TOOLS, ANALYST_FACE_MAX_LIST_BYTES, ANALYST_FACE_MAX_TOOLS } from '../modules/data/domain/toolbox/registry.ts'

describe('checkToolface：四条判据', () => {
  const meta = (over: Record<string, unknown> = {}) => ({
    name: 'a_valid_name', mutating: false, annotations: { readOnlyHint: true }, requiredScope: 'data:read', ...over,
  })

  it('干净清单 ⇒ 0 条', () => {
    expect(checkToolface([meta()])).toEqual([])
  })
  it('工具数超限 ⇒ 1 条，带 [TOOLFACE]', () => {
    const out = checkToolface([meta(), meta()], { maxTools: 1 })
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('[TOOLFACE]')
  })
  it('体积超限 ⇒ 1 条', () => {
    const out = checkToolface([meta()], { maxBytes: 10 })
    expect(out.some((s) => s.includes('[TOOLFACE]'))).toBe(true)
  })
  it('坏名字逐个点名；mutating 无注解/无 scope 逐个点名', () => {
    const out = checkToolface([
      meta({ name: 'bad name!' }),
      meta({ mutating: true, annotations: undefined }),
      meta({ mutating: true, requiredScope: null }),
    ])
    expect(out.filter((s) => s.includes('bad name!'))).toHaveLength(1)
    expect(out.filter((s) => s.includes('a_valid_name') && s.includes('注解'))).toHaveLength(1)
    expect(out.filter((s) => s.includes('a_valid_name') && s.includes('scope'))).toHaveLength(1)
  })
})

describe('真仓 ANALYST_TOOLS 本身过门（防清单漂移，不等 CI 才红）', () => {
  it('11 ≤14；序列化 ≤10KB；名字全合法；mutating 全 false', () => {
    expect(checkToolface(ANALYST_TOOLS)).toEqual([])
    expect(ANALYST_TOOLS.length).toBeLessThanOrEqual(ANALYST_FACE_MAX_TOOLS)
    expect(JSON.stringify(ANALYST_TOOLS).length).toBeLessThanOrEqual(ANALYST_FACE_MAX_LIST_BYTES)
  })
  it('ci.yml 已接线本门（脚本存在但没接进 CI = 没固化，正典 §4.1 判据）', () => {
    const ci = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows', 'ci.yml'), 'utf8')
    expect(ci).toContain('check-mcp-toolface.mjs')
  })
})
