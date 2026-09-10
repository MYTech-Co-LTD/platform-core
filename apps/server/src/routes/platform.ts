// routes/platform.ts — /api/platform/branding | /api/platform/config（Task 12）
//
// branding = 登录页运行时品牌的唯一来源（Task 17 挂载即取）；config = 控制台菜单数据
// （Task 19）。modules 清单与 enabledFor 由 Task 15 的 ModulesRuntime 接线注入——
// 本任务先给空默认实现，宿主（Task 16）装配时替换。
import { Hono } from 'hono'
import type { Pool } from 'pg'
import type { TenantEnv } from '../tenant'

/** manifest.frontend.console 项的运行时形状（entry 是构建期关注点，不进 API） */
export interface ConsoleEntry {
  path: string
  title: string
  icon?: string
  scope: string
}

/** 装配完成的模块信息（ModulesRuntime.modules → manifest 映射而来） */
export interface ModuleInfo {
  id: string
  name: string
  console: ConsoleEntry[]
}

export interface PlatformRoutesDeps {
  /** 预留 Task 15 ModulesRuntime 接线（branding/config 消费中间件注入的 tenant 行，不直接查库） */
  pool: Pool
  /** 全量已装配模块；默认空——Task 15 接线时替换 */
  modules?: () => Array<ModuleInfo>
  /** 租户已启用模块 id 集；默认恒空集——Task 15 接线时替换（无行视为启用） */
  enabledFor?: (tenantId: number) => Promise<Set<string>>
}

/** 企微登录方法（开了且配了 corpId 才回传 wecomCorpId，未开不暴露） */
const WECOM_LOGIN_METHODS = new Set(['wecom-qr', 'wecom-silent'])

export function platformRoutes(deps: PlatformRoutesDeps): Hono<TenantEnv> {
  const listModules = deps.modules ?? (() => [])
  const enabledFor = deps.enabledFor ?? (async () => new Set<string>())

  const app = new Hono<TenantEnv>()

  app.get('/branding', (c) => {
    const t = c.get('tenant')
    const branding: {
      productName: string
      logo: string | null
      primaryColor: string
      background: string
      loginMethods: string[]
      wecomCorpId?: string
    } = {
      productName: t.product_name,
      logo: t.logo,
      primaryColor: t.primary_color,
      background: t.background,
      loginMethods: t.login_methods,
    }
    if (t.login_methods.some((m) => WECOM_LOGIN_METHODS.has(m)) && t.wecom_corp_id) {
      branding.wecomCorpId = t.wecom_corp_id
    }
    return c.json(branding)
  })

  app.get('/config', async (c) => {
    const t = c.get('tenant')
    const enabled = await enabledFor(t.id)
    const modules = listModules()
      .filter((m) => enabled.has(m.id)) // tenant_module 闸门
      .filter((m) => m.console.length > 0) // 无 console 的模块对控制台不可见
      .map((m) => ({ id: m.id, name: m.name, console: m.console }))
    return c.json({ tenant: { slug: t.slug, org: t.casdoor_org }, modules })
  })

  return app
}
