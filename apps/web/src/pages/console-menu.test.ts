// console-menu.test.ts — 菜单位置规则（spec §3）与三重过滤的纯函数测试（issue #36）
import { describe, expect, it } from 'vitest'
import type { ComponentType } from 'react'
import {
  TENANT_ADMIN_SCOPE, buildConsoleMenu, entriesToMenuItems, visibleAdminEntries, visibleConsoleEntries,
} from './console-menu'
import type { ConsoleRegistryEntry } from '../console-registry.gen'
import type { MenuDataItem } from '@ant-design/pro-components'

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

/** 管理组是按「用户任务」分段的嵌套结构（#1953）；断言一律比叶子路径，避免绑死分组层级数。 */
function leafPaths(node: MenuDataItem | undefined): string[] {
  if (!node) return []
  const kids = node.children ?? []
  if (kids.length === 0) return node.path ? [node.path] : []
  return kids.flatMap((c) => leafPaths(c))
}

describe('buildConsoleMenu（spec §3 位置规则）', () => {
  it('概览恒第 1；case-engine 模块页钉第 2（即使 manifest 声明在后）；其余按声明序', () => {
    const menu = buildConsoleMenu(visibleConsoleEntries(CONFIG, SESSION, REGISTRY), {}, SESSION, {
      adminEntries: [],
      storageVisible: true,
      dataScopesVisible: false,
    })
    expect(menu.map((m) => m.path)).toEqual(['/console', '/console/case-engine', '/console/first/a'])
  })
  it('case-engine 未落地/无权限时该位自然缺席，不产生空位', () => {
    const menu = buildConsoleMenu(visibleConsoleEntries(CONFIG, SESSION_PARTIAL, REGISTRY), {}, SESSION_PARTIAL, {
      adminEntries: [],
      storageVisible: true,
      dataScopesVisible: false,
    })
    expect(menu.map((m) => m.path)).toEqual(['/console', '/console/first/a'])
  })
})

// ---- #1953 二期：左侧多级菜单 ----
describe('entriesToMenuItems（模块区二级菜单）', () => {
  const entry = (path: string, title: string, icon?: string) => ({
    moduleId: path.split('/')[2] ?? '',
    moduleName: title,
    path,
    title,
    ...(icon !== undefined ? { icon } : {}),
  })

  it('父条目收成分组标题，子页按声明序排在下面（父不可点，避免与首个子页重复）', () => {
    const items = entriesToMenuItems([
      entry('/console/data', '数据分析', 'BarChartOutlined'),
      entry('/console/data/query', '问数'),
      entry('/console/data/metrics', '指标'),
    ], {})
    expect(items).toHaveLength(1)
    expect(items[0]?.path).toBeUndefined()
    expect(items[0]?.name).toBe('数据分析')
    expect(items[0]?.children?.map((c) => [c.path, c.name])).toEqual([
      ['/console/data/query', '问数'],
      ['/console/data/metrics', '指标'],
    ])
  })

  it('没有子页的条目仍是可点叶子（path 保留）', () => {
    const items = entriesToMenuItems([entry('/console/demo', '演示', 'ExperimentOutlined')], {})
    expect(items.map((m) => m.path)).toEqual(['/console/demo'])
    expect(items[0]?.children).toBeUndefined()
  })
})

// ---- M3：管理组（tenant:admin 门禁，spec D4/D9，issue #46）----
describe('buildConsoleMenu 管理组', () => {
  it('有 tenant:admin → 尾部追加「管理」组，按 成员/权限/接入 三段分组', () => {
    const menu = buildConsoleMenu([], {}, { scopes: ['tenant:admin'] }, {
      adminEntries: [],
      storageVisible: true,
      dataScopesVisible: false,
    })
    const group = menu.at(-1)
    expect(group?.name).toBe('管理')
    expect(group?.children?.map((c) => c.name)).toEqual(['成员与组织', '角色与权限', '接入与设置'])
    expect(group?.children?.[0]?.children?.map((c) => c.path)).toEqual([
      '/console/admin/users',
      '/console/admin/org-tree',
    ])
    expect(group?.children?.[1]?.children?.map((c) => c.path)).toEqual([
      '/console/admin/roles',
      '/console/admin/permissions',
    ])
    expect(leafPaths(group)).toEqual([
      '/console/admin/users',
      '/console/admin/org-tree',
      '/console/admin/roles',
      '/console/admin/permissions',
      '/console/admin/subscriptions',
      '/console/admin/keys',
      '/console/admin/integrations',
      '/console/admin/storage',
    ])
  })


  it('数据范围：只在「管理 → 角色与权限」出现一次；模块侧栏不再重复（menu:false）', () => {
    const menu = buildConsoleMenu(
      [
        { moduleId: 'data', moduleName: '数据分析', path: '/console/data', title: '数据分析' },
        { moduleId: 'data', moduleName: '数据分析', path: '/console/data/metrics', title: '指标' },
        { moduleId: 'data', moduleName: '数据分析', path: '/console/data/scopes', title: '数据范围', menuHidden: true },
      ],
      {},
      { scopes: ['tenant:admin', 'data:manage'] },
      { adminEntries: [], storageVisible: false, dataScopesVisible: true },
    )
    const dataGroup = menu.find((m) => m.name === '数据分析')
    expect(dataGroup?.children?.map((c) => c.path)).toEqual(['/console/data/metrics'])
    const admin = menu.find((m) => m.name === '管理')
    const paths = (admin?.children ?? []).flatMap((g) => (g.children ?? []).map((c) => c.path))
    expect(paths.filter((p) => p === '/console/data/scopes')).toHaveLength(1)
  })

  it('无 data:manage → 管理组里也不出现数据范围', () => {
    const menu = buildConsoleMenu([], {}, { scopes: ['tenant:admin'] }, {
      adminEntries: [], storageVisible: true, dataScopesVisible: false,
    })
    const paths = (menu.at(-1)?.children ?? []).flatMap((g) => (g.children ?? []).map((c) => c.path))
    expect(paths).not.toContain('/console/data/scopes')
  })

  it('模块外链（体系地图）：持 data:query 时挂在「数据分析」组末尾，路径是外链地址', () => {
    const menu = buildConsoleMenu(
      [
        { moduleId: 'data', moduleName: '数据分析', path: '/console/data', title: '数据分析' },
        { moduleId: 'data', moduleName: '数据分析', path: '/console/data/metrics', title: '指标' },
      ],
      {},
      { scopes: ['data:query'] },
      { adminEntries: [], storageVisible: false, dataScopesVisible: false },
    )
    const grp = menu.find((m) => m.name === '数据分析')
    expect(grp?.children?.map((c) => [c.name, c.path])).toEqual([
      ['指标', '/console/data/metrics'],
      ['体系地图', '/api/modules/data/system-map#/overview'],
    ])
  })

  it('模块外链：无 data:query 时不出现', () => {
    const menu = buildConsoleMenu(
      [{ moduleId: 'data', moduleName: '数据分析', path: '/console/data', title: '数据分析' }],
      {},
      { scopes: ['other:view'] },
      { adminEntries: [], storageVisible: false, dataScopesVisible: false },
    )
    expect(JSON.stringify(menu)).not.toContain('system-map')
  })

  it('无 tenant:admin → 不出现管理组（模块页照旧）', () => {
    const menu = buildConsoleMenu([], {}, { scopes: ['demo:view'] }, {
      adminEntries: [],
      storageVisible: true,
      dataScopesVisible: false,
    })
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

  it('storageVisible=false → 存储配置消失（组织架构/角色管理恒在）', () => {
    const menu = buildConsoleMenu([], {}, ADMIN_SESSION, {
      adminEntries: [],
      storageVisible: false,
      dataScopesVisible: false,
    })
    expect(leafPaths(menu.at(-1))).toEqual([
      '/console/admin/users',
      '/console/admin/org-tree',
      '/console/admin/roles',
      '/console/admin/permissions',
      '/console/admin/subscriptions',
      '/console/admin/keys',
      '/console/admin/integrations',
    ])
  })

  it('storageVisible=true → 存储配置在模块 admin 页之前；模块 admin 页排其后', () => {
    const menu = buildConsoleMenu([], {}, ADMIN_SESSION, {
      adminEntries: [{ moduleId: 'demo', path: '/console/admin/demo/x', title: '演示管理页' }],
      storageVisible: true,
      dataScopesVisible: false,
    })
    expect(leafPaths(menu.at(-1))).toEqual([
      '/console/admin/users',
      '/console/admin/org-tree',
      '/console/admin/roles',
      '/console/admin/permissions',
      '/console/admin/subscriptions',
      '/console/admin/keys',
      '/console/admin/integrations',
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
