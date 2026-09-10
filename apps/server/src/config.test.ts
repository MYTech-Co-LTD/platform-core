// config.test.ts — loadConfig fail-fast 语义钉死（合法全集 / mode 非法 / 缺 org / secret 太短）
// 键全集以根 .env.example 为准（B9）；env 显式注入，不依赖进程环境。
import { describe, expect, it } from 'vitest'
import { loadConfig } from './config'

const baseEnv: Record<string, string> = {
  PORT: '13000',
  DATABASE_URL: 'postgres://platform:platform@127.0.0.1:5432/platform',
  TENANT_MODE: 'single',
  PLATFORM_ORG: 'acme',
  PLATFORM_SESSION_SECRET: 'change-me-at-least-32-bytes-secret',
  CASDOOR_URL: 'https://sso.example.test',
  CASDOOR_CLIENT_ID: 'platform',
  CASDOOR_CLIENT_SECRET: 'c-secret',
  CASDOOR_ADMIN_USER: 'admin',
  CASDOOR_ADMIN_PWD: 'admin-pwd',
  PUBLIC_ORIGIN: 'http://127.0.0.1:13000',
}

describe('loadConfig', () => {
  it('合法 env → 强类型 config（single 全字段）', () => {
    expect(loadConfig({ ...baseEnv })).toEqual({
      port: 13000,
      databaseUrl: baseEnv.DATABASE_URL,
      tenantMode: 'single',
      platformOrg: 'acme',
      sessionSecret: 'change-me-at-least-32-bytes-secret',
      casdoor: {
        url: 'https://sso.example.test',
        clientId: 'platform',
        clientSecret: 'c-secret',
        adminUser: 'admin',
        adminPwd: 'admin-pwd',
        application: undefined,
      },
      publicOrigin: 'http://127.0.0.1:13000',
      seedDemo: false,
    })
  })

  it('multi 模式 PLATFORM_ORG 可缺省；admin 凭据可空；CASDOOR_APPLICATION 可选透传；SEED_DEMO 开关', () => {
    const cfg = loadConfig({
      ...baseEnv,
      TENANT_MODE: 'multi',
      PLATFORM_ORG: '',
      CASDOOR_ADMIN_USER: '',
      CASDOOR_ADMIN_PWD: '',
      CASDOOR_APPLICATION: 'app-built-in',
      SEED_DEMO: '1',
    })
    expect(cfg.tenantMode).toBe('multi')
    expect(cfg.platformOrg).toBe('')
    expect(cfg.casdoor.adminUser).toBeUndefined()
    expect(cfg.casdoor.adminPwd).toBeUndefined()
    expect(cfg.casdoor.application).toBe('app-built-in')
    expect(cfg.seedDemo).toBe(true)
  })

  it('TENANT_MODE 非 multi/single → 抛错（含缺失）', () => {
    expect(() => loadConfig({ ...baseEnv, TENANT_MODE: 'bad' })).toThrow(/TENANT_MODE/)
    expect(() => loadConfig({ ...baseEnv, TENANT_MODE: undefined })).toThrow(/TENANT_MODE/)
  })

  it('single 模式缺 PLATFORM_ORG → 抛错', () => {
    expect(() => loadConfig({ ...baseEnv, PLATFORM_ORG: '' })).toThrow(/PLATFORM_ORG/)
  })

  it('PLATFORM_SESSION_SECRET < 32 字符 → 抛错', () => {
    expect(() => loadConfig({ ...baseEnv, PLATFORM_SESSION_SECRET: 'short' })).toThrow(/PLATFORM_SESSION_SECRET/)
  })
})
