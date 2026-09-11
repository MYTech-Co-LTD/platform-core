import { z } from 'zod'

/**
 * 模块接入协议（Task 8，B4/B5 机检的契约源）。
 * manifest.yaml 是整个底座的接入协议：装载器与 scripts/check-manifests.mjs 都吃这个 schema。
 */
/** api.internal 的条目：一条 = 一个被声明的模块 API 端点。**未声明 = 不可达**（宿主门卫施加） */
export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface ModuleApiEndpoint {
  method: ApiMethod
  /** 模块内相对路径，必须以 / 开头（与 router 注册的路径模式逐字一致，装载期双向核对） */
  path: string
  scope: string
}

export interface ModuleManifest {
  id: string; name: string; version: string; platform: string
  permissions: Array<{ code: string; name: string }>
  api?: { internal?: ModuleApiEndpoint[] }
  frontend?: { userApp?: { mount: string; dist: string };
    console?: Array<{ path: string; title: string; icon?: string; scope: string; entry: string }> }
  migrations?: { dir: string }
  bindings?: Record<string, 'required' | 'optional'>
  notifications?: { dir: string }
  config?: { schema: string }
}

// B4：命名空间三同之一——模块 id 即权限命名空间，小写 kebab-case。
const ID_REGEX = /^[a-z][a-z0-9-]*$/
// 宽松 semver：三段数字。
const VERSION_REGEX = /^[0-9]+[.][0-9]+[.][0-9]+$/
// 平台版本约束：以 >= 或 > 开头指向数字（如 >=0.1.0 / >0.1）；裸版本号（如 0.1.2）不合法。
const PLATFORM_REGEX = /^>=?[0-9]/

const ManifestObject = z.object({
  id: z.string().regex(ID_REGEX, `id 必须匹配 ^[a-z][a-z0-9-]*$`),
  name: z.string(),
  version: z.string().regex(VERSION_REGEX, 'version 必须是 x.y.z 三段数字（宽松 semver）'),
  platform: z.string().regex(PLATFORM_REGEX, 'platform 必须匹配 ^>=?[0-9]（如 >=0.1.0）'),
  permissions: z.array(z.object({ code: z.string(), name: z.string() })),
  api: z.object({
    internal: z.array(z.object({
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
      path: z.string().regex(/^\//, 'api.internal[].path 必须以 / 开头（模块内相对路径）'),
      scope: z.string(),
    })).optional(),
  }).optional(),
  frontend: z.object({
    userApp: z.object({ mount: z.string(), dist: z.string() }).optional(),
    console: z.array(z.object({
      path: z.string(),
      title: z.string(),
      icon: z.string().optional(),
      scope: z.string(),
      entry: z.string(),
    })).optional(),
  }).optional(),
  migrations: z.object({ dir: z.string() }).optional(),
  bindings: z.record(z.string(), z.enum(['required', 'optional'])).optional(),
  notifications: z.object({ dir: z.string() }).optional(),
  config: z.object({ schema: z.string() }).optional(),
})

export const ManifestSchema = ManifestObject.superRefine((m, ctx) => {
  // B4：permissions[].code 必须落在模块自己的命名空间里（id + ':' 前缀）。
  for (const [i, p] of m.permissions.entries()) {
    if (!p.code.startsWith(m.id + ':')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['permissions', i, 'code'],
        message: `permission.code 必须以 "${m.id}:" 开头（got "${p.code}"）`,
      })
    }
  }

  // R2：api.internal[].scope 必须 ∈ 本模块 permissions[].code —— 否则模块声明一个自己都没有
  // 的码，该路径恒 403 而无人知晓（与"忘挂 requireScope"同一种病的变种）。由 schema 承载 ⇒
  // 运行时装载与 check-manifests 门禁同时覆盖。
  const codes = new Set(m.permissions.map((p) => p.code))
  const seenEndpoints = new Set<string>()
  for (const [i, e] of (m.api?.internal ?? []).entries()) {
    if (!codes.has(e.scope)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['api', 'internal', i, 'scope'],
        message: `api.internal[].scope "${e.scope}" 不在本模块 permissions[].code 内（模块只能声明自己的权限码）`,
      })
    }
    const key = `${e.method} ${e.path}`
    if (seenEndpoints.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['api', 'internal', i],
        message: `api.internal 重复声明 ${key}（同 (method,path) 只能有一条，否则门卫二义）`,
      })
    }
    seenEndpoints.add(key)
  }
})

export type ModuleManifestInferred = z.infer<typeof ManifestSchema>

// 编译期防漂移：schema 推断类型必须与接口双向一致。_AssertTrue 的泛型约束 <T extends true>
// 让"求值结果不是 true"成为真实 type 错误（单纯的条件类型别名未使用时无论求值成什么都不报错）。
// 失败分支必须是 false 而非 never——never 可赋值给任何约束、会静默溜过（已实证：never 版对
// platform: number 的破坏 exit 0）。
type _AssertTrue<T extends true> = T
type _AssertManifestBidirectional = _AssertTrue<
  [ModuleManifest] extends [ModuleManifestInferred]
    ? ([ModuleManifestInferred] extends [ModuleManifest] ? true : false)
    : false
>
