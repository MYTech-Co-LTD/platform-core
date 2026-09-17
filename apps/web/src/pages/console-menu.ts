// console-menu.ts — 菜单与工作台共用的「可见模块页」计算（SaaS 化改造，issue #36）。
//
// 位置规则唯一事实源：docs/superpowers/specs/2026-09-13-console-saas-ui-blueprint-design.md §3——
// 概览(1) → pinned 模块(2) → 其余模块页按 manifest 声明序。三重过滤（config∩registry∩scope）
// 与去重（同 path 首个声明者胜）沿袭 Task 18 语义，本文件只是把它抽成纯函数供菜单与工作台共用。
import type { ReactNode } from 'react'
import type { MenuDataItem } from '@ant-design/pro-components'
import type { ConsoleRegistryEntry } from '../console-registry.gen'
import type { PlatformConfig } from '../lib/api'

/** spec §3 第 2 位：AI 助手（case-engine 模块）。模块未落地时该位自然缺席。 */
const PINNED_MODULE_IDS: readonly string[] = ['case-engine']

/**
 * spec D9：租户管理员识别码——「管理」组与 /console/admin/* 的门禁。
 * 与服务端 requireScope('tenant:admin')、loader 的 PLATFORM_BUILTIN_PERMISSIONS 同串
 * （三处字面量，漂移由各自的单测钉住——本文件用例断言其值）。
 */
export const TENANT_ADMIN_SCOPE = 'tenant:admin'

/**
 * 尾部的「管理」组（spec §3 第 4 位「平台管理」的 M3 落地子集；「帮助▾」仍留白）。
 * 平台内置页不走 registry 聚合（那是模块协议的地盘），是壳侧固定分组——门禁 = session 有
 * tenant:admin（调用方传入，本函数只按 scope 判定，与模块页三重过滤同一判定语义）。
 */
function adminGroup(iconMap: Record<string, ReactNode>): MenuDataItem {
  return {
    path: '/console/admin',
    name: '管理',
    icon: iconMap['TeamOutlined'],
    children: [
      { path: '/console/admin/users', name: '用户管理' },
      { path: '/console/admin/permissions', name: '角色与授权' },
      { path: '/console/admin/subscriptions', name: '我的订阅' },
      // 存储配置（M3c）：**不设图标** —— CONSOLE_ICONS 要求图标名先登记才渲染，不设就不欠这笔账
      { path: '/console/admin/storage', name: '存储配置' },
    ],
  }
}

export interface VisibleConsoleEntry {
  moduleId: string
  moduleName: string
  path: string
  title: string
  icon?: string
}

export interface ScopeLike {
  scopes: string[]
}

/** 三重过滤 + 去重后的可见模块页（config ∩ registry ∩ scope），保持 manifest 声明序 */
export function visibleConsoleEntries(
  config: PlatformConfig,
  session: ScopeLike,
  registry: ConsoleRegistryEntry[],
): VisibleConsoleEntry[] {
  const out: VisibleConsoleEntry[] = []
  const seen = new Set<string>()
  for (const m of config.modules) {
    for (const c of m.console) {
      if (seen.has(c.path)) continue // 同 path 只出一次（首个声明者胜）
      seen.add(c.path)
      const reg = registry.find((r) => r.path === c.path)
      if (!reg) continue // config 有但构建期没挂载（新模块未发布）→ 不可见
      if (!session.scopes.includes(c.scope)) continue // 权限门禁
      out.push({ moduleId: m.id, moduleName: m.name, path: reg.path, title: c.title, icon: c.icon ?? reg.icon })
    }
  }
  return out
}

/** 顶栏菜单：概览 → pinned 模块页 → 其余模块页（manifest 序）→ 管理组（tenant:admin 门禁） */
export function buildConsoleMenu(
  entries: VisibleConsoleEntry[],
  iconMap: Record<string, ReactNode>,
  session: ScopeLike,
): MenuDataItem[] {
  const pinned = entries.filter((e) => PINNED_MODULE_IDS.includes(e.moduleId))
  const rest = entries.filter((e) => !PINNED_MODULE_IDS.includes(e.moduleId))
  const items: MenuDataItem[] = [
    { path: '/console', name: '概览' },
    ...[...pinned, ...rest].map((e) => ({
      path: e.path,
      name: e.title,
      icon: iconMap[e.icon ?? ''],
    })),
  ]
  return session.scopes.includes(TENANT_ADMIN_SCOPE) ? [...items, adminGroup(iconMap)] : items
}
