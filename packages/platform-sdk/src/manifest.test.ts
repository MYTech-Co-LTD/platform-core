import { describe, expect, it } from 'vitest'
import { ManifestSchema } from './manifest'

// Task 8（B5）：manifest.yaml 的 schema 契约，refine 规则逐字来自 task-8-brief.md。
// 文件存在性/全局唯一性属 CLI 层（runChecks，见 checks.test.ts），此处只钉 schema 语义。

const validManifest = {
  id: 'demo',
  name: '演示模块',
  version: '0.1.0',
  platform: '>=0.1.0',
  permissions: [
    { code: 'demo:view', name: '查看' },
    { code: 'demo:edit', name: '编辑' },
  ],
  api: { internal: [{ method: 'GET', path: '/tickets', scope: 'demo:view' }] },
  frontend: {
    userApp: { mount: '/demo', dist: 'apps/user-demo/dist' },
    console: [
      { path: '/demo', title: '演示', icon: 'demo.png', scope: 'demo:view', entry: 'console/index.js' },
      { path: '/demo/settings', title: '设置', scope: 'demo:edit', entry: 'console/settings.js' },
    ],
  },
  migrations: { dir: 'migrations' },
  bindings: { postgres: 'required', novu: 'optional', cube: 'optional' },
  notifications: { dir: 'notifications' },
  config: { schema: 'config.schema.json' },
}

describe('ManifestSchema', () => {
  it('合法全量样例 parse 通过（api/frontend.console+userApp/migrations/bindings/notifications/config 全字段）', () => {
    const r = ManifestSchema.safeParse(validManifest)
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.data.id).toBe('demo')
    expect(r.data.name).toBe('演示模块')
    expect(r.data.version).toBe('0.1.0')
    expect(r.data.permissions).toEqual([
      { code: 'demo:view', name: '查看' },
      { code: 'demo:edit', name: '编辑' },
    ])
    expect(r.data.api?.internal).toEqual([{ method: 'GET', path: '/tickets', scope: 'demo:view' }])
    expect(r.data.frontend?.userApp).toEqual({ mount: '/demo', dist: 'apps/user-demo/dist' })
    expect(r.data.frontend?.console).toHaveLength(2)
    expect(r.data.frontend?.console?.[0]).toEqual({
      path: '/demo', title: '演示', icon: 'demo.png', scope: 'demo:view', entry: 'console/index.js',
    })
    expect(r.data.frontend?.console?.[1].icon).toBeUndefined()
    expect(r.data.migrations).toEqual({ dir: 'migrations' })
    expect(r.data.bindings).toEqual({ postgres: 'required', novu: 'optional', cube: 'optional' })
    expect(r.data.notifications).toEqual({ dir: 'notifications' })
    expect(r.data.config).toEqual({ schema: 'config.schema.json' })
  })

  it('最小样例（仅必填段）parse 通过，可选段为 undefined', () => {
    const r = ManifestSchema.safeParse({
      id: 'demo', name: 'x', version: '1.0.0', platform: '>=1.2.3', permissions: [],
    })
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.data.api).toBeUndefined()
    expect(r.data.frontend).toBeUndefined()
    expect(r.data.migrations).toBeUndefined()
    expect(r.data.bindings).toBeUndefined()
  })

  it('id 不匹配 ^[a-z][a-z0-9-]*$ 报错（如 id: Demo）', () => {
    const r = ManifestSchema.safeParse({
      ...validManifest,
      id: 'Demo',
      permissions: [{ code: 'Demo:view', name: '查看' }],
    })
    expect(r.success).toBe(false)
    if (r.success) return
    const idIssue = r.error.issues.find(i => i.path[0] === 'id')
    expect(idIssue?.message).toContain('^[a-z][a-z0-9-]*$')
  })

  it('permission.code 前缀不以 id + ":" 开头报错（permissions.code: other:x）', () => {
    const r = ManifestSchema.safeParse({
      ...validManifest,
      permissions: [{ code: 'other:x', name: '越权' }],
    })
    expect(r.success).toBe(false)
    if (r.success) return
    const permIssue = r.error.issues.find(i => i.path[0] === 'permissions' && i.path[1] === 0 && i.path[2] === 'code')
    expect(permIssue?.message).toContain('demo:')
  })

  it('version 不匹配 ^[0-9]+[.][0-9]+[.][0-9]+$ 报错', () => {
    for (const bad of ['1.2', 'v1.0.0', '1.0.0-beta', 'latest']) {
      const r = ManifestSchema.safeParse({ ...validManifest, version: bad })
      expect(r.success, `version: ${bad}`).toBe(false)
      if (!r.success) expect(r.error.issues.some(i => i.path[0] === 'version'), bad).toBe(true)
    }
  })

  it('platform 不匹配 ^>=?[0-9] 报错（裸版本号也非法——brief 正则里 > 是必填）', () => {
    for (const bad of ['~0.1', 'latest', '>=', 'v1.2.3', '0.1.2']) {
      const r = ManifestSchema.safeParse({ ...validManifest, platform: bad })
      expect(r.success, `platform: ${bad}`).toBe(false)
      if (!r.success) expect(r.error.issues.some(i => i.path[0] === 'platform'), bad).toBe(true)
    }
  })

  it('platform 合法形态：>=0.1.0 / >0.1', () => {
    for (const ok of ['>=0.1.0', '>0.1']) {
      const r = ManifestSchema.safeParse({ ...validManifest, platform: ok })
      expect(r.success, ok).toBe(true)
    }
  })

  it('缺必填字段报错（无 permissions）', () => {
    const r = ManifestSchema.safeParse({ id: 'demo', name: 'x', version: '1.0.0', platform: '>=1.2.3' })
    expect(r.success).toBe(false)
    if (r.success) return
    expect(r.error.issues.some(i => i.path[0] === 'permissions')).toBe(true)
  })

  it('bindings 值越界报错（required/optional 之外）', () => {
    const r = ManifestSchema.safeParse({ ...validManifest, bindings: { postgres: 'always' } })
    expect(r.success).toBe(false)
    if (r.success) return
    expect(r.error.issues.some(i => i.path[0] === 'bindings')).toBe(true)
  })

  it('console 条目缺 scope/entry 报错', () => {
    const r = ManifestSchema.safeParse({
      ...validManifest,
      frontend: { console: [{ path: '/demo', title: '演示' }] },
    })
    expect(r.success).toBe(false)
  })

  // R2：api.internal 是可机械消费的声明（旧形状 {name,scope} 无 path/method，谁也没法消费，
  // 于是成了死字段——identity 从"忘挂 requireScope"变成"没声明就不可达"）
  it('api.internal：method 必须是白名单内的方法', () => {
    const bad = { ...validManifest, api: { internal: [{ method: 'TRACE', path: '/x', scope: 'demo:view' }] } }
    expect(ManifestSchema.safeParse(bad).success).toBe(false)
  })

  it('★ 负例：api.internal[].path 不以 / 开头 ⇒ 校验失败', () => {
    // 声明写了非 / 开头的 path ⇒ 模块内相对路径的约定被破坏，宿主拼不出可用的路由。
    // 运行期双向核对只兜底"注册了但声明对不上"，覆盖不到这种 schema 层违规，故须有静态负例。
    const bad = { ...validManifest, api: { internal: [{ method: 'GET', path: 'x', scope: 'demo:view' }] } }
    const r = ManifestSchema.safeParse(bad)
    expect(r.success).toBe(false)
    if (r.success) return
    expect(r.error.issues.some(i => i.path.includes('path'))).toBe(true)
  })

  it('★ 负例：api.internal[].scope 不属于本模块 permissions ⇒ 校验失败', () => {
    // 声明一个自己都没有的码 ⇒ 该路径恒 403 而无人知晓（与"忘挂 requireScope"同一种病的变种）
    const bad = {
      ...validManifest,
      api: { internal: [{ method: 'GET', path: '/x', scope: 'other-module:view' }] },
    }
    const r = ManifestSchema.safeParse(bad)
    expect(r.success).toBe(false)
    if (r.success) return
    expect(r.error.issues[0]!.message).toContain('不在本模块 permissions')
  })

  it('★ 负例：同 (method,path) 声明两次 ⇒ 校验失败（门卫会出现二义）', () => {
    const bad = {
      ...validManifest,
      api: {
        internal: [
          { method: 'GET', path: '/x', scope: 'demo:view' },
          { method: 'GET', path: '/x', scope: 'demo:edit' },
        ],
      },
    }
    expect(ManifestSchema.safeParse(bad).success).toBe(false)
  })
})
