import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
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
  // 五个键给齐，zosConfigFromEnv 才返回非 null。
  // ⚠️ `stubEnv` 必须**先于** `buildTestApp` 执行：ZOS 配置是在模块的 `createRouter` 里读的
  //    （`index.ts: zosConfigFromEnv(process.env)` ⇒ `storage = config ? new ZosStorage(config) : null`），
  //    而 `buildTestApp` 会立即调用 `createRouter`。stub 晚于它 ⇒ **静默失效**：
  //    这些用例不会报错，只会回 503 而不是用假凭证签出 URL。
  vi.stubEnv('AFTERSALES_ZOS_ENDPOINT', 'zos.xinan1.ctyun.cn')
  vi.stubEnv('AFTERSALES_ZOS_REGION', 'xinan1')
  vi.stubEnv('AFTERSALES_ZOS_BUCKET', 'aftersales-test')
  vi.stubEnv('AFTERSALES_ZOS_ACCESS_KEY', 'AKIATEST')
  vi.stubEnv('AFTERSALES_ZOS_SECRET', 'secret-test')
  const guest = buildTestApp(
    mod,
    makeIdentity({ orgId: ORG, userId: 'openid-alice', scopes: ['aftersales:guest'] }),
    ctx,
  )
  const manage = buildTestApp(
    mod,
    makeIdentity({ orgId: ORG, scopes: ['aftersales:manage'] }),
    ctx,
  )
  // M-7 的不安全 org 壳。**必须与上面两个 app 同处**（即同样在 stubEnv 之后、describe body 里）：
  // 下面第二个 describe 顶层的 `vi.unstubAllEnvs()` 在**收集期**就执行了，若把这个 app 留到
  // 用例体内再建，拿到的是「五个键全空 ⇒ storage = null」⇒ 端点回 503 而不是 201。
  const unsafeGuest = buildTestApp(
    mod,
    makeIdentity({ orgId: UNSAFE_ORG, userId: 'openid-unsafe', scopes: ['aftersales:guest'] }),
    ctx,
  )

  // 行的 `org` 落的是【原始】identity.orgId（只有 objectKey 会被净化，见 routes/attachment.ts），
  // 所以 UNSAFE_ORG 那些行也按原值清。
  const ALL_ORGS = [ORG, UNSAFE_ORG]

  beforeAll(async () => {
    await applyMigrations(pool)
    await pool.query('delete from aftersales.ticket_attachment where org = any($1::text[])', [ALL_ORGS])
  })

  afterAll(async () => {
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
    expect(url.pathname).toBe(`/aftersales-test/${body.objectKey}`) // path-style
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy()
  })

  it('申请上传只写元数据、不碰字节：库里落的是 object_key，工单归属暂为 null', async () => {
    const res = await guest.request(
      '/guest/attachments',
      post({ clientRequestId: 'req-att-2', contentType: 'video/mp4', sizeBytes: 999 }),
    )
    const { id, objectKey } = (await res.json()) as { id: number; objectKey: string }
    const row = await pool.query(
      'select ticket_id, object_key, content_type, uploader_openid, client_request_id from aftersales.ticket_attachment where org = $1 and id = $2',
      [ORG, id],
    )
    expect(row.rows[0]).toMatchObject({
      ticket_id: null,
      object_key: objectKey,
      content_type: 'video/mp4',
      uploader_openid: 'openid-alice',
      client_request_id: 'req-att-2',
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
    const cross = await buildTestApp(mod, other, ctx).request(`/attachments/${id}`)
    expect(cross.status).toBe(404)
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
  // 收集期顺序：上一个 describe 的 stubEnv 生效过（那个 app 已建好、配置已定型），
  // 这里撤掉再建 app ⇒ 这个 app 拿到的就是「五个键全空 ⇒ storage = null」。
  vi.unstubAllEnvs()
  const app = buildTestApp(
    mod,
    makeIdentity({ orgId: ORG, userId: 'openid-alice', scopes: ['aftersales:guest'] }),
    { pool },
  )

  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end——有别的钩子提前收摊').toBe(false)
    await pool.end().catch(() => {})
  })

  it('storage 为 null ⇒ 503 ZOS_NOT_CONFIGURED（不静默失败、不假装成功）', async () => {
    const res = await app.request(
      '/guest/attachments',
      post({ clientRequestId: 'req-nostorage', contentType: 'image/jpeg' }),
    )
    expect(res.status).toBe(503)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'ZOS_NOT_CONFIGURED' })
  })
})

// 收尾兜底：本文件的 stub 撤干净，别把假凭证漏给同 worker 里的其他测试文件。
afterAll(() => vi.unstubAllEnvs())
