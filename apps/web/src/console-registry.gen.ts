// @generated —— scripts/gen-console-registry.mjs 生成物，勿手改（build 前置自动重生成）。
// 来源：modules/*/manifest.yaml 的 frontend.console / frontend.admin（group 区分）与 storage（storageDeclarers）。
// 无模块/无 console 项 → 空数组（合法）。
import type { ComponentType } from 'react'

export interface ConsoleRegistryEntry {
  /** 模块 console 页路由（全路径，以 /console/ 开头），与 manifest frontend.console.path 一致 */
  path: string
  title: string
  /** 'main' = 模块区平铺页（frontend.console）；'admin' = 「管理」组子页（frontend.admin） */
  group: 'main' | 'admin'
  /** 声明该页的模块 id（运行时与 config 启用集做联动判定） */
  moduleId: string
  /** AntD 图标名（字符串透传；Console 壳按名映射，未知名不渲染图标） */
  icon?: string
  /** 访问该页所需权限 scope（session.scopes 成员判定） */
  scope: string
  /** 构建期聚合的懒加载器：模块 console 页模块的 default 导出（组件） */
  load: () => Promise<{ default: ComponentType }>
}

export const consoleRegistry: ConsoleRegistryEntry[] = [
  {
    path: "/console/aftersales",
    title: "售后管理",
    group: "main",
    moduleId: "aftersales",
    icon: "ToolOutlined",
    scope: "aftersales:manage",
    load: () => import("../../../modules/aftersales/console/index.tsx"),
  },
  {
    path: "/console/demo",
    title: "演示",
    group: "main",
    moduleId: "demo",
    icon: "ExperimentOutlined",
    scope: "demo:view",
    load: () => import("../../../modules/demo/console/index.tsx"),
  },
]

export const storageDeclarers: string[] = ["aftersales"]
