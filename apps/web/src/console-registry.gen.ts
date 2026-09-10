// @generated —— scripts/gen-console-registry.mjs 生成物，勿手改（build 前置自动重生成）。
// 来源：modules/*/manifest.yaml 的 frontend.console。无模块/无 console 项 → 空数组（合法）。
import type { ComponentType } from 'react'

export interface ConsoleRegistryEntry {
  /** 模块 console 页路由（全路径，以 /console/ 开头），与 manifest frontend.console.path 一致 */
  path: string
  title: string
  /** AntD 图标名（字符串透传；Console 壳按名映射，未知名不渲染图标） */
  icon?: string
  /** 访问该页所需权限 scope（session.scopes 成员判定） */
  scope: string
  /** 构建期聚合的懒加载器：模块 console 页模块的 default 导出（组件） */
  load: () => Promise<{ default: ComponentType }>
}

export const consoleRegistry: ConsoleRegistryEntry[] = []
