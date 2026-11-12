// scripts/check-mcp-toolface.test.ts — 门禁判据纯函数 + 对真仓清单的断言。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// .mjs 经显式路径 import（scripts 内互相引用的既有手法）；ANALYST_TOOLS 经 .ts 后缀（tsx/vitest 均可解析）
import { checkToolface } from './check-mcp-toolface.mjs'
import { ANALYST_TOOLS, ANALYST_FACE_MAX_LIST_BYTES, ANALYST_FACE_MAX_TOOLS } from '../modules/data/domain/toolbox/registry.ts'
import { MANAGE_FACE_MAX_TOOLS, MANAGE_TOOLS } from '../modules/data/domain/manage-face.ts'
import { MANAGE_FACE_COMBINED_MAX_TOOLS, MANAGE_FACE_MAX_LIST_BYTES, MANAGE_FACE_TOOLS } from '../modules/data/routes/mcp-manage-face.ts'

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

describe('真仓 manage 面清单本身过门（防清单漂移，不等 CI 才红）', () => {
  it('11 ≤11；序列化 ≤10KB；名字全合法；mutating 全有注解与 scope', () => {
    expect(checkToolface(MANAGE_TOOLS, { maxTools: MANAGE_FACE_MAX_TOOLS })).toEqual([])
    expect(MANAGE_TOOLS.length).toBe(MANAGE_FACE_MAX_TOOLS)
    expect(JSON.stringify(MANAGE_TOOLS).length).toBeLessThanOrEqual(ANALYST_FACE_MAX_LIST_BYTES)
  })
})

describe('真仓合并 manage 面（三片静态事实源 mcp-manage-face.ts，P1 Task 6 扩面）', () => {
  it('超限桩 face ⇒ 红且点名（体积量的是 wire——tools/list 的真实形状）', () => {
    const stub = [{
      name: 'stub_tool', mutating: false, requiredScope: null, annotations: { readOnlyHint: true },
      wire: { name: 'stub_tool', description: 'x'.repeat(MANAGE_FACE_MAX_LIST_BYTES) },
    }]
    const out = checkToolface(stub, { maxTools: MANAGE_FACE_COMBINED_MAX_TOOLS, maxBytes: MANAGE_FACE_MAX_LIST_BYTES })
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('[TOOLFACE]')
    expect(out[0]).toContain('字节')
  })

  it('wire 小而元数据大 ⇒ 不误红（bytes 走 wire 投影，不吃元数据的治理字段）', () => {
    const stub = [{ name: 'ok_tool', mutating: false, requiredScope: null, annotations: { readOnlyHint: true }, wire: { name: 'ok_tool' } }]
    expect(checkToolface(stub, { maxBytes: 100 })).toEqual([])
  })

  it('工具数超限 ⇒ 红（合并面上限是独立常数，不是借用代理面的 11）', () => {
    const stubs = Array.from({ length: MANAGE_FACE_COMBINED_MAX_TOOLS + 1 }, (_, i) => ({
      name: `tool_${i}`, mutating: false, requiredScope: null, annotations: { readOnlyHint: true },
      wire: { name: `tool_${i}` },
    }))
    const out = checkToolface(stubs, { maxTools: MANAGE_FACE_COMBINED_MAX_TOOLS, maxBytes: MANAGE_FACE_MAX_LIST_BYTES })
    expect(out.some((s) => s.includes('个 > 上限'))).toBe(true)
  })

  it('真仓合并面 20 件过门：wire 序列化 ≤10KB、名字全合法、mutating 全有注解与 scope', () => {
    expect(MANAGE_FACE_TOOLS).toHaveLength(20)
    expect(checkToolface(MANAGE_FACE_TOOLS, { maxTools: MANAGE_FACE_COMBINED_MAX_TOOLS, maxBytes: MANAGE_FACE_MAX_LIST_BYTES })).toEqual([])
    expect(JSON.stringify(MANAGE_FACE_TOOLS.map((t) => t.wire)).length).toBeLessThanOrEqual(MANAGE_FACE_MAX_LIST_BYTES)
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
