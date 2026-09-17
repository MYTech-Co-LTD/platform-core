import { describe, expect, it } from 'vitest'
import {
  UPLOAD_URL_TTL_SECONDS,
  ZosStorage,
  normalizeEndpoint,
  objectKeyFor,
  sanitizeOrgSegment,
  zosConfigFromEnv,
} from './storage'
import type { ZosConfig } from './storage'

const FULL_ENV = {
  AFTERSALES_ZOS_ENDPOINT: 'zos.xinan1.ctyun.cn',
  AFTERSALES_ZOS_REGION: 'xinan1',
  AFTERSALES_ZOS_BUCKET: 'aftersales-test',
  AFTERSALES_ZOS_ACCESS_KEY: 'AKIATEST',
  AFTERSALES_ZOS_SECRET: 'secret-test',
}

describe('normalizeEndpoint —— 天翼 ZOS 实测坑之一', () => {
  it('裸域名补 https://（WeKnora 实证：写成不带协议的域名会让签名/连接失败）', () => {
    expect(normalizeEndpoint('zos.xinan1.ctyun.cn')).toBe('https://zos.xinan1.ctyun.cn')
  })

  it('已有协议的不重复补', () => {
    expect(normalizeEndpoint('https://zos.xinan1.ctyun.cn')).toBe('https://zos.xinan1.ctyun.cn')
    expect(normalizeEndpoint('http://zos.internal')).toBe('http://zos.internal')
  })

  it('去首尾空白与尾斜杠（带尾斜杠会让 path-style 拼出双斜杠）', () => {
    expect(normalizeEndpoint('  zos.xinan1.ctyun.cn/  ')).toBe('https://zos.xinan1.ctyun.cn')
    expect(normalizeEndpoint('https://zos.xinan1.ctyun.cn///')).toBe('https://zos.xinan1.ctyun.cn')
  })
})

describe('sanitizeOrgSegment —— spec §2.3「key 不用裸 = 等需编码字符」', () => {
  it('保留 [A-Za-z0-9._-]，其余一律换 _', () => {
    expect(sanitizeOrgSegment('acme')).toBe('acme')
    expect(sanitizeOrgSegment('acme/山海=1')).toBe('acme____1')
  })
})

describe('objectKeyFor —— 形状 aftersales/{org}/{ticket_ref}/{uuid}', () => {
  it('三段拼齐，ticket_ref 放的是【客户端幂等键】而非库内主键（spec §2.3）', () => {
    expect(objectKeyFor('acme', 'req-1', '11111111-2222-3333-4444-555555555555')).toBe(
      'aftersales/acme/req-1/11111111-2222-3333-4444-555555555555',
    )
  })

  it('org 与幂等键都过净化，key 里不出现裸 / 与 =', () => {
    expect(objectKeyFor('a/b=c', 'x/y=z', 'u')).toBe('aftersales/a_b_c/x_y_z/u')
  })

  it('不传 uuid 时自动生成，且两次不同（避免同名单覆盖）', () => {
    const a = objectKeyFor('acme', 'req-1')
    const b = objectKeyFor('acme', 'req-1')
    expect(a).not.toBe(b)
    expect(a.startsWith('aftersales/acme/req-1/')).toBe(true)
  })
})

describe('zosConfigFromEnv —— CI 没有 ZOS 凭证时模块必须仍能装载', () => {
  it('五个键齐 ⇒ 返回配置，且 endpoint 已补协议', () => {
    expect(zosConfigFromEnv(FULL_ENV)).toEqual({
      endpoint: 'https://zos.xinan1.ctyun.cn',
      region: 'xinan1',
      bucket: 'aftersales-test',
      accessKeyId: 'AKIATEST',
      secretAccessKey: 'secret-test',
    })
  })

  it('完全没配 ⇒ null', () => {
    expect(zosConfigFromEnv({})).toBeNull()
  })

  it.each([
    'AFTERSALES_ZOS_ENDPOINT',
    'AFTERSALES_ZOS_REGION',
    'AFTERSALES_ZOS_BUCKET',
    'AFTERSALES_ZOS_ACCESS_KEY',
    'AFTERSALES_ZOS_SECRET',
  ])('少 %s ⇒ null（附件端点随后回 503，绝不半配置启动）', (missing) => {
    const env = { ...FULL_ENV, [missing]: '' }
    expect(zosConfigFromEnv(env)).toBeNull()
  })
})

describe('预签名（纯离线计算：本测试【不需要】真凭证、不联网）', () => {
  const config: ZosConfig = {
    endpoint: 'https://zos.xinan1.ctyun.cn',
    region: 'xinan1',
    bucket: 'aftersales-test',
    accessKeyId: 'AKIATEST',
    secretAccessKey: 'secret-test',
  }
  const storage = new ZosStorage(config)

  it('presignPut：path-style（bucket 在【路径】里）+ SigV4 签名 + 短 TTL', async () => {
    const url = new URL(await storage.presignPut('aftersales/acme/req-1/u1', 'image/jpeg'))
    expect(url.protocol).toBe('https:')
    expect(url.host).toBe('zos.xinan1.ctyun.cn')
    // ← 这条是 path-style 的证明。若 forcePathStyle 丢了，pathname 会变成
    //   /aftersales/acme/req-1/u1（bucket 跑到 host 前缀去）——ZOS 实测必须 path-style。
    expect(url.pathname).toBe('/aftersales-test/aftersales/acme/req-1/u1')
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(UPLOAD_URL_TTL_SECONDS))
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    // 凭证范围形如 AKIATEST/<date>/xinan1/s3/aws4_request
    expect(url.searchParams.get('X-Amz-Credential')).toContain('AKIATEST/')
    expect(url.searchParams.get('X-Amz-Credential')).toContain('/xinan1/')
  })

  it('presignGet：同样 path-style，TTL 独立可配', async () => {
    const url = new URL(await storage.presignGet('aftersales/acme/req-1/u1', 60))
    expect(url.pathname).toBe('/aftersales-test/aftersales/acme/req-1/u1')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('60')
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('同一 key 的 GET 与 PUT 签名不同（方法进了签名）', async () => {
    const put = await storage.presignPut('k', 'image/jpeg')
    const get = await storage.presignGet('k')
    expect(new URL(put).searchParams.get('X-Amz-Signature')).not.toBe(
      new URL(get).searchParams.get('X-Amz-Signature'),
    )
  })
})
