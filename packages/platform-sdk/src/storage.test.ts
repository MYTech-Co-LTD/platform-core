import { describe, expect, it } from 'vitest'
import { PLATFORM_STORAGE_ENV_KEYS, normalizeEndpoint, platformStorageFromEnv, storageRefOf } from './storage'

const FULL_ENV = {
  AFTERSALES_ZOS_ENDPOINT: 'zos.xinan1.ctyun.cn',
  AFTERSALES_ZOS_REGION: 'xinan1',
  AFTERSALES_ZOS_BUCKET: 'aftersales-test',
  AFTERSALES_ZOS_ACCESS_KEY: 'AKIATEST',
  AFTERSALES_ZOS_SECRET: 'secret-test',
}

describe('normalizeEndpoint', () => {
  it('无协议补 https://，吃掉尾斜杠与空白', () => {
    expect(normalizeEndpoint('zos.xinan1.ctyun.cn')).toBe('https://zos.xinan1.ctyun.cn')
    expect(normalizeEndpoint('  https://zos.xinan1.ctyun.cn///  ')).toBe('https://zos.xinan1.ctyun.cn')
    // 显式 http:// 不被改写（自建 MinIO 走明文是合法部署）
    expect(normalizeEndpoint('http://10.0.0.9:9000')).toBe('http://10.0.0.9:9000')
  })
})

describe('storageRefOf：配置标识（storage_ref 的规范形状）', () => {
  const cfg = { kind: 's3' as const, endpoint: 'https://zos.test', bucket: 'b1' }
  it('同配置 ⇒ 同串（值相等，不看引用）', () => {
    expect(storageRefOf({ ...cfg })).toBe(storageRefOf({ ...cfg }))
  })
  it('endpoint 或 bucket 变一个字 ⇒ 必不同（这是它存在的全部理由）', () => {
    expect(storageRefOf(cfg)).not.toBe(storageRefOf({ ...cfg, bucket: 'b2' }))
    expect(storageRefOf(cfg)).not.toBe(storageRefOf({ ...cfg, endpoint: 'https://zos.test/' }))
  })
  it('含 kind 前缀：第二个 kind 出现时不会与 s3 的 ref 撞车', () => {
    expect(storageRefOf(cfg).startsWith('s3|')).toBe(true)
  })
  it('不含密钥（AK/SK 不进 storage_ref —— 轮换 AK 不该让存量行失去归属）', () => {
    expect(storageRefOf(cfg)).not.toContain('AKIA')
  })
})

describe('platformStorageFromEnv（平台默认）', () => {
  it('五键齐 ⇒ 返回配置，endpoint 已规范化', () => {
    expect(platformStorageFromEnv(FULL_ENV)).toEqual({
      kind: 's3',
      endpoint: 'https://zos.xinan1.ctyun.cn',
      region: 'xinan1',
      bucket: 'aftersales-test',
      accessKeyId: 'AKIATEST',
      secretAccessKey: 'secret-test',
    })
  })
  it('缺任一键 ⇒ null（「没有平台默认」是一个确定状态，不是半成品配置）', () => {
    for (const k of PLATFORM_STORAGE_ENV_KEYS) {
      const partial = { ...FULL_ENV, [k]: undefined }
      expect(platformStorageFromEnv(partial), k).toBeNull()
    }
    expect(platformStorageFromEnv({})).toBeNull()
  })
  it('空串等同缺失（部署里 `KEY=` 是常见形态，不能当有效值）', () => {
    expect(platformStorageFromEnv({ ...FULL_ENV, AFTERSALES_ZOS_BUCKET: '' })).toBeNull()
  })
})
