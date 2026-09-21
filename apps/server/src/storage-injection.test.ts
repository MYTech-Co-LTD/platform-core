// storage-injection.test.ts — M3c 的**端到端面**：Host → 租户行 → 注入 → 预签名用哪套配置。
//
// 为什么必须走真装配（`buildApp` + 真 Host + 真登录）：这条链由三层合成 ——
//   ① 租户中间件按 Host 取租户行（`tenant.ts`）
//   ② 装载器在模块 API 子树上挂投影中间件，把 `resolveTenantStorage(row)` 投进 context 键（`loader.ts`）
//   ③ 模块从 `c.get(TENANT_STORAGE)` 取配置去签名（T8 定稿）
// 模块自己的测试壳只覆盖第 ③ 层（**它是自己 set 的**）⇒ 「宿主 → 模块上下文」这条链只有这里验得到。
//
// 判据统一是**预签名 URL 的 host 与 path**：URL 是 SigV4 的纯本地计算产物 ⇒ 它就是「用了哪套配置」
// 的直接证据，**不需要真桶**。因此本文件**不桩任何存储**——整条链的价值就在它是真装配。
//
// 已知边界（本地验不了的，别误以为覆盖了）：上传端点在**访客面**（`POST /guest/attachments`，
// scope `aftersales:guest`），本地拿不到访客会话（那条会话由 wechat-oa 登录路发放）⇒ 本文件只走
// **管理面**的读数端点（`GET /attachments/:id`，scope `aftersales:manage`）。写侧的注入语义由
// 模块层用例（modules/aftersales/routes/attachment.test.ts）覆盖。
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { storageRefOf } from '@platform/sdk'
import type { TenantStorageConfig } from '@platform/sdk'
import { MockCasdoor } from '@platform/auth-core/src/test-util/mock-casdoor'
import { buildApp } from './app'
import { getPool } from './db'
import type { AppConfig } from './config'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

// 文件级关池（app.test.ts / demo-tenant-isolation.test.ts 同款守卫：防某个 describe 私自关池）
afterAll(async () => {
  if (!dbUrl) return
  const pool = getPool({ databaseUrl: dbUrl })
  expect(pool.ended, '池在文件级 afterAll 之前就被 end 了——检查 describe 里是否私自关池').toBe(false)
  await pool.end().catch(() => {})
})

const PW = 'pw-storage-inj-1'

/**
 * 平台默认（env 五键的桩值）。**桶名刻意取一个独有串**：3 号用例要断言的正是
 * 「部分填写时响应体里**绝不**出现平台桶」—— 用一个会撞车的通用名当不了证据。
 */
const PLATFORM_CFG: TenantStorageConfig = {
  kind: 's3',
  endpoint: 'https://zos.platform.test',
  region: 'xinan1',
  bucket: 'platform-bucket-must-never-leak',
  accessKeyId: 'AKIAPLATFORM',
  secretAccessKey: 'sk-platform',
}
const PLATFORM_REF = storageRefOf(PLATFORM_CFG)

/**
 * 租户 acme 自己的桶。endpoint **故意不带协议**：租户行里写 `zos.acme.test`，
 * 而下面断言的 ref 是 `s3|https://zos.acme.test|acme-bucket` ⇒ 这条顺带钉住
 * 「租户行路径也做了规范化」（不规范化的话 ref 与预签名 host 都会是另一副样子）。
 */
const ACME = { endpoint: 'zos.acme.test', region: 'xinan1', bucket: 'acme-bucket', ak: 'AKIAACME', sk: 'sk-acme' }
const ACME_CFG: TenantStorageConfig = {
  kind: 's3',
  endpoint: 'https://zos.acme.test',
  region: ACME.region,
  bucket: ACME.bucket,
  accessKeyId: ACME.ak,
  secretAccessKey: ACME.sk,
}
const ACME_REF = storageRefOf(ACME_CFG)
/** 两边都对不上的 ref（模拟「配置换过、旧桶读不了」）。 */
const GHOST_REF = 's3|https://zos.old.test|old-bucket'

/** 塞进租户行的**其它**敏感字段（正典「安全性质」第 2 条：注入的必须是投影后的窄值，
 *  绝不把 TenantRow 整个递给模块）。取值也是独有串，好当证据。 */
const LEAK_CANARY = {
  wecom: 'wecom-secret-canary-must-not-leak',
  oa: 'oa-secret-canary-must-not-leak',
}

describePg('存储注入的端到端面（M3c 步 4：注入真的驱动预签名）', () => {
  const mock = new MockCasdoor({
    // owner = 用户归属 org（真机语义）；两名用户各属一个租户
    users: [
      { name: 'inj-acme', password: PW, owner: 'acme' },
      { name: 'inj-beta', password: PW, owner: 'beta' },
    ],
    // 权限按 owner 分桶，scope 读侧消费 resources。acme 要两枚：
    // `aftersales:manage`（读附件端点）+ `tenant:admin`（5 号用例走清配置的管理端点）。
    perms: [
      { owner: 'acme', resources: ['aftersales:manage'], users: ['inj-acme'] },
      { owner: 'acme', resources: ['tenant:admin'], users: ['inj-acme'] },
      { owner: 'beta', resources: ['aftersales:manage'], users: ['inj-beta'] },
    ],
  })
  let app: Awaited<ReturnType<typeof buildApp>>['app']

  /** 本次运行里**所有**响应体（6 号用例的机检面）。 */
  const seenBodies: string[] = []

  beforeAll(async () => {
    // 平台默认那一路的 env（宿主在**请求期**读它 ⇒ 桩必须在运行期就位，不是收集期）
    vi.stubEnv('AFTERSALES_ZOS_ENDPOINT', 'zos.platform.test')
    vi.stubEnv('AFTERSALES_ZOS_REGION', PLATFORM_CFG.region)
    vi.stubEnv('AFTERSALES_ZOS_BUCKET', PLATFORM_CFG.bucket)
    vi.stubEnv('AFTERSALES_ZOS_ACCESS_KEY', PLATFORM_CFG.accessKeyId)
    vi.stubEnv('AFTERSALES_ZOS_SECRET', PLATFORM_CFG.secretAccessKey)

    await mock.start()
    const config: AppConfig = {
      port: 13000,
      databaseUrl: dbUrl!,
      tenantMode: 'multi', // acme.test / beta.test 由 Host 分流
      platformOrg: '',
      sessionSecret: 'test-secret-test-secret-test-secret!',
      casdoor: {
        url: mock.origin,
        clientId: 'test-client',
        clientSecret: '',
        application: 'app-built-in',
        adminUser: 'admin',
        adminPwd: 'pw',
      },
      publicOrigin: 'http://127.0.0.1:13000',
      seedDemo: true, // 种 acme/beta 两租户；aftersales 无 tenant_module 行 ⇒ 默认启用
      // 数据问数 per-key 限速（T5 加的**必填**字段）：本组用例不走 PAT 通道，取 loadConfig 的缺省值
      dataQueryRatePerMin: 60,
    }
    app = (await buildApp({ config })).app

    const pool = getPool({ databaseUrl: dbUrl! })
    // 基线：两租户存储列清空（跑过别的用例/别的分支后的库可能带残留）
    await pool.query(
      `update platform.tenant
          set storage_endpoint = null, storage_region = null, storage_bucket = null,
              storage_access_key = null, storage_secret = null, wechat_oa_secret = null
        where casdoor_org = any($1)`,
      [['acme', 'beta']],
    )
    // 6 号用例的诱饵：把两个**别的**敏感字段塞进 acme 行
    await pool.query(
      'update platform.tenant set wecom_secret = $1, wechat_oa_secret = $2 where casdoor_org = $3',
      [LEAK_CANARY.wecom, LEAK_CANARY.oa, 'acme'],
    )
  })

  afterAll(async () => {
    await mock.stop()
    if (dbUrl) {
      const pool = getPool({ databaseUrl: dbUrl })
      // 恢复种子态（seed 的 demo 值；wechat_oa_secret 种子不写 ⇒ null）
      await pool.query("update platform.tenant set wecom_secret = 'demo-secret' where casdoor_org = 'acme'")
      await pool.query(
        `update platform.tenant
            set storage_endpoint = null, storage_region = null, storage_bucket = null,
                storage_access_key = null, storage_secret = null
          where casdoor_org = any($1)`,
        [['acme', 'beta']],
      )
      await pool.query('delete from aftersales.ticket_attachment where org = any($1)', [['acme', 'beta']])
    }
    vi.unstubAllEnvs()
  })

  /** 账密登录拿 platform_session cookie（smoke-load / demo-tenant-isolation 同款路径） */
  async function sessionCookie(host: string, username: string): Promise<string> {
    const res = await app.request('/api/platform/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host },
      body: JSON.stringify({ username, password: PW }),
    })
    expect(res.status, `登录 ${username}@${host} 应 200`).toBe(200)
    const jar = res.headers.getSetCookie().join('; ')
    const hit = /platform_session=[^;]+/.exec(jar)
    if (!hit) throw new Error('登录响应未带 platform_session cookie')
    return hit[0]
  }

  /** 走真 HTTP 面并**记下响应体**（6 号用例要拿它们当机检面）。 */
  async function call(
    path: string,
    init: { host: string; cookie: string; method?: string; body?: unknown; csrf?: string },
  ) {
    const res = await app.request(path, {
      method: init.method ?? 'GET',
      headers: {
        host: init.host,
        cookie: init.cookie,
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.csrf ? { 'x-csrf-token': init.csrf } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    })
    const text = await res.text()
    seenBodies.push(text)
    return { status: res.status, body: JSON.parse(text) as Record<string, unknown> }
  }

  const pool = () => getPool({ databaseUrl: dbUrl! })

  /** 直插一行附件（**不经端点**）：要验的是「读侧按行上的 ref 选配置」，
   *  而这个 ref 由**宿主注入的那套配置**决定 —— 用端点造不出对照组（且上传端点在访客面）。 */
  async function insertAttachment(org: string, ref: string): Promise<number> {
    const { rows } = await pool().query<{ id: string }>(
      `insert into aftersales.ticket_attachment(org, object_key, content_type, storage_ref)
       values ($1, $2, 'image/jpeg', $3) returning id`,
      [org, `aftersales/${org}/e2e/${Date.now()}-${Math.floor(Math.random() * 1e6)}`, ref],
    )
    return Number(rows[0]!.id)
  }

  /** 配 acme 的存储列（**直写 SQL**，不走管理端 PUT：PUT 会先探测，而假主机必然探测失败）。 */
  async function configureAcme(cols: {
    endpoint?: string; region?: string; bucket?: string; ak?: string; sk?: string
  }): Promise<void> {
    await pool().query(
      `update platform.tenant
          set storage_endpoint = $1, storage_region = $2, storage_bucket = $3,
              storage_access_key = $4, storage_secret = $5
        where casdoor_org = 'acme'`,
      [cols.endpoint ?? null, cols.region ?? null, cols.bucket ?? null, cols.ak ?? null, cols.sk ?? null],
    )
  }

  const readAttachment = (host: string, cookie: string, id: number) =>
    call(`/api/modules/aftersales/attachments/${id}`, { host, cookie })

  // ── 1. 租户配置驱动 ──
  it('① 租户行的五列 ⇒ 预签名用**本租户**的 endpoint 与桶（注入真的驱动了签名）', async () => {
    await configureAcme({ ...ACME })
    const cookie = await sessionCookie('acme.test', 'inj-acme')
    const id = await insertAttachment('acme', ACME_REF)

    const { status, body } = await readAttachment('acme.test', cookie, id)
    expect(status, `响应体=${JSON.stringify(body)}`).toBe(200)
    const url = new URL(body.url as string)
    expect(url.host).toBe('zos.acme.test')
    // ← 这条是 path-style 的证明，也是「用的是哪个桶」的证明
    expect(url.pathname).toContain('/acme-bucket/')
    expect(url.pathname).toContain(`/aftersales/acme/`)
  })

  // ── 2. 租户间不串 ──
  it('② beta 未配 ⇒ beta 自己的行走**平台默认**（不会串到 acme 的桶）', async () => {
    // 前提：acme 仍是 ① 的配置（未配的 beta 若被注入了 acme 的配置，下面第一条断言就会红）
    const cookie = await sessionCookie('beta.test', 'inj-beta')
    const id = await insertAttachment('beta', '') // '' = 本列引入之前的行 ⇒ 平台默认

    const { status, body } = await readAttachment('beta.test', cookie, id)
    expect(status).toBe(200)
    const url = new URL(body.url as string)
    expect(url.host).toBe('zos.platform.test')
    expect(url.pathname).toContain(`/${PLATFORM_CFG.bucket}/`)
    expect(url.host).not.toBe('zos.acme.test') // 反向断言：绝不串租户
  })

  // ── 3. fail-explicit（裁定 4 的机检） ──
  it('③ 部分填写 ⇒ 503，且响应体里**绝不**出现平台桶（「绝不回落平台桶」的全部内容）', async () => {
    // 只填 endpoint + bucket（AK/SK 空）⇒ 宿主**不注入**（正典兜底表）；此时该租户自己桶里的行
    // 既不是「当前配置」也不是「平台默认」⇒ 显式失败。
    await configureAcme({ endpoint: ACME.endpoint, bucket: ACME.bucket })
    const cookie = await sessionCookie('acme.test', 'inj-acme')
    const id = await insertAttachment('acme', ACME_REF)

    const { status, body } = await readAttachment('acme.test', cookie, id)
    expect(status).toBe(503)
    expect(body.error).toBe('STORAGE_REF_UNRESOLVED')
    // ★ 本用例的**全部内容**：半套配置下绝不把请求悄悄降级到平台桶
    expect(JSON.stringify(body)).not.toContain(PLATFORM_CFG.bucket)
    expect(JSON.stringify(body)).not.toContain('zos.platform.test')
  })

  // ── 4. storage_ref 失配 ──
  it('④ ref 两边都对不上 ⇒ 503 STORAGE_REF_UNRESOLVED，且**绝不**回一个指向当前桶的 URL', async () => {
    await configureAcme({ ...ACME }) // 配置是好的，坏的是行上的 ref
    const cookie = await sessionCookie('acme.test', 'inj-acme')
    const id = await insertAttachment('acme', GHOST_REF)

    const { status, body } = await readAttachment('acme.test', cookie, id)
    expect(status).toBe(503)
    expect(body.error).toBe('STORAGE_REF_UNRESOLVED')
    // 「不猜、不硬签」：拿当前配置硬签会签出一个指向**别的桶**的 URL，客户端 NoSuchKey 而平台侧零信号
    expect(body.url).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('X-Amz-Signature')
    expect(JSON.stringify(body)).not.toContain(ACME.bucket)
  })

  // ── 5. 清除即回落 ──
  it('⑤ 清配置（管理端 DELETE + CSRF）后，未配的 acme 又走平台默认；库里五列确为 NULL', async () => {
    await configureAcme({ ...ACME })
    const cookie = await sessionCookie('acme.test', 'inj-acme')
    // CSRF 令牌**现取**（会话重签会轮换，缓存旧值必 403）
    const sess = await call('/api/platform/auth/session', { host: 'acme.test', cookie })
    expect(sess.status).toBe(200)
    const csrf = sess.body.csrfToken as string

    const del = await call('/api/platform/admin/storage', {
      host: 'acme.test', cookie, method: 'DELETE', csrf,
    })
    expect(del.status).toBe(200)
    expect(del.body).toMatchObject({ ok: true })

    // 物理证据：五列确实空（不能只看接口返回）
    const { rows } = await pool().query<Record<string, unknown>>(
      `select storage_endpoint, storage_region, storage_bucket, storage_access_key, storage_secret
         from platform.tenant where casdoor_org = 'acme'`,
    )
    expect(rows[0]).toEqual({
      storage_endpoint: null, storage_region: null, storage_bucket: null,
      storage_access_key: null, storage_secret: null,
    })

    const id = await insertAttachment('acme', '')
    const back = await readAttachment('acme.test', cookie, id)
    expect(back.status, `响应体=${JSON.stringify(back.body)}`).toBe(200)
    const url = new URL(back.body.url as string)
    expect(url.host).toBe('zos.platform.test')
    expect(url.pathname).toContain(`/${PLATFORM_CFG.bucket}/`)
  })

  // ── 6. 注入面不含租户行的其它字段（正典「安全性质」第 2 条的端到端机检） ──
  it('⑥ 注入的是**投影后的窄值**：整轮响应体都不含 wecom/公众号 密钥的值', async () => {
    // 诱饵已塞进 acme 行（beforeAll）；这里**自己再走一遍注入链**（配好 acme → 插行 → 读），
    // 再对**本次运行所有响应体**断言 —— 前半让本用例不依赖执行顺序，后半才是「整轮都没漏」。
    await configureAcme({ ...ACME })
    const cookie = await sessionCookie('acme.test', 'inj-acme')
    const id = await insertAttachment('acme', ACME_REF)
    const { status } = await readAttachment('acme.test', cookie, id)
    expect(status).toBe(200) // 反向自检：这条链**真的跑通了**（503 也会「不漏密钥」，那不是证据）

    // 为什么这条有价值：`TenantRow` 里坐着 wecom_secret / wechat_oa_secret / casdoor_org，
    // 若哪天有人图省事把整行递给模块（或把行原样回显），这层是唯一端到端看得见的防线。
    expect(seenBodies.length, '本轮应当已采集到响应体').toBeGreaterThan(0)
    for (const text of seenBodies) {
      expect(text).not.toContain(LEAK_CANARY.wecom)
      expect(text).not.toContain(LEAK_CANARY.oa)
    }
    // 反向自检：诱饵确实在库里（否则上面的断言是空转的）
    const { rows } = await pool().query<{ wecom_secret: string; wechat_oa_secret: string }>(
      "select wecom_secret, wechat_oa_secret from platform.tenant where casdoor_org = 'acme'",
    )
    expect(rows[0]!.wecom_secret).toBe(LEAK_CANARY.wecom)
    expect(rows[0]!.wechat_oa_secret).toBe(LEAK_CANARY.oa)
  })
})
