// routes/platform.ts — /api/platform/branding | /api/platform/config（Task 12）
//
// branding = 登录页运行时品牌的唯一来源（Task 17 挂载即取）；config = 控制台菜单数据
// （Task 19）。modules 清单与 enabledFor 由 Task 15 的 ModulesRuntime 接线注入——
// 本任务先给空默认实现，宿主（Task 16）装配时替换。
import { Hono } from 'hono'
import type { Pool } from 'pg'
import type { Context } from 'hono'
import type { SessionEnv } from '../session-middleware'
import type { TenantEnv } from '../tenant'

/** manifest.frontend.console 项的运行时形状（entry 是构建期关注点，不进 API） */
export interface ConsoleEntry {
  path: string
  title: string
  icon?: string
  scope: string
}

/** manifest.frontend.userApp 的运行时形状（spec 2026-11-01 §5.2）。 */
export interface UserAppEntry {
  /** 挂载前缀（静态产物所在，如 /app/aftersales） */
  mount: string
  /** 入口页卡片名；缺省用模块 name */
  title?: string
  icon?: string
  /** 进入该业务应用所需权限码；缺省 = 该租户启用即可 */
  scope?: string
}

/** 装配完成的模块信息（ModulesRuntime.modules → manifest 映射而来） */
export interface ModuleInfo {
  id: string
  name: string
  console: ConsoleEntry[]
  /** 移动端业务应用（有才出现在入口页/工作台） */
  userApp?: UserAppEntry
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

export function platformRoutes(deps: PlatformRoutesDeps) {
  const listModules = deps.modules ?? (() => [])
  const enabledFor = deps.enabledFor ?? (async () => new Set<string>())

  return new Hono<TenantEnv>()
    .get('/branding', (c) => {
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

    .get('/config', async (c) => {
      const t = c.get('tenant')
      const enabled = await enabledFor(t.id)
      const modules = listModules()
        .filter((m) => enabled.has(m.id)) // tenant_module 闸门
        .filter((m) => m.console.length > 0) // 无 console 的模块对控制台不可见
        .map((m) => ({ id: m.id, name: m.name, console: m.console }))
      return c.json({ tenant: { slug: t.slug, org: t.casdoor_org }, modules })
    })

    /**
     * 按人过滤的**业务应用入口**（spec 2026-11-01 §5.2 P2）。
     *
     * 为什么新开端点而不是改 `/config`：`/config` 是**匿名披露面**（只吃租户、不吃 identity），
     * 把按人过滤塞进去会改变它的语义，也会让「匿名能看到什么」变得依赖登录状态——
     * 那是这类面最容易出事的地方（缓存、代理、探测）。
     *
     * 授权口径与 console 目录一致：`userApp.scope` 有值 ⇒ 需 `hasScope`；无值 ⇒ 租户启用即可。
     * 停用闸门先过（与 API/静态面同形：停用 = 看不到）。
     */
    .get('/me/apps', async (c) => {
      // platform 路由的 env 只有 tenant；identity 由更早注册的 sessionMiddleware 注入
      // （app.use('*', sessionMiddleware) 在 platformRoutes 之前）。用 SessionEnv 视角读，
      // 避免把 TenantEnv 扩成"什么都有"的类型。
      const identity = (c as unknown as Context<SessionEnv>).get('identity')
      if (!identity) return c.json({ error: 'UNAUTHENTICATED' }, 401)
      const t = c.get('tenant')
      const enabled = await enabledFor(t.id)
      const apps = listModules()
        .filter((m) => enabled.has(m.id) && m.userApp !== undefined)
        .filter((m) => {
          const scope = m.userApp?.scope
          return scope === undefined || scope === '' || identity.hasScope(scope)
        })
        .map((m) => ({
          moduleId: m.id,
          mount: m.userApp!.mount,
          title: m.userApp!.title ?? m.name,
          icon: m.userApp!.icon ?? null,
          scope: m.userApp!.scope ?? null,
        }))
      return c.json({ apps })
    })
}
