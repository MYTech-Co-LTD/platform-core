// agent-mcp.e2e.test.ts — 统一 agent 能力网关的 e2e 权限矩阵（issue #2360 Task 12）。
//
// 为什么必须真装配：routes/agent-mcp.test.ts 用替身 fetchModule 验网关**自身**的协议分支
// （face 选择 / 命名 / 转发 / 错误映射），但「manifest 的 mcpFaces 真被投影进网关」「PAT/企微
// 真把 scopes 带进来」「模块 face 真按 channel/内部签名执法」这三层接缝只有
// 真 PG + 真 buildApp + 真模块装载能证。单测替身比真机宽松 = 缺陷结构性不可见（#50/#51 教训）。
//
// 装配照 data-query.e2e.test.ts（**不是** app.test.ts）：multi + seedDemo + 域名分流；
// 订阅源显式钉旧表 `platform`（mock 不实现 get-subscriptions；无行 = 启用，与问数 e2e 同理由）。
// 单元契约（-32600/-32603/超时/分页/缓存）归 routes/agent-mcp.test.ts，本文件不重复。
//
// 允许 import modules/**（lint 跳过 *.test.*；宿主生产代码的 B1 纪律不适用于测试）。
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MockCasdoor } from '@platform/auth-core/src/test-util/mock-casdoor'
import { buildApp } from './app'
import { getPool } from './db'
import { createPatKey } from './api-key-store'
import type { AppConfig } from './config'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

const ADMIN_PWD = 'admin-pwd-for-test'
// 会话密钥：一个常量两处消费（config 与潜在 signSession）——照 data-query.e2e 的同一份。
const SESSION_SECRET = 'test-secret-test-secret-test-secret!'

// 模块在**请求期**从 process.env 读仓库 DSN（warehouseConfigured()）——必须在任何 buildApp 之前，
// 且 `if (dbUrl)` 守卫（`process.env.X = undefined` 会字符串化成 "undefined"，见 data-query.e2e 注释）。
if (dbUrl) process.env.DATA_WAREHOUSE_URL ??= dbUrl

// MockCasdoor：owner = 用户归属 org（真机语义，照 data-query.e2e）。
// ⚠️ 必须显式种名为 admin 的用户（口令 = ADMIN_PWD）：装载器的权限码供给要拿 adminPwd 登管理
//    会话，mock 只在**没有**同名种子时才自动补（且固定口令 'pw'）——对不上 buildApp 直接抛。
// 六个身份各验矩阵一格（scopes 全用 owner:'acme' 的 perms 直挂用户，effectiveScopes 取并集）：
//   · reader       data:read                                  → 只读 8 工具
//   · querier      data:query                                 → 分析师 14 工具
//   · manager      data 三码 + notify 三码 + forms 两码         → 全 face（B 通道满配）
//   · forms_viewer forms:view                                 → 只有 forms 读面
//   · wecom_user   notify:manage / data:manage / forms:manage（**不给** notify:emit）→ C 通道
const mock = new MockCasdoor({
  users: [
    { name: 'admin', password: ADMIN_PWD, owner: 'built-in' },
    { name: 'reader', password: ADMIN_PWD, owner: 'acme' },
    { name: 'querier', password: ADMIN_PWD, owner: 'acme' },
    { name: 'manager', password: ADMIN_PWD, owner: 'acme' },
    { name: 'forms_viewer', password: ADMIN_PWD, owner: 'acme' },
    { name: 'wecom_user', password: ADMIN_PWD, owner: 'acme' },
  ],
  perms: [
    // ⚠️ 每条权限**必须显式 name 且互不重复**：mock 对无 name 的种子以首个 resource 兜底
    // （reader 与 manager 的首 resource 都是 data:read ⇒ 两条同名）——装载器的权限码供给
    // update-permission?id=acme/<name> 按 (owner,name) 定位只会命中**第一条**，把 manager 的
    // users/resources 整包盖到 reader 的记录上 ⇒ reader 变空 scope 且不报错（实测踩中）。
    { name: 'reader-perms', owner: 'acme', resources: ['data:read'], users: ['reader'] },
    { name: 'querier-perms', owner: 'acme', resources: ['data:query'], users: ['querier'] },
    {
      name: 'manager-perms',
      owner: 'acme',
      resources: [
        'data:read', 'data:query', 'data:manage',
        'notify:view', 'notify:manage', 'notify:emit',
        'forms:view', 'forms:manage',
      ],
      users: ['manager'],
    },
    { name: 'forms-viewer-perms', owner: 'acme', resources: ['forms:view'], users: ['forms_viewer'] },
    {
      name: 'wecom-user-perms',
      owner: 'acme',
      resources: ['notify:manage', 'data:manage', 'forms:manage'],
      users: ['wecom_user'],
    },
  ],
})

let app: Awaited<ReturnType<typeof buildApp>>['app']

// 配置照 data-query.e2e.test.ts 的 configWithCasdoor 抄（multi + 空平台 org + seedDemo）。
function configWithCasdoor(casdoorUrl: string): AppConfig {
  return {
    port: 13001, // 与 data-query.e2e 同值无碍：in-process app.request 不绑端口，且文件串行
    databaseUrl: dbUrl!,
    tenantMode: 'multi',
    platformOrg: '',
    sessionSecret: SESSION_SECRET,
    casdoor: {
      url: casdoorUrl, clientId: 'test-client', clientSecret: '',
      application: 'app-built-in', adminUser: 'admin', adminPwd: ADMIN_PWD,
    },
    publicOrigin: 'http://127.0.0.1:13001',
    seedDemo: true, // platform.tenant 种 acme/beta + 域名 acme.test / beta.test（multi 靠域名分流）
    dataWecomChannelKey: 'test-channel-key', // 不给 ⇒ wecom 闸直接放行 ⇒ C 用例静默假绿
    dataQueryRatePerMin: 60,
  }
}

/** 通道 C 的 header 组合（键名与 wecom-channel-auth.ts 读的逐字一致；抄错键名的症状是 401）。 */
const WECOM_HEADERS = { 'x-channel-key': 'test-channel-key', 'x-wecom-userid': 'wecom_user' }

// ── 各身份的真实工具面（判据的唯一事实源是各模块 tools/list 的静态投影；这里是**期望值**，
//    改模块工具面时本文件同步改——红了才说明 face 投影契约被破坏）。
// /mcp-read（data:read）恰 8 个只读工具（modules/data/routes/mcp-faces.test.ts 同名常量）。
const DATA_READ_TOOLS = [
  'data_agent_guide', 'data_harness_catalog', 'search_catalog', 'describe_metric',
  'describe_dataset', 'get_freshness', 'get_quality', 'get_lineage',
]
// 分析师面 13 + query_detail = 14（/mcp-curated，data:query）。
const DATA_QUERY_TOOLS = [
  ...DATA_READ_TOOLS,
  'sample_dimension_values', 'preview_query', 'query_metric', 'explore_query', 'explore_recipe',
  'query_detail',
]
// 管理面（/mcp-manage，data:manage）：口径 5 + 报表 4（pipeline/demand 9+2 归并在 manage 面，
// 这里只断言本矩阵要碰的——全 20 件由 mcp-manage-face 门禁量）。
const DATA_MANAGE_TOOLS = [
  'list_metrics', 'customize_metric', 'delete_custom_metric', 'submit_metric_change', 'list_metric_changes',
  'list_reports', 'get_report_spec', 'propose_report', 'revise_report_spec',
]
// notify 的 C（wecom）agent-safe 子集里有、本矩阵要钉的名字。
const NOTIFY_C_TOOLS = ['create_agent_rule', 'create_agent_template']
// notify 的 B（pat/session）全量里有、C 里**没有**的（mcp-tools.ts 的 C_SAFE_TOOLS 差集）。
const NOTIFY_B_ONLY = ['propose_rule', 'update_rule', 'set_rule_enabled', 'draft_template', 'send_message']
// forms 两面：read=list_forms；manage=+generate_form_draft。**没有任何发布/回滚/退役工具**。
const FORMS_MANAGE_TOOLS = ['list_forms', 'generate_form_draft']

const dataOf = (names: string[]) => names.filter((n) => n.startsWith('data__')).map((n) => n.slice('data__'.length))
const notifyOf = (names: string[]) => names.filter((n) => n.startsWith('notify__')).map((n) => n.slice('notify__'.length))
const formsOf = (names: string[]) => names.filter((n) => n.startsWith('forms__')).map((n) => n.slice('forms__'.length))

/** PAT 凭证（懒建 + 记忆化）：用例互不依赖执行顺序——某格一红不连带成「undefined 引起的怪错」。 */
const patCache = new Map<string, string>()
async function pat(user: string): Promise<string> {
  if (!patCache.has(user)) {
    // 直接走宿主 api-key-store（platform.api_key）：建侧与认侧都在宿主（issue #894）。
    const { token } = await createPatKey(pool(), 'acme', user, `e2e-${user}`)
    patCache.set(user, token)
  }
  return patCache.get(user)!
}

/** PAT 通道的请求头（Bearer dkq_…）。 */
async function patHeaders(user: string): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await pat(user)}` }
}

function pool(): ReturnType<typeof getPool> {
  if (!dbUrl) throw new Error('agent-mcp e2e 需要 DATABASE_URL')
  return getPool({ databaseUrl: dbUrl })
}

/** 网关入口：POST /api/agent/mcp，带租户 host（网关转发按原 host 解析租户）。 */
async function rpc(headers: Record<string, string>, body: unknown): Promise<Response> {
  return app.request('/api/agent/mcp', {
    method: 'POST',
    headers: { host: 'acme.test', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/** 直连模块面（绕过网关）：POST /api/modules/<id>/<face>。 */
async function modReq(path: string, headers: Record<string, string>, body: unknown): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { host: 'acme.test', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/**
 * 全量工具名（翻页收齐）：manager 满配 60+ 工具、网关按 UTF-8 字节分页（10KB/页），
 * 单页 `tools/list` 只回一页——不翻页的断言会跑在「恰好截断」的假集上。
 */
async function listAll(headers: Record<string, string>): Promise<string[]> {
  const names: string[] = []
  let cursor: string | undefined
  for (let page = 0; page < 50; page += 1) {
    const res = await rpc(headers, {
      jsonrpc: '2.0', id: page + 1, method: 'tools/list',
      ...(cursor === undefined ? {} : { params: { cursor } }),
    })
    expect(res.status, 'tools/list 应 200').toBe(200)
    const body = (await res.json()) as { result?: { tools: Array<{ name: string }>; nextCursor?: string }; error?: unknown }
    expect(body.error, `tools/list 第 ${page} 页不应是 JSON-RPC 错误`).toBeUndefined()
    names.push(...body.result!.tools.map((t) => t.name))
    cursor = body.result!.nextCursor
    if (cursor === undefined) return names
  }
  throw new Error('tools/list 翻页 50 次未收敛——分页契约被破坏')
}

/** agent__capabilities 的业务面（网关内置目录，先调它再调工具是 spec 的入口约定）。 */
async function capabilities(headers: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await rpc(headers, {
    jsonrpc: '2.0', id: 'caps', method: 'tools/call',
    params: { name: 'agent__capabilities', arguments: {} },
  })
  expect(res.status, 'capabilities 应 200').toBe(200)
  const body = (await res.json()) as { result: { content: Array<{ text: string }>; isError: boolean } }
  expect(body.result.isError, 'capabilities 不应是工具级错误').toBe(false)
  return JSON.parse(body.result.content[0]!.text) as Record<string, unknown>
}

beforeAll(async () => {
  if (!dbUrl) return
  await mock.start()
  // 订阅源钉旧表（data-query.e2e 同款理由）：无行 = 启用，data/notify/forms 对 acme 可见，
  // 不依赖 mock 没有的 get-subscriptions（casdoor 默认路径归 smoke 覆盖）。
  process.env.PLATFORM_SUBSCRIPTION_SOURCE = 'platform'
  app = (await buildApp({ config: configWithCasdoor(mock.origin) })).app
})

afterEach(() => {
  // 用例里翻过的部署级开关各自归零：AGENT_MCP_ENABLED 默认开（只有 '0' 关）；
  // NOTIFY_WECOM_NAMESPACE 是 C 档 namespace 钉子（case 7 会删/设）。
  delete process.env.AGENT_MCP_ENABLED
  delete process.env.NOTIFY_WECOM_NAMESPACE
})

afterAll(async () => {
  if (!dbUrl) return
  delete process.env.PLATFORM_SUBSCRIPTION_SOURCE
  // case 7 的钉子留下的 service namespace：清掉，别给共享库留脏行（幂等重跑安全）。
  await pool().query(`delete from notify.agent_namespace where org = 'acme' and namespace = 'acme_openclaw'`)
    .catch(() => {})
  await mock.stop()
  // 文件级关池守卫（data-query.e2e 同款）：断言没人私自 end 过再关。
  const p = pool()
  expect(p.ended, '池在文件级 afterAll 之前就被 end 了——检查 describe 里是否私自关池').toBe(false)
  await p.end().catch(() => {})
})

describePg('agent 能力网关 e2e：权限矩阵（真 PG + 真模块装配）', () => {
  it('用例 1｜PAT data:read ⇒ data 恰 8 个读工具；未投影的 query_metric ⇒ -32601；capabilities 报锁定面', async () => {
    const h = await patHeaders('reader')
    const names = await listAll(h)
    // data__* 恰为 8 个读工具（多一个 = manage/query 面漏锁；少一个 = 读面缺件）。
    expect(dataOf(names).sort()).toEqual([...DATA_READ_TOOLS].sort())
    expect(notifyOf(names)).toEqual([])
    expect(formsOf(names)).toEqual([])

    // 调未投影工具：网关只接受 tools/list 投影过的名字 ⇒ -32601，**不是** missing_scope
    // （missing_scope 只在模块门 403 时由网关翻；未投影 = 网关根本没把它给这个调用方）。
    const denied = await rpc(h, {
      jsonrpc: '2.0', id: 'q', method: 'tools/call',
      params: { name: 'data__query_metric', arguments: {} },
    })
    expect(((await denied.json()) as { error: { code: number } }).error.code).toBe(-32601)

    const caps = await capabilities(h)
    // 锁定面如实列出「audience 内、调用方缺 scope」的 face——data manage 与 notify/forms 全档。
    const locked = caps.lockedFaces as Array<{ module: string; face: string; scope: string }>
    expect(locked).toContainEqual(
      expect.objectContaining({ module: 'data', face: 'manage', scope: 'data:manage' }),
    )
    expect(locked.some((f) => f.module === 'notify'), 'notify 的锁定面应列出').toBe(true)
    expect(locked.some((f) => f.module === 'forms'), 'forms 的锁定面应列出').toBe(true)
  })

  it('用例 2｜PAT data:query ⇒ 13 分析师 + query_detail 共 14；无 manage 写工具', async () => {
    const h = await patHeaders('querier')
    const names = await listAll(h)
    const data = dataOf(names)
    // 14 = 13 个分析师工具 + query_detail（read 面的 8 个是它的子集，group=agent 只选 curated）。
    expect(data).toHaveLength(14)
    expect(data.sort()).toEqual([...DATA_QUERY_TOOLS].sort())
    expect(names.some((n) => n.startsWith('notify__') || n.startsWith('forms__'))).toBe(false)
  })

  it('用例 3｜PAT 满配（manager）⇒ data manage + notify 全量（含 send_message）+ forms 起草；无发布类；notes 四条人 gate', async () => {
    const h = await patHeaders('manager')
    const names = await listAll(h)
    const data = dataOf(names)
    const notify = notifyOf(names)
    const forms = formsOf(names)
    // data manage 面（B 通道选最高 precedence：group=agent → curated，group=manage → manage）。
    expect(data).toEqual(expect.arrayContaining(DATA_MANAGE_TOOLS))
    // notify B 全量：24 件里的关键三件（propose/set_rule_enabled 走 manage；send_message 要 notify:emit）。
    expect(notify).toEqual(expect.arrayContaining(['propose_rule', 'send_message', 'set_rule_enabled']))
    // forms 恰两件：读 + 起草。发布/回滚/退役工具整个网关面都不得出现（AI 永不发布，§14.1）。
    expect(forms.sort()).toEqual([...FORMS_MANAGE_TOOLS].sort())
    expect(names.filter((n) => /publish|rollback|retire/.test(n))).toEqual([])

    // manage 面的**调用路径**真通：经网关调只读的 data__list_metrics（走真 DB 的
    // loadMergedCatalog）——列表里有工具 ≠ 转发链（内部身份/租户 host/门卫）无恙，
    // 这里以一次真转发成功证明 B 的 manage face 端到端可达。
    const called = await rpc(h, {
      jsonrpc: '2.0', id: 'lm', method: 'tools/call',
      params: { name: 'data__list_metrics', arguments: {} },
    })
    expect(called.status).toBe(200)
    const cb = (await called.json()) as { result: { content: Array<{ text: string }>; isError: boolean }; error?: unknown }
    expect(cb.error).toBeUndefined()
    expect(cb.result.isError, 'data__list_metrics 应成功（manage face 转发可达）').toBe(false)
    const payload = JSON.parse(cb.result.content[0]!.text) as { bases: unknown[]; custom: unknown[] }
    expect(Array.isArray(payload.bases), '回包应是 list_metrics 的业务形状（bases 数组）').toBe(true)
    expect(Array.isArray(payload.custom)).toBe(true)

    const caps = await capabilities(h)
    expect(caps.notes).toEqual(expect.arrayContaining([
      expect.stringContaining('forms:publish'),
      expect.stringContaining('report publish'),
      expect.stringContaining('monitor dry_run'),
      expect.stringContaining('notify:publish'),
    ]))
  })

  it('用例 4｜PAT forms:view ⇒ 只有 forms__list_forms；generate_form_draft 未投影 ⇒ -32601', async () => {
    const h = await patHeaders('forms_viewer')
    const names = await listAll(h)
    expect([...names].sort()).toEqual(['agent__capabilities', 'forms__list_forms'])

    const denied = await rpc(h, {
      jsonrpc: '2.0', id: 'f', method: 'tools/call',
      params: { name: 'forms__generate_form_draft', arguments: {} },
    })
    expect(((await denied.json()) as { error: { code: number } }).error.code).toBe(-32601)
  })

  it('用例 5｜企微 C（渠道凭证 + userid）⇒ 只见 wecom audience 的 manage 面；无 B-only 工具', async () => {
    const names = await listAll(WECOM_HEADERS)
    // data manage 面对.wecom audience 开放（manifest audiences: [mcp, wecom]）。
    expect(dataOf(names)).toContain('customize_metric')
    // notify C 档：agent-safe 子集（建 pending 规则/模板），B-only 五件全部缺席。
    const notify = notifyOf(names)
    expect(notify).toEqual(expect.arrayContaining(NOTIFY_C_TOOLS))
    for (const gone of NOTIFY_B_ONLY) expect(notify, `C 不得见 ${gone}`).not.toContain(gone)
    // forms manage 面对.wecom audience 开放。
    expect(formsOf(names)).toContain('generate_form_draft')

    const caps = await capabilities(WECOM_HEADERS)
    const faces = caps.faces as Array<{ module: string; face: string; audience: string }>
    expect(faces.map((f) => `${f.module}/${f.face}`).sort())
      .toEqual(['data/manage', 'forms/manage', 'notify/agent-manage'])
    expect(faces.every((f) => f.audience === 'wecom'), 'C 的 faces 全是 wecom audience').toBe(true)
  })

  it('用例 6｜C 直连模块 + 伪造 x-agent-profile: full ⇒ 模块按 channel 拒 c_tool_not_allowed（profile 不是安全边界）', async () => {
    // 网关只按 face 投影工具；直连 /api/modules/notify/mcp-manage「绕过网关」时，
    // 模块自己的 C 档执法（按 identity.channel，不读 x-agent-profile）兜住——证明
    // `x-agent-profile` 只是网关的发现视图，客户端伪造它拿不到 full 面的工具。
    const call = (name: string, id: number) => modReq('/api/modules/notify/mcp-manage',
      { ...WECOM_HEADERS, 'x-agent-profile': 'full' },
      { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } })

    for (const [name, id] of [['propose_rule', 1], ['send_message', 2]] as const) {
      const res = await call(name, id)
      expect(res.status, `${name} 直连应 HTTP 200（工具级错误，不是 5xx）`).toBe(200)
      const body = (await res.json()) as { result: { content: Array<{ text: string }>; isError: boolean } }
      expect(body.result.isError, `${name} 应 isError=true`).toBe(true)
      expect(JSON.parse(body.result.content[0]!.text)).toMatchObject({ reason: 'c_tool_not_allowed', tool: name })
    }

    // 不带 `x-agent-profile` 的变体：整个**真实 HTTP 中间件栈**（internal-identity → pat →
    // 企微闸 → 启用闸 → 声明门卫 → 模块）跑完仍按 channel 拒——缺 profile 头不是绕行口，
    // 执法依据只有 identity.channel。
    const bare = await modReq('/api/modules/notify/mcp-manage', WECOM_HEADERS,
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'propose_rule', arguments: {} } })
    expect(bare.status, '不带 profile 头也应 HTTP 200（工具级错误）').toBe(200)
    const bb = (await bare.json()) as { result: { content: Array<{ text: string }>; isError: boolean } }
    expect(bb.result.isError).toBe(true)
    expect(JSON.parse(bb.result.content[0]!.text)).toMatchObject({ reason: 'c_tool_not_allowed', tool: 'propose_rule' })
  })

  it('用例 7｜C 的 namespace 服务端钉死：删 NOTIFY_WECOM_NAMESPACE ⇒ fail-closed；配上 ⇒ 模型参数被忽略', async () => {
    // ① 删掉部署钉子 ⇒ 排班工具 fail-closed：namespace_unconfigured（不猜、不回落 org）。
    delete process.env.NOTIFY_WECOM_NAMESPACE
    const r1 = await rpc(WECOM_HEADERS, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'notify__list_schedules', arguments: {} },
    })
    expect(r1.status).toBe(200)
    const b1 = (await r1.json()) as { result: { content: Array<{ text: string }>; isError: boolean }; error?: unknown }
    expect(b1.error).toBeUndefined()
    expect(b1.result.isError).toBe(true)
    expect(JSON.parse(b1.result.content[0]!.text).reason).toBe('namespace_unconfigured')

    // ② 配上钉子 + **模型在参数里塞 namespace:'rogue'** ⇒ 调用仍成功，且回包里的 namespace
    //    是服务端钉的 env 值、不是 'rogue'——namespace 由**服务端按 channel 取 env**，
    //    模型参数改变不了它（mcp.ts 在调排班工具前把 args.namespace 覆写成钉子）。
    process.env.NOTIFY_WECOM_NAMESPACE = 'acme_openclaw'
    const r2 = await rpc(WECOM_HEADERS, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'notify__list_schedules', arguments: { namespace: 'rogue' } },
    })
    expect(r2.status).toBe(200)
    const b2 = (await r2.json()) as typeof b1
    expect(b2.error).toBeUndefined()
    expect(b2.result.isError, `应成功（模型参数不该引起失败）：${b2.result.content[0]!.text}`).toBe(false)
    const payload = JSON.parse(b2.result.content[0]!.text) as { namespace?: string; schedules?: unknown[] }
    expect(payload.namespace, '回包 namespace 应是服务端 env 钉的值，不是模型塞的 rogue').toBe('acme_openclaw')
    expect(Array.isArray(payload.schedules), 'list_schedules 应回 schedules 数组（可为空）').toBe(true)
  })

  it('用例 8｜伪造头：网关剥掉客户端同名头（200 + 仍 reader 的 8 读工具）；直连模块验签失败 401 fail-closed', async () => {
    // ① 网关：reader PAT + 伪造 x-internal-identity / x-agent-profile ⇒ 网关一律不转发客户端
    //    同名头（内部身份现签、profile 取 face 自己的）⇒ 200 且工具面仍是 reader 的 8 个读工具。
    const h = { ...(await patHeaders('reader')), 'x-internal-identity': 'forged', 'x-agent-profile': 'full' }
    const res = await rpc(h, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(res.status, '网关不因伪造头拒绝（剥头不 401）').toBe(200)
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } }
    const names = body.result.tools.map((t) => t.name)
    expect(dataOf(names).sort()).toEqual([...DATA_READ_TOOLS].sort())

    // ② 直连模块：伪造内部头验签不过 ⇒ 中间件不设 identity ⇒ 宿主声明门卫 401 fail-closed。
    const direct = await modReq('/api/modules/data/mcp-read', { 'x-internal-identity': 'forged' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(direct.status).toBe(401)
    expect(await direct.json()).toMatchObject({ error: 'UNAUTHENTICATED' })
  })

  it('用例 9｜manager 调 forms__generate_form_draft ⇒ gate 通过、工具可达（工具级 llm/description 错，不得 -32601）', async () => {
    const res = await rpc(await patHeaders('manager'), {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'forms__generate_form_draft', arguments: {} },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { content: Array<{ text: string }>; isError: boolean }; error?: unknown }
    // 网关把它投给了 manager（face 门 + 工具投影都过）⇒ 到达模块工具本体；{} 入参下本机
    // LLM env 决定落在哪一格：未配 FORMS_LLM_*/DATA_LLM_* ⇒ llm_not_configured；配了 ⇒
    // description_required。两者都是**工具级**错误——出现 -32601 才是投影/gate 坏了。
    expect(body.error, '不得是 JSON-RPC 未知名错误（那说明网关没投影该工具）').toBeUndefined()
    expect(body.result.isError).toBe(true)
    const payload = JSON.parse(body.result.content[0]!.text) as { reason?: string }
    expect(['llm_not_configured', 'description_required']).toContain(payload.reason)
  })

  // 用例 10｜缺席说明：C 的 `notify__create_agent_rule` 落 pending 审批需要事件/模板种子
  // （agent namespace + ext.* 事件声明 + 模板），本文件的夹具没造——链路已由
  // modules/notify/mcp.test.ts 的真 PG 用例覆盖（C 档 pending 落库 + 审批流），不在此
  // 重复造一份种子写「假绿」断言。
})
