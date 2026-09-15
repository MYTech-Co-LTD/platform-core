import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

const ORG = 'test-aftersales-att'

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
  // 五个键给齐，zosConfigFromEnv 才返回非 null。必须建在 app 之前，理由见本节开头。
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

  beforeAll(async () => {
    await applyMigrations(pool)
    await pool.query('delete from aftersales.ticket_attachment where org = $1', [ORG])
  })

  afterAll(async () => {
    await pool.query('delete from aftersales.ticket_attachment where org = $1', [ORG])
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
