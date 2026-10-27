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
  notifications: {
    events: [{
      key: 'demo.note.created',
      title: '便签创建',
      scope: { key: 'noteId' },
      payload: {
        noteId: { type: 'string', required: true },
        author: { type: 'user' },
        link: { type: 'url', required: true },
      },
      recipients: { author: { kind: 'field', field: 'author' } },
      defaults: { recipient: 'author', template: 'demo_note_created', channels: ['inapp_default'] },
    }],
  },
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
    expect(r.data.notifications?.events?.[0]?.key).toBe('demo.note.created')
    expect(r.data.config).toEqual({ schema: 'config.schema.json' })
  })

  it('permissions[].platformOnly：可选布尔；非布尔 / 拼错字段名 ⇒ 校验失败', () => {
    const ok = ManifestSchema.safeParse({
      ...validManifest,
      permissions: [
        { code: 'demo:view', name: '查看', platformOnly: true },
        { code: 'demo:edit', name: '编辑' },
      ],
    })
    expect(ok.success).toBe(true)
    if (ok.success) expect(ok.data.permissions[0]?.platformOnly).toBe(true)

    const badType = ManifestSchema.safeParse({
      ...validManifest,
      permissions: [{ code: 'demo:view', name: '查看', platformOnly: 'yes' }],
    })
    expect(badType.success).toBe(false)

    const typo = ManifestSchema.safeParse({
      ...validManifest,
      permissions: [{ code: 'demo:view', name: '查看', platform_only: true }],
    })
    expect(typo.success).toBe(false)
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

  it('★ 负例：api.internal[].path 是裸 "/" ⇒ 校验失败（同族：该路径恒 403 而无人知晓）', () => {
    // PR#5 评审 R1 建议 3：裸 '/' 能过 schema、也能过装载期双向核对，但门卫被注册成 use('/')
    // （Hono 展开为 /*），运行期 routePath === '/*' 而比对表里是 '/api/modules/<id>/' ⇒ 恒 403。
    // 与"声明一个自己没有的 scope"同族——都必须由 schema 挡在装载之前。
    const bad = { ...validManifest, api: { internal: [{ method: 'GET', path: '/', scope: 'demo:view' }] } }
    const r = ManifestSchema.safeParse(bad)
    expect(r.success).toBe(false)
    if (r.success) return
    expect(r.error.issues.some(i => i.path.includes('path'))).toBe(true)
    // 相邻形状不能被误伤：'/x' 与 '/x/' 都合法（只有"整条就是一个 /"才是裸根）
    for (const ok of ['/x', '/x/', '/x/y']) {
      const good = { ...validManifest, api: { internal: [{ method: 'GET', path: ok, scope: 'demo:view' }] } }
      expect(ManifestSchema.safeParse(good).success, ok).toBe(true)
    }
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

describe('guest 字段（售后 spec §1.3 协议小扩展）', () => {
  const base = {
    id: 'guestmod', name: 'g', version: '0.1.0', platform: '>=0.1',
    permissions: [{ code: 'guestmod:view', name: 'v' }, { code: 'guestmod:guest', name: '访客' }],
  }
  it('合法：guest.scope ∈ permissions codes', () => {
    const r = ManifestSchema.safeParse({ ...base, guest: { scope: 'guestmod:guest' } })
    expect(r.success).toBe(true)
  })
  it('非法：guest.scope 不在 permissions ⇒ ZodError（与 api scope 同纪律）', () => {
    const r = ManifestSchema.safeParse({ ...base, guest: { scope: 'other:guest' } })
    expect(r.success).toBe(false)
  })
})

// ---- 模块管理页协议（2026-09-20 spec）：frontend.admin 校验 ----
describe('frontend.admin（模块管理页协议）', () => {
  const BASE = {
    id: 'demo',
    name: '演示',
    version: '0.1.0',
    platform: '>=0.1',
    permissions: [{ code: 'demo:view', name: '查看' }],
  }

  it('合法声明通过：path 落 /console/admin/ 下，scope ∈ permissions', () => {
    const parsed = ManifestSchema.safeParse({
      ...BASE,
      frontend: {
        admin: [
          { path: '/console/admin/demo/settings', title: '演示设置', scope: 'demo:view', entry: './console/admin/settings.tsx' },
        ],
      },
    })
    expect(parsed.success).toBe(true)
  })

  it('path 不以 /console/admin/ 开头 → 拒绝并指到字段', () => {
    const parsed = ManifestSchema.safeParse({
      ...BASE,
      frontend: {
        admin: [{ path: '/console/demo/settings', title: 'x', scope: 'demo:view', entry: './a.tsx' }],
      },
    })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.path).toContain('admin')
  })

  it('scope 不在 permissions[].code 内 → 拒绝（与 api.internal[].scope 同纪律）', () => {
    const parsed = ManifestSchema.safeParse({
      ...BASE,
      frontend: {
        admin: [{ path: '/console/admin/demo/x', title: 'x', scope: 'other:view', entry: './a.tsx' }],
      },
    })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues.some((i) => i.message.includes('不在本模块 permissions'))).toBe(true)
  })

  it('frontend.console 不得占用 /console/admin/ 前缀（防串组）', () => {
    const parsed = ManifestSchema.safeParse({
      ...BASE,
      frontend: {
        console: [{ path: '/console/admin/demo/oops', title: 'x', scope: 'demo:view', entry: './a.tsx' }],
      },
    })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues.some((i) => i.message.includes('不得以 /console/admin/ 开头'))).toBe(true)
  })
})

// dataDependencies（跨模块只读数据依赖，issue #708 收字段；M1.1 补条目形状校验）。
// 正典：docs/module-protocol.md 同名节——B1 读侧豁免按声明集判在 scripts/lint-architecture
// 一侧（本文件不涉及守卫），其对账测试在 scripts/lint-architecture.test.ts。
describe('dataDependencies 字段（跨模块只读数据依赖）', () => {
  it('合法声明（<schema>.<view> string[]）parse 通过且逐字保留', () => {
    const parsed = ManifestSchema.safeParse({
      ...validManifest,
      dataDependencies: ['data.v_order_snapshot'],
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.dataDependencies).toEqual(['data.v_order_snapshot'])
  })

  it('可选：不声明时为 undefined（行为与未收字段前逐字相同）', () => {
    const parsed = ManifestSchema.safeParse(validManifest)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.dataDependencies).toBeUndefined()
  })

  // 条目形状校验（M1.1）：两段式 `<schema>.<view>`，正则
  // ^[a-z][a-z0-9-]*\.[a-z][a-z0-9_]*$（schema 段沿用模块 id 的 kebab-case 纪律，视图段 snake_case）。
  // 不合法 ⇒ schema 拒 ⇒ 装载失败 / check-manifests 红（fail-fast，与 .strict() 同口径；
  // checks.ts 走同一 ManifestSchema.safeParse，门禁侧无需另测）。
  it('合法条目（data.v_order_snapshot / dim.dim_x_view）通过且逐字保留', () => {
    const parsed = ManifestSchema.safeParse({
      ...validManifest,
      dataDependencies: ['data.v_order_snapshot', 'dim.dim_x_view'],
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.dataDependencies).toEqual(['data.v_order_snapshot', 'dim.dim_x_view'])
  })

  it('三段式拒绝（issue 指到 dataDependencies[i]）', () => {
    const parsed = ManifestSchema.safeParse({
      ...validManifest,
      dataDependencies: ['data.a.b'],
    })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(parsed.error.issues.some((i) => i.path.join('.') === 'dataDependencies.0')).toBe(true)
  })

  it('大写拒绝（schema 段 / 视图段均不允许大写）', () => {
    for (const bad of ['Data.v_order_snapshot', 'data.V_order_snapshot']) {
      const parsed = ManifestSchema.safeParse({
        ...validManifest,
        dataDependencies: [bad],
      })
      expect(parsed.success).toBe(false)
      if (parsed.success) continue
      expect(parsed.error.issues.some((i) => i.path.join('.') === 'dataDependencies.0')).toBe(true)
    }
  })

  it('无点（裸视图名）拒绝', () => {
    const parsed = ManifestSchema.safeParse({
      ...validManifest,
      dataDependencies: ['v_order_snapshot'],
    })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(parsed.error.issues.some((i) => i.path.join('.') === 'dataDependencies.0')).toBe(true)
  })
})

// .strict()（issue #708 fix 分项）。未加 strict 时未知键被 Zod **静默剥离**——「写了等于没写、
// 且不报错」，声明面形同虚设（正典实施状态警告的病根）。加 strict 后未知键 ⇒ schema 拒
// ⇒ 装载失败 / check-manifests 红（fail-fast 口径，与 storage.kind 越界同风格）。
describe('未知键拒绝（ManifestObject.strict）', () => {
  it('manifest 带未知键 ⇒ 校验失败，issue 指到该键', () => {
    const parsed = ManifestSchema.safeParse({
      ...validManifest,
      dataDependency: ['data.v_order_snapshot'], // 拼写错误的 dataDependencies：曾静默剥离
    })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(parsed.error.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true)
  })

  it('全量合法样例（含所有已收字段）不受 strict 影响', () => {
    const r = ManifestSchema.safeParse(validManifest)
    expect(r.success).toBe(true)
  })
})

// 通知事件声明（2026-10-27 通知基础设施设计 §3.1）
describe('notifications.events', () => {
  const base = {
    id: 'demo', name: 'demo', version: '0.1.0', platform: '>=0.1',
    permissions: [{ code: 'demo:view', name: 'v' }],
  }
  const ev = (over: Record<string, unknown> = {}) => ({
    key: 'demo.note.created', title: 't',
    payload: { noteId: { type: 'string' }, author: { type: 'user' } },
    recipients: { author: { kind: 'field', field: 'author' } },
    ...over,
  })
  const parse = (events: unknown[]) =>
    ManifestSchema.safeParse({ ...base, notifications: { events } })

  it('合法声明通过', () => {
    expect(parse([ev()]).success).toBe(true)
  })

  it('事件 key 前缀必须是模块 id', () => {
    expect(parse([ev({ key: 'other.note.created' })]).success).toBe(false)
  })

  it('事件 key 必须至少三段', () => {
    expect(parse([ev({ key: 'demo.created' })]).success).toBe(false)
  })

  it('同模块内 key 重复 ⇒ 拒绝', () => {
    expect(parse([ev(), ev()]).success).toBe(false)
  })

  it('scope.key 必须是 payload 的 string 字段', () => {
    expect(parse([ev({ scope: { key: 'n' }, payload: { n: { type: 'number' } } })]).success).toBe(false)
  })

  it('field 收件人必须指向 user/user_list 字段', () => {
    expect(parse([ev({
      payload: { s: { type: 'string' } },
      recipients: { r: { kind: 'field', field: 's' } },
    })]).success).toBe(false)
  })

  it('scope_holders 必须给 scope；literal 不能带 field/scope', () => {
    expect(parse([ev({ recipients: { r: { kind: 'scope_holders' } } })]).success).toBe(false)
    expect(parse([ev({ recipients: { r: { kind: 'literal', scope: 'x' } } })]).success).toBe(false)
  })

  it('defaults.recipient 必须已声明', () => {
    expect(parse([ev({ defaults: { recipient: 'nope', template: 't', channels: ['c'] } })]).success).toBe(false)
  })

  it('payload 超过 20 个字段 ⇒ 拒绝', () => {
    const payload = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`f${i}`, { type: 'string' }]))
    expect(parse([ev({ payload })]).success).toBe(false)
  })
})
