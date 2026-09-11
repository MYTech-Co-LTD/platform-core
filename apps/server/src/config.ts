// config.ts — 宿主环境变量装配（fail-fast：配置错误在启动期全部暴露，绝不带病起服务）
//
// 键全集以根 .env.example 为准（B9 完整约束）；.env 文件装载由宿主入口 `dotenv/config`
// 负责（Task 16），本模块只读传入 env（默认 process.env）——测试注入显式对象、零进程污染。
// 校验规则（计划 Task 11）：
//   - TENANT_MODE ∈ {multi, single}，否则抛错；
//   - single 模式 PLATFORM_ORG 必填（multi 模式租户 org 由域名解析得出，可缺省）；
//   - PLATFORM_SESSION_SECRET ≥ 32 字符（会话签名密钥强度下限；密钥专用不复用于其他 JWT）。
export type TenantMode = 'multi' | 'single'

export interface CasdoorConfig {
  url: string
  clientId: string
  /** .env.example 默认留空：纯 mock/延迟接入场景允许空串，真实调用由 CasdoorClient 自行兜底 */
  clientSecret: string
  /**
   * Casdoor 管理端点凭据，**必填**（启动期 fail-fast）。
   *
   * 它不只服务权限码供给：登录签发前必调 getUser + getPermissions（`routes/auth.ts`），
   * 两者都走 admin 会话 ⇒ 缺凭据时**没有人能拿到会话**（登录一律 502）。所以「只登录不
   * 管理」不是一种可用的部署形态，缺凭据的实例起得来也毫无用处——不如启动期就报错。
   */
  adminUser: string
  adminPwd: string
  /** /api/login 的 application 形参（org 用户密码验证需其 signupApplication），可空走 CasdoorClient 默认 */
  application?: string
}

export interface AppConfig {
  port: number
  databaseUrl: string
  tenantMode: TenantMode
  /**
   * single 模式 = 唯一租户的 casdoor org（必填，配错的表现是启动期报「租户不存在」）。
   * multi 模式下本值**不参与租户解析，也不参与模块权限码供给**（后者按 platform.tenant
   * 的各租户 org 逐个进行）——留空即可，留了也不起作用。
   * 注意：本值不会在 multi 下被强制清空（下面 optional() 的语义是"空/空白 → undefined"），
   * 别把"multi 下它一定为空"当成可以依赖的前提。
   */
  platformOrg: string
  sessionSecret: string
  casdoor: CasdoorConfig
  publicOrigin: string
  /** SEED_DEMO=1 → 宿主启动期跑 demo 种子（幂等收敛，dev/冒烟用；Task 16 消费） */
  seedDemo: boolean
}

/** 可注入的 env 源（键 → 值/未设置），默认进程环境 */
export type Env = Record<string, string | undefined>

export function loadConfig(env: Env = process.env): AppConfig {
  const tenantMode = env.TENANT_MODE
  if (tenantMode !== 'multi' && tenantMode !== 'single') {
    throw new Error(`TENANT_MODE 必须是 multi/single，当前=${JSON.stringify(tenantMode ?? null)}`)
  }

  // 必填：缺值或全空白视为缺失；返回原始值（不做裁剪，防截断真实凭据）
  const requireValue = (key: string): string => {
    const raw = env[key]
    if (raw === undefined || raw.trim() === '') throw new Error(`缺少必填环境变量 ${key}`)
    return raw
  }
  // 可选：空/空白 → undefined（强类型里不出现空串假值）
  const optional = (key: string): string | undefined => {
    const v = env[key]?.trim()
    return v ? v : undefined
  }

  const platformOrg = optional('PLATFORM_ORG') ?? ''
  if (tenantMode === 'single' && platformOrg === '') {
    throw new Error('TENANT_MODE=single 时 PLATFORM_ORG 必填（唯一租户的 casdoor org）')
  }

  const sessionSecret = requireValue('PLATFORM_SESSION_SECRET')
  if (sessionSecret.length < 32) {
    throw new Error(`PLATFORM_SESSION_SECRET 至少 32 字符（当前 ${sessionSecret.length}）`)
  }

  const port = Number(requireValue('PORT'))
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT 必须是 1-65535 的整数，当前=${JSON.stringify(env.PORT)}`)
  }

  return {
    port,
    databaseUrl: requireValue('DATABASE_URL'),
    tenantMode,
    platformOrg,
    sessionSecret,
    casdoor: {
      url: requireValue('CASDOOR_URL'),
      clientId: requireValue('CASDOOR_CLIENT_ID'),
      clientSecret: optional('CASDOOR_CLIENT_SECRET') ?? '',
      // 必填：缺凭据时平台 100% 不可用（见 CasdoorConfig.adminUser 的说明）
      adminUser: requireValue('CASDOOR_ADMIN_USER'),
      adminPwd: requireValue('CASDOOR_ADMIN_PWD'),
      application: optional('CASDOOR_APPLICATION'),
    },
    publicOrigin: requireValue('PUBLIC_ORIGIN'),
    seedDemo: env.SEED_DEMO === '1',
  }
}
