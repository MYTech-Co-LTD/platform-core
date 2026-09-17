import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { storageRefOf } from '@platform/sdk'
import type { TenantStorageConfig } from '@platform/sdk'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'
import { MAX_DECLARED_BYTES } from './attachment'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

const ORG = 'test-aftersales-att'
// 专供 M-7（路由层 → sanitizeOrgSegment 的连线）用例：含 `/` 与 `=`（必须被换成 `_`）。
// `..` 放在【段的内部】（`7..x`）而不是独立成段：净化器只把**纯** `.`/`..` 段视作危险，
// 而那一档属 M-4，本轮【明确不动】——这样本用例既走到了 `..` 这两个字符，
// 又不会在 M-4 落地时因精确断言而假红。
const UNSAFE_ORG = 'test-aft/att=7..x'
const UNSAFE_ORG_SANITIZED = 'test-aft_att_7..x'

// ── 两套配置（M3c 步 4）──
// TENANT_CFG：**注入值**（宿主按请求投影进 context 键的那一份）。写侧只认它。
// PLATFORM_CFG：**平台默认** —— 由下面的 vi.stubEnv 造出来，值必须与 `platformStorageFromEnv`
//   的产物逐字一致（endpoint 已规范化）。「本列引入之前写入的行」(`storage_ref = ''`) 与
//   「租户未配时上传的行」都属于它。**stubEnv 因此必须留着**：没有它就没有平台默认，
//   下面「早期行 ⇒ 平台桶」那条用例就无从解析（不是可选项）。
const TENANT_CFG: TenantStorageConfig = {
  kind: 's3',
  endpoint: 'https://zos.tenant.test',
  region: 'xinan1',
  bucket: 'tenant-b1',
  accessKeyId: 'AKIATENANT',
  secretAccessKey: 'sk-tenant',
}
const TENANT_REF = storageRefOf(TENANT_CFG)
const PLATFORM_CFG: TenantStorageConfig = {
  kind: 's3',
  endpoint: 'https://zos.xinan1.ctyun.cn',
  region: 'xinan1',
  bucket: 'aftersales-test',
  accessKeyId: 'AKIATEST',
  secretAccessKey: 'secret-test',
}
const PLATFORM_REF = storageRefOf(PLATFORM_CFG)

// 两个 describe 都要用（brief 把它写在第一个 describe 里，第二个够不着 ⇒ 上提到模块作用域）
const post = (body: unknown) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describePg('附件域（已配置 ZOS）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const ctx = { pool }
  // 假凭证——只为让预签名算得出来；真凭证只在部署环境的 env 里（openship isSecret）。
  //
  // ⚠️ 步 4 起**这两个 app 的配置不再来自这个 stub**（模块不再在装载期读 env，那份形态正是
  //    本步要消灭的）；本请求的配置由 `buildTestApp` 第 4 参注入（与宿主投影同形状）。
  //    stub 现在的唯一作用是造出**平台默认**那一路：`storageCandidatesFor` 在**请求期**调
  //    `platformStorageFromEnv(process.env)`，而「早期行」(`storage_ref = ''` 或平台 ref)
  //    要按它解析 ⇒ 测试必须让它在**用例执行时**存在。
  //    ⚠️ 因此 stub 必须在 `beforeAll` 里做、在 afterAll 里撤：写在 describe 体里是**收集期**
  //    执行，而下面的第二个 describe 在收集期就会 `unstubAllEnvs()`（收集期早于所有用例执行）
  //    ⇒ 平台默认恒为 null ⇒ ②③ 两条用例静默变 503。这是步 4 引入的真陷阱，不是洁癖。
  const guest = buildTestApp(
    mod,
    makeIdentity({ orgId: ORG, userId: 'openid-alice', scopes: ['aftersales:guest'] }),
    ctx,
    TENANT_CFG,
  )
  const manage = buildTestApp(
    mod,
    makeIdentity({ orgId: ORG, scopes: ['aftersales:manage'] }),
    ctx,
    TENANT_CFG,
  )
  // M-7 的不安全 org 壳。**必须与上面两个 app 同处**（即同样在 stubEnv 之后、describe body 里）：
  // 下面第二个 describe 顶层的 `vi.unstubAllEnvs()` 在**收集期**就执行了——不过步 4 起它不再
  // 决定端点成败（注入值才是），这里保持一致只是让两个 describe 的环境边界清晰。
  const unsafeGuest = buildTestApp(
    mod,
    makeIdentity({ orgId: UNSAFE_ORG, userId: 'openid-unsafe', scopes: ['aftersales:guest'] }),
    ctx,
    TENANT_CFG,
  )

  /** 直插一行附件（**不走端点**）：要验的正是「读侧按行上的 storage_ref 选配置」，
   *  而用被测端点自己造不出对照组（它只会写当前注入的 ref）。 */
  async function insertAttachment(org: string, ref: string): Promise<number> {
    const { rows } = await pool.query<{ id: string }>(
      `insert into aftersales.ticket_attachment(org, object_key, content_type, storage_ref)
       values ($1, $2, 'image/jpeg', $3) returning id`,
      [org, `aftersales/${org}/seed/${Date.now()}-${Math.floor(Math.random() * 1e6)}`, ref],
    )
    return Number(rows[0]!.id)
  }

  /** 读那一行：GET /attachments/:id 走 manage 壳（它的 scope 是 aftersales:manage）。 */
  const readUrl = async (id: number) => {
    const res = await manage.request(`/attachments/${id}`)
    return { status: res.status, body: (await res.json()) as { url?: string; error?: string } }
  }

  // 行的 `org` 落的是【原始】identity.orgId（只有 objectKey 会被净化，见 routes/attachment.ts），
  // 所以 UNSAFE_ORG 那些行也按原值清。
  const ALL_ORGS = [ORG, UNSAFE_ORG]

  beforeAll(async () => {
    // 平台默认那一路的 env（见上方注释：必须**运行期**就位，不是收集期）
    vi.stubEnv('AFTERSALES_ZOS_ENDPOINT', 'zos.xinan1.ctyun.cn')
    vi.stubEnv('AFTERSALES_ZOS_REGION', 'xinan1')
    vi.stubEnv('AFTERSALES_ZOS_BUCKET', 'aftersales-test')
    vi.stubEnv('AFTERSALES_ZOS_ACCESS_KEY', 'AKIATEST')
    vi.stubEnv('AFTERSALES_ZOS_SECRET', 'secret-test')
    await applyMigrations(pool)
    await pool.query('delete from aftersales.ticket_attachment where org = any($1::text[])', [ALL_ORGS])
  })

  afterAll(async () => {
    // 本 describe 一结束就撤：下面的「未配置」describe 的语义正是**没有平台默认**
    vi.unstubAllEnvs()
    await pool.query('delete from aftersales.ticket_attachment where org = any($1::text[])', [ALL_ORGS])
    expect(pool.ended, '池在本 afterAll 之前已被 end——有别的钩子提前收摊').toBe(false)
    await pool.end().catch(() => {})
  })

  it('访客申请上传 ⇒ 201，回预签名 PUT URL，且 key 形状是 aftersales/{org}/{幂等键}/{uuid}', async () => {
    const res = await guest.request(
      '/guest/attachments',
      post({ clientRequestId: 'req-att-1', contentType: 'image/jpeg', sizeBytes: 12345 }),
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: number; objectKey: string; uploadUrl: string }
    expect(body.objectKey).toMatch(new RegExp(`^aftersales/${ORG}/req-att-1/[0-9a-f-]{36}$`))
    const url = new URL(body.uploadUrl)
    // 写侧用的是**注入的租户配置**（不是平台默认）：host 与桶都要指向它
    expect(url.host).toBe('zos.tenant.test')
    expect(url.pathname).toBe(`/tenant-b1/${body.objectKey}`) // path-style
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy()
  })

  it('申请上传只写元数据、不碰字节：库里落的是 object_key，工单归属暂为 null', async () => {
    const res = await guest.request(
      '/guest/attachments',
      post({ clientRequestId: 'req-att-2', contentType: 'video/mp4', sizeBytes: 999 }),
    )
    const { id, objectKey } = (await res.json()) as { id: number; objectKey: string }
    const row = await pool.query(
      `select ticket_id, object_key, content_type, uploader_openid, client_request_id, storage_ref
         from aftersales.ticket_attachment where org = $1 and id = $2`,
      [ORG, id],
    )
    expect(row.rows[0]).toMatchObject({
      ticket_id: null,
      object_key: objectKey,
      content_type: 'video/mp4',
      uploader_openid: 'openid-alice',
      client_request_id: 'req-att-2',
      // 写侧必须**记下当时的配置标识**（读侧全靠它；不记就等于本步白做）。
      // 断言「等于注入值的 ref」而不是「非空」：后者在写错配置时照样绿。
      storage_ref: TENANT_REF,
    })
  })

  it('非图片/视频 contentType ⇒ 400（白名单，不是黑名单）', async () => {
    const res = await guest.request(
      '/guest/attachments',
      post({ clientRequestId: 'req-att-bad', contentType: 'text/html' }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'UNSUPPORTED_CONTENT_TYPE' })
  })

  it('管理端取附件 ⇒ 200 回预签名 GET URL；跨 org 取 ⇒ 404', async () => {
    const created = await guest.request(
      '/guest/attachments',
      post({ clientRequestId: 'req-att-3', contentType: 'image/png' }),
    )
    const { id } = (await created.json()) as { id: number }

    const ok = await manage.request(`/attachments/${id}`)
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { url: string; contentType: string }
    expect(body.contentType).toBe('image/png')
    expect(new URL(body.url).searchParams.get('X-Amz-Signature')).toBeTruthy()

    const other = makeIdentity({ orgId: 'test-aftersales-att-other', scopes: ['aftersales:manage'] })
    const cross = await buildTestApp(mod, other, ctx, TENANT_CFG).request(`/attachments/${id}`)
    expect(cross.status).toBe(404)
  })

  // ── M3c 步 4：读侧按**行上的 `storage_ref`** 选配置 ──
  // 判据统一是「url 指向哪个 host/bucket」——url 是 SigV4 的**纯本地计算**产物
  // ⇒ 本地就能断言「用了哪套配置」，**不需要真桶**（这条是本组用例能在 CI 跑的原因）。
  describe('storage_ref 选配置（读侧）', () => {
    it('① 与本租户 ref 一致 ⇒ 用本租户配置签名', async () => {
      const id = await insertAttachment(ORG, TENANT_REF)
      const { status, body } = await readUrl(id)
      expect(status).toBe(200)
      const url = new URL(body.url!)
      expect(url.host).toBe('zos.tenant.test')
      expect(url.pathname).toContain('/tenant-b1/')
    })

    it("② ref = ''（本列引入之前写入的行）⇒ 按**平台默认**解析，不是当前租户桶", async () => {
      const id = await insertAttachment(ORG, '')
      const { status, body } = await readUrl(id)
      expect(status).toBe(200)
      const url = new URL(body.url!)
      expect(url.host).toBe('zos.xinan1.ctyun.cn')
      expect(url.pathname).toContain('/aftersales-test/')
    })

    it('③ ref = 平台默认（租户后来配了自己的桶）⇒ 仍按平台桶签，不拿当前配置硬签', async () => {
      const id = await insertAttachment(ORG, PLATFORM_REF)
      const { status, body } = await readUrl(id)
      expect(status).toBe(200)
      const url = new URL(body.url!)
      expect(url.host).toBe('zos.xinan1.ctyun.cn')
      expect(url.pathname).toContain('/aftersales-test/')
    })

    it('④ ref 两边都对不上 ⇒ 503 STORAGE_REF_UNRESOLVED，且**响应里没有任何预签名 URL**', async () => {
      const id = await insertAttachment(ORG, 's3|https://zos.old.test|old-bucket')
      const { status, body } = await readUrl(id)
      expect(status).toBe(503)
      expect(body.error).toBe('STORAGE_REF_UNRESOLVED')
      // 「不猜、不硬签」的机检：拿当前配置硬签会签出一个指向**别的桶**的 URL，
      // 客户端拿到 NoSuchKey、平台侧零信号 —— 这正是 storage_ref 存在的全部理由。
      expect(body.url).toBeUndefined()
      expect(JSON.stringify(body)).not.toContain('X-Amz-Signature')
    })
  })

  // ── 终审修复轮 1（M-5）：sizeBytes 守卫【零测试】 ──
  // 终审已实测行为正确（`-1`/`1.5`/`500MB+1`/`1e30` 全 400，`500MB` 边界 201）
  // ⇒ 缺口【纯在证据】不在实现；且 500MB 是本次新引入的业务规则 ⇒ 一并钉住。
  it('【回归 M-5】sizeBytes 越界 ⇒ 400（含非整数与指数记法）', async () => {
    for (const sizeBytes of [-1, 1.5, MAX_DECLARED_BYTES + 1, 1e30]) {
      const res = await guest.request(
        '/guest/attachments',
        post({ clientRequestId: 'req-size-bad', contentType: 'image/jpeg', sizeBytes }),
      )
      expect(res.status, `sizeBytes=${sizeBytes} 应为 400，实为 ${res.status}`).toBe(400)
      expect((await res.json()) as { error: string }).toMatchObject({ error: 'INVALID_BODY' })
    }
  })

  it('【回归 M-5·边界】sizeBytes 恰好 MAX_DECLARED_BYTES ⇒ 201，且按申报值落库（上界是闭区间）', async () => {
    const res = await guest.request(
      '/guest/attachments',
      post({ clientRequestId: 'req-size-max', contentType: 'image/jpeg', sizeBytes: MAX_DECLARED_BYTES }),
    )
    expect(res.status).toBe(201)
    const { id } = (await res.json()) as { id: number }
    const row = await pool.query(
      'select size_bytes, client_request_id from aftersales.ticket_attachment where org = $1 and id = $2',
      [ORG, id],
    )
    // bigint 在 pg 里是字符串——别按 number 断言
    expect(row.rows[0]).toMatchObject({
      size_bytes: String(MAX_DECLARED_BYTES),
      client_request_id: 'req-size-max',
    })
  })

  // ── 终审修复轮 1（M-7）：路由 → sanitizeOrgSegment 这条连线【一次都没被走过】 ──
  // T5 的单测覆盖了净化函数本身（storage.test.ts），但路由层是否**真的调用了它**无人钉过。
  // 若有人把 `objectKeyFor(identity.orgId, …)` 改成手动拼字符串，那些单测全绿、只有本用例会红。
  it('【回归 M-7】identity.orgId 含 / 与 = ⇒ 落库/回显的 objectKey 里 org 段已被净化', async () => {
    const res = await unsafeGuest.request(
      '/guest/attachments',
      post({ clientRequestId: 'req/att=1..x', contentType: 'image/jpeg' }),
    )
    expect(res.status).toBe(201)
    const { id, objectKey } = (await res.json()) as { id: number; objectKey: string }

    const segs = objectKey.split('/')
    expect(segs).toHaveLength(4)
    expect(segs[0]).toBe('aftersales')
    expect(segs[1]).toBe(UNSAFE_ORG_SANITIZED) // 原始值 `test-aft/att=7..x`
    expect(segs[2]).toBe('req_att_1..x') // 幂等键同样过净化（它也是 key 的一段）
    expect(segs[3]).toMatch(/^[0-9a-f-]{36}$/)
    // 自明断言：`/` 与 `=` 都没漏出去（漏出去会改变 S3 key 的分段/需编码）
    expect(segs[1]).not.toContain('=')
    expect(segs[1]).not.toContain('/')

    // 落库的那一份与回显的【同一个值】——净化在写库之前就完成了
    const row = await pool.query(
      'select org, object_key from aftersales.ticket_attachment where org = $1 and id = $2',
      [UNSAFE_ORG, id],
    )
    expect(row.rows[0]).toMatchObject({ org: UNSAFE_ORG, object_key: objectKey })
  })
})

describePg('附件域（未配置 ZOS）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  // **不传第 4 参**（= 宿主没注入 ⇒ 本租户未配或配置不完整）；env 由上一个 describe 的
  // afterAll 撤掉（**不要**在这里 `vi.unstubAllEnvs()`：那是收集期执行，撤不掉运行期才装上的
  // stub，只会给人「已经撤了」的错觉）。两个条件合起来 = 「本请求一份可用配置都没有」。
  const app = buildTestApp(
    mod,
    makeIdentity({ orgId: ORG, userId: 'openid-alice', scopes: ['aftersales:guest'] }),
    { pool },
  )

  afterAll(async () => {
    await pool.query('delete from aftersales.ticket_attachment where org = $1', ['test-aftersales-att-nocfg'])
    expect(pool.ended, '池在本 afterAll 之前已被 end——有别的钩子提前收摊').toBe(false)
    await pool.end().catch(() => {})
  })

  it('未注入配置 ⇒ 写侧 503 ZOS_NOT_CONFIGURED（**绝不**悄悄写进平台桶）', async () => {
    const res = await app.request(
      '/guest/attachments',
      post({ clientRequestId: 'req-nostorage', contentType: 'image/jpeg' }),
    )
    expect(res.status).toBe(503)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'ZOS_NOT_CONFIGURED' })
  })

  it('未注入且无平台默认 ⇒ 读侧 503 ZOS_NOT_CONFIGURED（与「配置换过、旧桶读不了」区分开）', async () => {
    // 一行挂在本 describe 独有的 org 上：**不用上面的 ORG**，否则它与 ①–④ 的用例共享
    // ref 去重键（`org|ref`），warn 的 60s 去重会让断言随机化。
    const { rows } = await pool.query<{ id: string }>(
      `insert into aftersales.ticket_attachment(org, object_key, content_type, storage_ref)
       values ($1, 'aftersales/x-nostorage/k', 'image/jpeg', '') returning id`,
      ['test-aftersales-att-nocfg'],
    )
    const id = Number(rows[0]!.id)
    const res = await buildTestApp(
      mod,
      makeIdentity({ orgId: 'test-aftersales-att-nocfg', scopes: ['aftersales:manage'] }),
      { pool },
    ).request(`/attachments/${id}`)
    expect(res.status).toBe(503)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'ZOS_NOT_CONFIGURED' })
  })
})

// 收尾兜底：本文件的 stub 撤干净，别把假凭证漏给同 worker 里的其他测试文件。
afterAll(() => vi.unstubAllEnvs())
