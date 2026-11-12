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
  /** 一句话说明「这页能干什么」；宿主统一渲染成页头说明（#1953 三期） */
  description?: string
  /** true = 不进模块侧栏（路由仍可达；入口由宿主另行提供） */
  menuHidden?: boolean
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
    path: "/console/aftersales/tickets",
    title: "工单",
    group: "main",
    moduleId: "aftersales",
    description: "门店报上来的售后单：查状态、看退款额、跟进处理。",
    scope: "aftersales:manage",
    load: () => import("../../../modules/aftersales/console/index.tsx"),
  },
  {
    path: "/console/aftersales/rules",
    title: "规则",
    group: "main",
    moduleId: "aftersales",
    description: "售后怎么判：什么情况退、退多少、要不要审批。改这里即时生效。",
    scope: "aftersales:manage",
    load: () => import("../../../modules/aftersales/console/index.tsx"),
  },
  {
    path: "/console/aftersales/employees",
    title: "员工",
    group: "main",
    moduleId: "aftersales",
    description: "门店员工档案与注册审批；只读为主。",
    scope: "aftersales:manage",
    load: () => import("../../../modules/aftersales/console/index.tsx"),
  },
  {
    path: "/console/aftersales/products",
    title: "商品",
    group: "main",
    moduleId: "aftersales",
    description: "商品档案（编码/名称/规格），售后判定要用到。",
    scope: "aftersales:manage",
    load: () => import("../../../modules/aftersales/console/index.tsx"),
  },
  {
    path: "/console/aftersales/stores",
    title: "门店",
    group: "main",
    moduleId: "aftersales",
    description: "门店档案（编号/名称/地址），售后单与员工都挂在门店下。",
    scope: "aftersales:manage",
    load: () => import("../../../modules/aftersales/console/index.tsx"),
  },
  {
    path: "/console/aftersales/approvals",
    title: "申请审批",
    group: "main",
    moduleId: "aftersales",
    description: "员工登记/变更申请的审批队列。",
    scope: "aftersales:manage",
    load: () => import("../../../modules/aftersales/console/index.tsx"),
  },
  {
    path: "/console/aftersales/links",
    title: "身份绑定",
    group: "main",
    moduleId: "aftersales",
    description: "员工与企微/Casdoor 账号的绑定关系；一个员工只应绑一个身份。",
    scope: "aftersales:manage",
    load: () => import("../../../modules/aftersales/console/index.tsx"),
  },
  {
    path: "/console/data",
    title: "数据分析",
    group: "main",
    moduleId: "data",
    icon: "BarChartOutlined",
    scope: "data:query",
    load: () => import("../../../modules/data/console/index.tsx"),
  },
  {
    path: "/console/data/metrics",
    title: "指标",
    group: "main",
    moduleId: "data",
    description: "指标是「一个数怎么算」的唯一定义；口径改这里，报表和问数一起生效。",
    scope: "data:query",
    load: () => import("../../../modules/data/console/index.tsx"),
  },
  {
    path: "/console/data/reports",
    title: "报表",
    group: "main",
    moduleId: "data",
    description: "把指标拼成业务看板；每张报表可单独设部门可见范围。",
    scope: "data:query",
    load: () => import("../../../modules/data/console/index.tsx"),
  },
  {
    path: "/console/data/scopes",
    title: "数据范围",
    group: "main",
    moduleId: "data",
    description: "决定谁能看哪些品牌/门店/品类：先建范围，再分配到部门（主）、角色或人（例外）。",
    menuHidden: true,
    scope: "data:manage",
    load: () => import("../../../modules/data/console/index.tsx"),
  },
  {
    path: "/console/data/candidates",
    title: "可能的指标",
    group: "main",
    moduleId: "data",
    description: "从源数据自动推导出的候选指标；采用后才会变成正式指标。",
    scope: "data:manage",
    load: () => import("../../../modules/data/console/index.tsx"),
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
  {
    path: "/console/forms",
    title: "表单",
    group: "main",
    moduleId: "forms",
    icon: "FileTextOutlined",
    scope: "forms:view",
    load: () => import("../../../modules/forms/console/index.tsx"),
  },
  {
    path: "/console/notify",
    title: "通知",
    group: "main",
    moduleId: "notify",
    icon: "BellOutlined",
    scope: "notify:view",
    load: () => import("../../../modules/notify/console/index.tsx"),
  },
  {
    path: "/console/notify/events",
    title: "事件目录",
    group: "main",
    moduleId: "notify",
    description: "各模块声明了哪些可订阅的事件；配规则时从这里选事件。",
    scope: "notify:view",
    load: () => import("../../../modules/notify/console/index.tsx"),
  },
  {
    path: "/console/notify/rules",
    title: "规则",
    group: "main",
    moduleId: "notify",
    description: "谁在什么情况下收到通知：事件 × 作用域 × 收件人 × 模板 × 通道。",
    scope: "notify:view",
    load: () => import("../../../modules/notify/console/index.tsx"),
  },
  {
    path: "/console/notify/templates",
    title: "模板",
    group: "main",
    moduleId: "notify",
    description: "通知文案按通道编辑、预览、发版；发错了可回滚到上一版。",
    scope: "notify:view",
    load: () => import("../../../modules/notify/console/index.tsx"),
  },
  {
    path: "/console/notify/channels",
    title: "通道",
    group: "main",
    moduleId: "notify",
    description: "出站渠道（企微群/邮件…）的凭据状态与健康检查；密钥只显示 env 键名。",
    scope: "notify:view",
    load: () => import("../../../modules/notify/console/index.tsx"),
  },
  {
    path: "/console/notify/deliveries",
    title: "投递",
    group: "main",
    moduleId: "notify",
    description: "每条通知投给谁、成没成；失败的可以单条重试。",
    scope: "notify:view",
    load: () => import("../../../modules/notify/console/index.tsx"),
  },
  {
    path: "/console/notify/inbox",
    title: "收件箱",
    group: "main",
    moduleId: "notify",
    description: "发给我的通知副本；已读不代表已办。",
    scope: "notify:view",
    load: () => import("../../../modules/notify/console/index.tsx"),
  },
]

export const storageDeclarers: string[] = ["aftersales"]
