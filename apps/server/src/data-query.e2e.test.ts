// data-query.e2e.test.ts — 三通道 e2e（T10）：唯一能证明「一个授权核心」真的成立的测试。
//
// 同一个指标（sales_daily）、同一份夹具数据（acme 100 / beta 999），三条通道各带身份进来：
//   A 会话（platform_session cookie）/ B PAT（Bearer dkq_…）/ C 企微（渠道凭证 + X-Wecom-Userid）
// 必须得到**一致**的可见范围（只有 acme 的行）与钉死主体（subject=acme）。
// 任何通道拿到不同结果 = 授权核心被绕过的证据。
//
// 装配照 demo-tenant-isolation.test.ts（真会话中间件 + MockCasdoor + 双租户域名分流），
// **不是** app.test.ts（single 形态：tenant.ts:57 在 single 下完全忽略 Host 头 ⇒
// host:'beta.test' 也会解析到 acme——两主体前提直接消失，且不报错，断言跑在错误主体上）。
//
// 允许 import modules/data/**（lint 跳过 *.test.*；宿主生产代码的 B1 纪律不适用于测试）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockCasdoor } from '@platform/auth-core/src/test-util/mock-casdoor'
import { SESSION_COOKIE, signSession } from '@platform/auth-core'
import { buildApp } from './app'
import { getPool } from './db'
import type { AppConfig } from './config'
import { upsertMetric } from '../../../modules/data/domain/metric-store'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

const ADMIN_PWD = 'admin-pwd-for-test'
// 会话密钥：**一个常量，两处消费**（config 与 signSession）。别在用例里另写一份或读
// `process.env.SESSION_SECRET`——签验两边不一致的症状是「会话被当成无效」，
// 看起来像中间件/租户解析坏了，实际只是密钥不同（且 `??` 兜底让它只在 CI 上偶发）。
const SESSION_SECRET = 'test-secret-test-secret-test-secret!'

// 仓库连接指向**本机 pg**（e2e 用真 SQL 跑通「主体钉死」——这是整套设计最要紧的一条断言）。
// ⚠️ 两条：① 必须在**任何 buildApp 之前**（模块在**请求期**从 process.env 读它，
//    `warehouseConfigured()`）；② 必须 `if (dbUrl)` 守卫——Node 里 `process.env.X = undefined`
//    会把值**字符串化成 `"undefined"`**（不是删除）⇒ `warehouseConfigured()` 变 true，
//    指向一个假 DSN，报错信息完全不指向真因。
if (dbUrl) process.env.DATA_WAREHOUSE_URL ??= dbUrl

// 语料：一张跨主体的夹具表（两个 org 各一行），证明同一指标在两主体下各见各的。
// beta 的金额刻意放 999（acme 是 100）——「回包里没有 999」是主体钉死最硬的断言。
const FIXTURE_DDL = `
create schema if not exists marts;
create table if not exists marts.sales_daily (
  org text not null, day date not null, revenue numeric not null);
delete from marts.sales_daily;
insert into marts.sales_daily values
  ('acme', '2026-08-15', 100), ('beta', '2026-08-15', 999);
`

// MockCasdoor：形状照 demo-tenant-isolation.test.ts（owner = 用户归属 org，真机语义）。
// 本文件的用例**基本不走登录**（只有「PAT 往返契约」用一次会话 cookie），
// 直接 signSession 签发 ⇒ users/perms 的存在主要是为了让 Casdoor 通路（PAT/企微通道的
// getUser + getPermissions 实时取 scopes）不至于 404/503。
//
// ⚠️ 必须显式种一个名为 admin 的用户（brief 原稿漏了）：config 的 `adminPwd: ADMIN_PWD`
//    要被装载器的权限码供给（provisionModulePermissions）拿去登管理会话，而 mock 只在
//    **没有**同名种子时才自动补 built-in admin、且口令固定 'pw'——口令对不上 ⇒ admin 登录
//    失败 ⇒ buildApp 直接抛（实测：`casdoor admin login failed: 用户名或密码错误`）。
//    种子给了名为 admin 的用户后 mock 不再自动补，isAdmin 由名字推出（真机语义）。
const mock = new MockCasdoor({
  users: [
    { name: 'admin', password: ADMIN_PWD, owner: 'built-in' },
    { name: 'alice', password: ADMIN_PWD, owner: 'acme' },
    { name: 'bob', password: ADMIN_PWD, owner: 'beta' },
  ],
  perms: [
    { owner: 'acme', resources: ['data:query', 'data:manage'], users: ['alice'] },
    { owner: 'beta', resources: ['data:query', 'data:manage'], users: ['bob'] },
  ],
})

let app: Awaited<ReturnType<typeof buildApp>>['app']

// 配置：照 **demo-tenant-isolation.test.ts** 抄（**不是** app.test.ts）。
function configWithCasdoor(casdoorUrl: string): AppConfig {
  return {
    port: 13001,                    // 别与 app.test.ts / isolation 的 13000 撞
    databaseUrl: dbUrl!,
    // ⚠️⚠️ 必须 multi + platformOrg: ''：single 形态下 Host 头被完全忽略，
    //   `host: 'beta.test'` 也解析到唯一租户 ⇒ 两主体前提没了且**不报错**。
    tenantMode: 'multi',
    platformOrg: '',
    sessionSecret: SESSION_SECRET,
    casdoor: {
      url: casdoorUrl, clientId: 'test-client', clientSecret: '',
      application: 'app-built-in', adminUser: 'admin', adminPwd: ADMIN_PWD,
    },
    publicOrigin: 'http://127.0.0.1:13001',
    // **必需**：为 platform.tenant 种下 acme/beta 两租户 + 域名 acme.test / beta.test
    // （multi 模式靠域名分流）。acme 当"我自己"，beta 当"别人的主体"。
    seedDemo: true,
    // ★ 通道 C 的渠道凭证。**不给它 ⇒ wecomChannelAuth 会直接 next() 放行**（设计如此：
    //   没开通道 C 的部署不能被锁死）⇒ 企微用例会静默变成"没验到东西"却仍然绿。
    dataWecomChannelKey: 'test-channel-key',
    // ★ 必填（T5 给 AppConfig 加的是 number，非可选）：漏了 TS2741。
    //   60 是 loadConfig 的缺省值，这里显式写出来。
    dataQueryRatePerMin: 60,
  }
}

// 通道 C 的 header 组合（键名与 apps/server/src/wecom-channel-auth.ts 读的逐字一致；
// 抄错键名的症状是 401，不是"少了个头"）。
const WECOM_HEADERS = { 'x-channel-key': 'test-channel-key', 'x-wecom-userid': 'alice' }

/** 三通道共用的请求入口：只要 host（租户）+ 可选的鉴权头——「怎么带身份」留成参数。 */
async function req(
  path: string,
  host: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Response> {
  return app.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { host, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

// ⚠️ 键名与 T6 的 QueryBody schema 逐字一致：`metricId` + `args`（不是 `metric`/`params`）。
//    写错的症状是所有用例 400 INVALID_BODY——整份文件"红了但没有一处在验真东西"。
const QUERY_BODY = { metricId: 'sales_daily', args: {} }

/** 200 回包的业务面（只声明断言要碰的字段）。 */
interface QueryOkBody {
  status: 'ok'
  subject: string
  metricId: string
  columns: string[]
  rows: unknown[][]
  truncated: boolean
}

/**
 * alice 的两个凭证（**懒建 + 记忆化**）：用例互不依赖执行顺序——若让用例 3 直接吃
 * 用例 1 的产物，用例 1 一红就会连带把其余用例变成「undefined 引起的怪错」，掩盖真因。
 *
 * `scopes` 只给 `data:query`（不给 `data:manage`）：用例 8 正是靠这个差值证明"门卫还在"。
 * 三通道同一人：会话 sub / PAT 归属 / 企微 userid 都是 'alice'——
 * 「三通道同一人得同一结果」才是在比较同一个人。
 */
let aliceCookieCache: string | undefined
let alicePatCache: string | undefined

async function aliceCookie(): Promise<string> {
  if (!aliceCookieCache) {
    // ⚠️ signSession 是 async（漏 await 拿到 Promise 对象，被模板串成 "[object Promise]"
    //    ⇒ 表现为「会话无效」，typecheck 拦不住）。sfa=now ⇒ 中间件不触发 scopes 刷新，
    //    载荷里的 scopes 就是本次请求的真值（用例在测问数，不是在测 Casdoor）。
    const token = await signSession(
      { sub: 'alice', org: acmeOrg, name: 'alice', scopes: ['data:query'], authVia: 'password' },
      SESSION_SECRET,
    )
    aliceCookieCache = `${SESSION_COOKIE}=${token}`
  }
  return aliceCookieCache
}

/** 通道 B 的凭证：走**模块的路由**建（于是它同时是宿主/模块端口装配的往返契约）。 */
async function alicePat(): Promise<string> {
  if (alicePatCache) return alicePatCache
  const res = await req('/api/modules/data/keys', 'acme.test', { cookie: await aliceCookie() }, { name: 'e2e' })
  expect(res.status, 'POST /keys 应 201').toBe(201)
  alicePatCache = ((await res.json()) as { token: string }).token
  return alicePatCache
}

/** 通道 A 基线：会话问一次并取回包——用例 3/4 的「行集逐行一致」以它为基准。 */
async function queryAsSession(): Promise<QueryOkBody> {
  const res = await req('/api/modules/data/query', 'acme.test', { cookie: await aliceCookie() }, QUERY_BODY)
  expect(res.status, '会话通道问数应 200（作为一致性基准）').toBe(200)
  return (await res.json()) as QueryOkBody
}

let acmeTenantId = 0
/** acme 租户的 Casdoor org——**模块各表的隔离键**（授权核心写进 SQL 的主体值）。
 *  从库里查，不写死字面量：夹具与库对不上时断言会跑在空集上——绿了但没验到。 */
let acmeOrg = ''

beforeAll(async () => {
  if (!dbUrl) return

  // ① MockCasdoor 先起（mock.origin 是随机端口，装配期就要写进 config）
  await mock.start()

  const pool = getPool({ databaseUrl: dbUrl })

  // ② 夹具表（真 pg 上跑真 SQL——"主体钉死"只有真 SQL 能证）
  await pool.query(FIXTURE_DDL)

  // ③ app 装配（buildApp 是 async，返回 { app }；必须晚于 mock.start 与 DATA_WAREHOUSE_URL）。
  //    ⚠️ 顺序是实测订正（brief 原稿把 seedDemo/upsertMetric 放在 buildApp 之前——全新空库上
  //    必炸 `relation "platform.tenant" does not exist`）：platform schema 迁移、seedDemo、
  //    各模块迁移（含 data.metrics 建表）**全部在 buildApp 内**先跑完，夹具才能往上挂。
  app = (await buildApp({ config: configWithCasdoor(mock.origin) })).app

  // ④ tenantId/org 从库里查（platform.tenant.id 是自增，非空库上不是 1；
  //    casdoor_org 是隔离键，写死字面量 = 夹具与库对不上时断言跑在空集上）
  const { rows } = await pool.query<{ id: string; casdoor_org: string }>(
    `select id, casdoor_org from platform.tenant where slug = 'acme'`)
  acmeTenantId = Number(rows[0]!.id)
  acmeOrg = rows[0]!.casdoor_org
  if (!Number.isSafeInteger(acmeTenantId) || acmeTenantId <= 0 || !acmeOrg) {
    throw new Error('e2e fixture: platform.tenant 里没有可用的 acme 租户（seedDemo 没跑成）')
  }

  // ⑤ 指标定义走 T3 的 store（幂等 upsert，可重复跑）。**两个**指标：
  //    alice 够得着的（data:query）与够不着的（data:finance）——词表裁剪断言靠这对差值，
  //    只有一个指标的话「不在词表里」既可能是裁剪对了、也可能是词表本来就空（假绿）。
  await upsertMetric(pool, acmeOrg, {
    id: 'sales_daily', title: '销售日报', description: '按主体分组的日销售额',
    requiredScope: 'data:query', subjectColumn: 'org',
    selectSql: 'SELECT org, day, revenue FROM marts.sales_daily', groupBy: '', params: {},
  })
  await upsertMetric(pool, acmeOrg, {
    id: 'finance_summary', title: '财务汇总（alice 无权）', description: '给裁剪断言用的对照项',
    requiredScope: 'data:finance', subjectColumn: 'org',
    selectSql: 'SELECT org, day, revenue FROM marts.sales_daily', groupBy: '', params: {},
  })
})

afterAll(async () => {
  if (!dbUrl) return
  await mock.stop()
  // 文件级关池守卫（app.test.ts / demo-tenant-isolation.test.ts 同款）：
  // 断言「没人私自 end 过」再关——这条断言本身就是防"某个 describe 提前关池"的探针。
  const pool = getPool({ databaseUrl: dbUrl })
  expect(pool.ended, '池在文件级 afterAll 之前就被 end 了——检查 describe 里是否私自关池').toBe(false)
  await pool.end().catch(() => {})
})

describePg('问数三通道 e2e：同一授权核心的主体一致性', () => {
  it('用例 1｜PAT 往返契约：模块路由建的 key，宿主中间件（经模块端口）认下来', async () => {
    const pat = await alicePat()
    // 别断言 32/64 这类具体长度——编码方式一改就假红。锁的是「可辨识 token 的形状」。
    expect(pat).toMatch(/^[A-Za-z0-9_-]{20,}$/)
    // 端到端：中间隔着 createPorts 声明 → runtime.port 取用 → resolvePat → 跨租户比对 →
    // Casdoor 实时 scopes → identity 注入。漏声明 createPorts / 取错端口 / 返回形状漂移，
    // 三种装配错误都只有这条抓得到（#34 订正后宿主侧无 SQL 无哈希，锁的是端口装配）。
    const res = await req('/api/modules/data/query', 'acme.test',
      { authorization: `Bearer ${pat}` }, QUERY_BODY)
    expect(res.status, '宿主中间件应认下模块建的 key 并放行问数').toBe(200)
    expect(((await res.json()) as QueryOkBody).subject).toBe(acmeOrg)
  })

  it('用例 2｜通道 A（会话）：身份从会话带进来即可——主体钉死 acme，只见自己的行', async () => {
    // 显式写 signSession：让「会话怎么来的」在用例里可见（等价于 aliceCookie()，同一份载荷）
    const token = await signSession(
      { sub: 'alice', org: acmeOrg, name: 'alice', scopes: ['data:query'], authVia: 'password' },
      SESSION_SECRET,   // ← 与 config.sessionSecret 同一个常量（写两份必错）
    )
    const res = await req('/api/modules/data/query', 'acme.test',
      { cookie: `${SESSION_COOKIE}=${token}` }, QUERY_BODY)
    expect(res.status).toBe(200)
    const body = (await res.json()) as QueryOkBody
    expect(body.subject).toBe(acmeOrg)
    expect(body.rows, '同一指标只见自己主体的行').toHaveLength(1)
    expect(body.rows[0]![0], 'org 列（夹具第一列）= 钉死主体').toBe(acmeOrg)
    expect(JSON.stringify(body), 'beta 的金额 999 不得出现在回包任何位置').not.toContain('999')
  })

  it('用例 3｜通道 B（PAT）：行集与通道 A 逐行一致——「一个授权核心」的证明', async () => {
    const baseline = await queryAsSession()
    const res = await req('/api/modules/data/query', 'acme.test',
      { authorization: `Bearer ${await alicePat()}` }, QUERY_BODY)
    expect(res.status).toBe(200)
    const body = (await res.json()) as QueryOkBody
    expect(body.subject).toBe(acmeOrg)
    // 不只比 subject：两次的 rows 各自 JSON.stringify 后 toEqual（约束 1 的其余面）
    expect(JSON.stringify(body.rows)).toEqual(JSON.stringify(baseline.rows))
  })

  it('用例 4｜通道 C（企微）：渠道凭证 + userid 同结果；未关联用户 401 WECOM_USER_NOT_LINKED', async () => {
    const baseline = await queryAsSession()
    const res = await req('/api/modules/data/query', 'acme.test', WECOM_HEADERS, QUERY_BODY)
    expect(res.status).toBe(200)
    const body = (await res.json()) as QueryOkBody
    expect(body.subject).toBe(acmeOrg)
    expect(JSON.stringify(body.rows)).toEqual(JSON.stringify(baseline.rows))

    // 未关联 = Casdoor 里没有这个企微账号 ⇒ fail-closed + 可解释拒绝。
    // 这条绿的前提是 config.dataWecomChannelKey 给上了（没给 ⇒ 中间件直接放行 ⇒ 假绿）。
    const nobody = await req('/api/modules/data/query', 'acme.test',
      { ...WECOM_HEADERS, 'x-wecom-userid': 'nobody' }, QUERY_BODY)
    expect(nobody.status).toBe(401)
    expect((await nobody.json()).error).toBe('WECOM_USER_NOT_LINKED')
  })

  it('用例 5｜主体钉死（三通道各一）：args 里塞 org → 403 subject_pinned_by_platform，回包无 beta 数据', async () => {
    // 同一个 sales_daily，参数塞保留键 org（值给 beta）——客户端指定主体的唯一入口必须被拒
    const pinned = { ...QUERY_BODY, args: { org: 'beta' } }
    const creds: Array<[string, Record<string, string>]> = [
      ['session', { cookie: await aliceCookie() }],
      ['pat', { authorization: `Bearer ${await alicePat()}` }],
      ['wecom', WECOM_HEADERS],
    ]
    for (const [channel, headers] of creds) {
      const res = await req('/api/modules/data/query', 'acme.test', headers, pinned)
      expect(res.status, `${channel} 通道塞 org 应 403`).toBe(403)
      const body = await res.json()
      expect(body.reason, `${channel} 通道的拒因`).toBe('subject_pinned_by_platform')
      // 比"没有 beta 字样"硬：beta 行的金额是 999，整包序列化后不得出现
      expect(JSON.stringify(body), `${channel} 通道回包不得含 beta 的数据`).not.toContain('999')
    }
    // 注：这三条被拒请求会写进 data.query_audit（org=acme、verdict=denied），
    // 与用例 7 的成功请求同 org 同 metric ⇒ 用例 7 不断言"verdict 只有 ok"。
  })

  it('用例 6｜词表裁剪（三通道各一）：data:finance 指标在 A/C 的 GET /metrics 与 B 的 tools/list 都不出现', async () => {
    // 通道 A（会话）：GET /metrics（词表裁剪后的公开面）
    const a = await req('/api/modules/data/metrics', 'acme.test', { cookie: await aliceCookie() })
    expect(a.status).toBe(200)
    const aNames = ((await a.json()) as { metrics: { id: string }[] }).metrics.map((m) => m.id)
    // 通道 C（企微）：GET /metrics（同一公开面，身份来自渠道凭证）
    const c = await req('/api/modules/data/metrics', 'acme.test', WECOM_HEADERS)
    expect(c.status).toBe(200)
    const cNames = ((await c.json()) as { metrics: { id: string }[] }).metrics.map((m) => m.id)
    // 通道 B（PAT）：tools/list（MCP 工具面）
    const b = await req('/api/modules/data/mcp', 'acme.test',
      { authorization: `Bearer ${await alicePat()}` },
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    expect(b.status).toBe(200)
    const bNames = (((await b.json()) as { result: { tools: { name: string }[] } }).result.tools)
      .map((t) => t.name)

    for (const [label, names] of [['A/会话', aNames], ['B/PAT', bNames], ['C/企微', cNames]]) {
      // 正向对照先行：sales_daily 在——词表本来就空的话"不含 finance"是假绿
      expect(names, `${label}：sales_daily 应可见（正向对照）`).toContain('sales_daily')
      expect(names, `${label}：data:finance 指标必须看不见（约束 3）`).not.toContain('finance_summary')
    }
  })

  it('用例 7｜审计三通道统一：三通道的 ok 记录共写一张表一个主体；没有任何一行钉到 beta', async () => {
    const pool = getPool({ databaseUrl: dbUrl! })
    // 必须带 org 过滤：审计表全租户共用，且 T3/T4 的单测也写它——
    // 不带过滤的 count 会随别的测试跑过而变（典型间歇红）。
    const { rows: audit } = await pool.query<{ channel: string; org: string; verdict: string }>(
      `select distinct channel, org, verdict from data.query_audit
        where org = $1 and metric_id = 'sales_daily'`, [acmeOrg])
    // ① 三条 ok 都在（session/pat/wecom 各一条）且 org 全是 acme——三通道确实共写一张表
    for (const channel of ['session', 'pat', 'wecom']) {
      expect(
        audit.some((r) => r.channel === channel && r.verdict === 'ok' && r.org === acmeOrg),
        `${channel} 通道缺少 verdict=ok 的审计行`,
      ).toBe(true)
    }
    // ② 主体钉死的可观测不变量：用例 5 塞进参数的 beta 从未变成写进审计的主体值。
    //    （不断言"verdict 只有 ok"——用例 5 故意造了 denied 行，断"只有 ok"必红。）
    expect(audit.every((r) => r.org === acmeOrg), '出现了 org ≠ acme 的审计行（主体钉死被绕过？）').toBe(true)
  })

  it('用例 8｜门卫仍然生效：metrics/all 要 data:manage——403 来自声明门卫（带 need），不是"未声明路径"', async () => {
    // aliceCookie 只签了 data:query ⇒ 应 403。带 `need: 'data:manage'` 证明这声 403 出自
    // scope 门卫（"未声明路径"的 403 不带 need）——同样是 403，只有这声验到了东西。
    const denied = await req('/api/modules/data/metrics/all', 'acme.test', { cookie: await aliceCookie() })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ error: 'FORBIDDEN', need: 'data:manage' })

    // 差分：有 data:manage 的会话 200——证明该路径确实声明在 manifest 里（不是"未声明"的 403）
    const token = await signSession(
      { sub: 'alice', org: acmeOrg, name: 'alice', scopes: ['data:query', 'data:manage'], authVia: 'password' },
      SESSION_SECRET,
    )
    const ok = await req('/api/modules/data/metrics/all', 'acme.test',
      { cookie: `${SESSION_COOKIE}=${token}` })
    expect(ok.status, '带 data:manage 应 200——差分才说明上面的 403 来自门卫').toBe(200)
  })

  it('用例 9｜requester-null 接缝：空身份打 /query 与 /mcp 的 tools/call，各自 fail-closed 的可解释拒绝', async () => {
    // 无 cookie、无 Bearer、无渠道凭证——"空身份"真打模块面。本装配配了
    // DATA_WECOM_CHANNEL_KEY ⇒ 请求在企微中间件就被关上（401 CHANNEL_KEY_INVALID），
    // 到不了授权核心；模块侧 requesterOf→null→runQuery 的 unauthenticated 路径由
    // T6/T8 的壳测试覆盖——接缝两侧都 fail-closed，这就是端到端要证的结局。
    const q = await req('/api/modules/data/query', 'acme.test', {}, QUERY_BODY)
    expect(q.status).toBe(401)
    const qErr = (await q.json()) as { error?: string }
    expect(typeof qErr.error, '拒绝必须带可解释 error 码').toBe('string')

    const m = await req('/api/modules/data/mcp', 'acme.test', {},
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'sales_daily', arguments: {} } })
    expect(m.status).toBe(401)
    const mErr = (await m.json()) as { error?: string }
    expect(typeof mErr.error, '拒绝必须带可解释 error 码').toBe('string')
  })
})
