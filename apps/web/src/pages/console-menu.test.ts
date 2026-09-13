// console-menu.test.ts — 菜单位置规则（spec §3）与三重过滤的纯函数测试（issue #36）
import { describe, expect, it } from 'vitest'
import type { ComponentType } from 'react'
import { buildConsoleMenu, visibleConsoleEntries } from './console-menu'
import type { ConsoleRegistryEntry } from '../console-registry.gen'

const CONFIG = {
  tenant: { slug: 'acme', org: 'acme-org' },
  modules: [
    {
      id: 'first',
      name: '第一模块',
      console: [{ path: '/console/first/a', title: 'A 页', scope: 'first:view' }],
    },
    {
      id: 'case-engine',
      name: 'AI 助手',
      console: [{ path: '/console/case-engine', title: 'AI 助手', scope: 'case-engine:chat' }],
    },
    {
      id: 'ghosty',
      name: '幽灵模块',
      console: [
        { path: '/console/ghost/page', title: '幽灵页', scope: 'ghost:view' }, // registry 缺席
        { path: '/console/first/a', title: '重复声明', scope: 'first:view' }, // 同 path 去重
      ],
    },
  ],
}

const SESSION = { scopes: ['first:view', 'case-engine:chat', 'ghost:view'] }
const SESSION_PARTIAL = { scopes: ['first:view'] } // 无 case-engine 权限

function reg(path: string, scope: string): ConsoleRegistryEntry {
  return {
    path,
    title: path,
    scope,
    load: () => Promise.resolve({ default: (() => null) as ComponentType }),
  }
}
const REGISTRY = [reg('/console/first/a', 'first:view'), reg('/console/case-engine', 'case-engine:chat')]

describe('visibleConsoleEntries（三重过滤 + 去重）', () => {
  it('config∩registry∩scope 全过才可见；registry 缺席与同 path 重复声明被剔除', () => {
    const out = visibleConsoleEntries(CONFIG, SESSION, REGISTRY)
    expect(out.map((e) => e.path)).toEqual(['/console/first/a', '/console/case-engine'])
    expect(out[0]).toMatchObject({ moduleId: 'first', moduleName: '第一模块', title: 'A 页' })
  })
  it('无 scope 的项被拦下', () => {
    const out = visibleConsoleEntries(CONFIG, SESSION_PARTIAL, REGISTRY)
    expect(out.map((e) => e.path)).toEqual(['/console/first/a'])
  })
})

describe('buildConsoleMenu（spec §3 位置规则）', () => {
  it('概览恒第 1；case-engine 模块页钉第 2（即使 manifest 声明在后）；其余按声明序', () => {
    const menu = buildConsoleMenu(visibleConsoleEntries(CONFIG, SESSION, REGISTRY), {})
    expect(menu.map((m) => m.path)).toEqual(['/console', '/console/case-engine', '/console/first/a'])
  })
  it('case-engine 未落地/无权限时该位自然缺席，不产生空位', () => {
    const menu = buildConsoleMenu(visibleConsoleEntries(CONFIG, SESSION_PARTIAL, REGISTRY), {})
    expect(menu.map((m) => m.path)).toEqual(['/console', '/console/first/a'])
  })
})
