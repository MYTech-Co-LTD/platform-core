// console-menu.test.ts — 菜单位置规则（spec §3）与三重过滤的纯函数测试（issue #36）
import { describe, expect, it } from 'vitest'
import type { ComponentType } from 'react'
import { TENANT_ADMIN_SCOPE, buildConsoleMenu, visibleAdminEntries, visibleConsoleEntries } from './console-menu'
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
    group: 'main',
    moduleId: 'ghost',
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
    const menu = buildConsoleMenu(visibleConsoleEntries(CONFIG, SESSION, REGISTRY), {}, SESSION, { adminEntries: [], storageVisible: true })
    expect(menu.map((m) => m.path)).toEqual(['/console', '/console/case-engine', '/console/first/a'])
  })
  it('case-engine 未落地/无权限时该位自然缺席，不产生空位', () => {
    const menu = buildConsoleMenu(visibleConsoleEntries(CONFIG, SESSION_PARTIAL, REGISTRY), {}, SESSION_PARTIAL, { adminEntries: [], storageVisible: true })
    expect(menu.map((m) => m.path)).toEqual(['/console', '/console/first/a'])
  })
})

// ---- M3：管理组（tenant:admin 门禁，spec D4/D9，issue #46）----
describe('buildConsoleMenu 管理组', () => {
  it('有 tenant:admin → 尾部追加「管理」组（四项子菜单）', () => {
    const menu = buildConsoleMenu([], {}, { scopes: ['tenant:admin'] }, { adminEntries: [], storageVisible: true })
    const group = menu.at(-1)
    expect(group?.name).toBe('管理')
    expect(group?.children?.map((c) => c.path)).toEqual([
      '/console/admin/users',
      '/console/admin/permissions',
      '/console/admin/subscriptions',
      '/console/admin/storage',
    ])
  })

  it('无 tenant:admin → 不出现管理组（模块页照旧）', () => {
    const menu = buildConsoleMenu([], {}, { scopes: ['demo:view'] }, { adminEntries: [], storageVisible: true })
    expect(menu.some((m) => m.name === '管理')).toBe(false)
  })

  it('TENANT_ADMIN_SCOPE 与服务端门禁同串', () => {
    expect(TENANT_ADMIN_SCOPE).toBe('tenant:admin')
  })
})

// ---- 模块管理页协议 + 存储页能力联动（2026-09-20 spec）----
describe('管理组联动', () => {
  const ADMIN_SESSION = { scopes: ['tenant:admin', 'demo:view'] }
  const regAdmin = (over: Partial<ConsoleRegistryEntry> = {}): ConsoleRegistryEntry => ({
    path: '/console/admin/demo/x',
    title: '演示管理页',
    group: 'admin',
    moduleId: 'demo',
    scope: 'demo:view',
    load: () => Promise.resolve({ default: (() => null) as ComponentType }),
    ...over,
  })

  it('storageVisible=false → 管理组四项变三项（存储配置消失）', () => {
    const menu = buildConsoleMenu([], {}, ADMIN_SESSION, { adminEntries: [], storageVisible: false })
    expect(menu.at(-1)?.children?.map((c) => c.path)).toEqual([
      '/console/admin/users',
      '/console/admin/permissions',
      '/console/admin/subscriptions',
    ])
  })

  it('storageVisible=true → 存储配置在第 4 位；模块 admin 页排其后', () => {
    const menu = buildConsoleMenu([], {}, ADMIN_SESSION, {
      adminEntries: [{ moduleId: 'demo', path: '/console/admin/demo/x', title: '演示管理页' }],
      storageVisible: true,
    })
    expect(menu.at(-1)?.children?.map((c) => c.path)).toEqual([
      '/console/admin/users',
      '/console/admin/permissions',
      '/console/admin/subscriptions',
      '/console/admin/storage',
      '/console/admin/demo/x',
    ])
  })

  it('visibleAdminEntries：模块停用（config 缺席）或无 scope 都被拦下', () => {
    const config = { tenant: { slug: 'acme', org: 'o' }, modules: [{ id: 'demo', name: '演示', console: [] }] }
    const on = visibleAdminEntries(config, ADMIN_SESSION, [regAdmin()])
    expect(on.map((e) => e.path)).toEqual(['/console/admin/demo/x'])
    // 模块停用：config 不含 demo
    const off = visibleAdminEntries({ ...config, modules: [] }, ADMIN_SESSION, [regAdmin()])
    expect(off).toEqual([])
    // scope 缺席
    const noScope = visibleAdminEntries(config, { scopes: ['tenant:admin'] }, [regAdmin()])
    expect(noScope).toEqual([])
  })

  it('group=main 的 registry 条目不进管理组（visibleAdminEntries 只认 admin）', () => {
    const config = { tenant: { slug: 'acme', org: 'o' }, modules: [{ id: 'demo', name: '演示', console: [] }] }
    const out = visibleAdminEntries(config, ADMIN_SESSION, [
      regAdmin({ path: '/console/demo', group: 'main' }),
    ])
    expect(out).toEqual([])
  })
})
