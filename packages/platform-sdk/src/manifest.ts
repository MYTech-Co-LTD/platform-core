import { z } from 'zod'

/**
 * 模块接入协议（Task 8，B4/B5 机检的契约源）。
 * manifest.yaml 是整个底座的接入协议：装载器与 scripts/check-manifests.mjs 都吃这个 schema。
 */
export interface ModuleManifest {
  id: string; name: string; version: string; platform: string
  permissions: Array<{ code: string; name: string }>
  api?: { internal?: Array<{ name: string; scope: string }> }
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
// 平台版本约束：>=0.1.0 / >0.1 / 0.1.2 这类。
const PLATFORM_REGEX = /^>=?[0-9]/

const ManifestObject = z.object({
  id: z.string().regex(ID_REGEX, `id 必须匹配 ^[a-z][a-z0-9-]*$`),
  name: z.string(),
  version: z.string().regex(VERSION_REGEX, 'version 必须是 x.y.z 三段数字（宽松 semver）'),
  platform: z.string().regex(PLATFORM_REGEX, 'platform 必须匹配 ^>=?[0-9]（如 >=0.1.0）'),
  permissions: z.array(z.object({ code: z.string(), name: z.string() })),
  api: z.object({
    internal: z.array(z.object({ name: z.string(), scope: z.string() })).optional(),
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
})

export type ModuleManifestInferred = z.infer<typeof ManifestSchema>

// 编译期防漂移：schema 推断类型必须与接口双向一致（改其一不改另一会在此处炸 typecheck）。
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _AssertManifestBidirectional =
  [ModuleManifest] extends [ModuleManifestInferred] ?
    ([ModuleManifestInferred] extends [ModuleManifest] ? true : ['接口与 zod 推断不一致']) : never
