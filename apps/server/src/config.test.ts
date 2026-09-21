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
      // 数据问数（T5）：渠道凭证未配 = 通道 C 关闭；限速走缺省 60
      dataWecomChannelKey: undefined,
      dataQueryRatePerMin: 60,
    })
  })

  // T5 新增的必填字段：合法缺省 / 显式合法值 / 非法值 fail-fast 三档。
  // 非法值直接 throw 是刻意的——限速配错（0 / 负数 / 非整数）静默放行等于没限速，
  // 而限速的目标是防 agent 循环问数打爆 pg_duckdb，静默失效比启动失败更贵。
  it('DATA_QUERY_RATE_PER_MIN：缺省 60；合法值透传；非法值抛错', () => {
    expect(loadConfig({ ...baseEnv }).dataQueryRatePerMin).toBe(60)
    expect(loadConfig({ ...baseEnv, DATA_QUERY_RATE_PER_MIN: '120' }).dataQueryRatePerMin).toBe(120)
    expect(loadConfig({ ...baseEnv, DATA_WECOM_CHANNEL_KEY: 'ck' }).dataWecomChannelKey).toBe('ck')
    for (const bad of ['0', '-1', '1.5', 'abc']) {
      expect(() => loadConfig({ ...baseEnv, DATA_QUERY_RATE_PER_MIN: bad }))
        .toThrow(/DATA_QUERY_RATE_PER_MIN/)
    }
    // 空/全空白**不**抛错：optional() 把空串与未设置同视 ⇒ 落回缺省 60
    // （别把它塞进上面的 bad 列表——那会把「空串=未配」这条既有语义判成回归）
    expect(loadConfig({ ...baseEnv, DATA_QUERY_RATE_PER_MIN: '' }).dataQueryRatePerMin).toBe(60)
    expect(loadConfig({ ...baseEnv, DATA_QUERY_RATE_PER_MIN: '  ' }).dataQueryRatePerMin).toBe(60)
  })

  it('multi 模式 PLATFORM_ORG 可缺省；CASDOOR_APPLICATION 可选透传；SEED_DEMO 开关', () => {
    const cfg = loadConfig({
      ...baseEnv,
      TENANT_MODE: 'multi',
      PLATFORM_ORG: '',
      CASDOOR_APPLICATION: 'app-built-in',
      SEED_DEMO: '1',
    })
    expect(cfg.tenantMode).toBe('multi')
    expect(cfg.platformOrg).toBe('')
    expect(cfg.casdoor.application).toBe('app-built-in')
    expect(cfg.seedDemo).toBe(true)
  })

  // 曾经这两个键是可选的，理由写的是"纯登录场景不需要管理端点"——**那是错的**：
  // 登录签发前必调 getUser + getPermissions（routes/auth.ts），两者都走 admin 会话，
  // 缺凭据时没有任何人能拿到会话——即便凭据正确，登录也会在签发前 502（错凭据仍是 401，
  // 那是对的）。缺凭据的实例起得来也毫无用处，
  // 故改为启动期必需（fail-fast 而非"起得来但全员用不了"）
  it('缺 CASDOOR_ADMIN_USER / _PWD → 抛错（登录本身就要管理端点）', () => {
    expect(() => loadConfig({ ...baseEnv, CASDOOR_ADMIN_USER: undefined }))
      .toThrow(/CASDOOR_ADMIN_USER/)
    expect(() => loadConfig({ ...baseEnv, CASDOOR_ADMIN_PWD: undefined }))
      .toThrow(/CASDOOR_ADMIN_PWD/)
    // 空串与全空白同样视为缺失（requireValue 语义）
    expect(() => loadConfig({ ...baseEnv, CASDOOR_ADMIN_USER: '' }))
      .toThrow(/CASDOOR_ADMIN_USER/)
    expect(() => loadConfig({ ...baseEnv, CASDOOR_ADMIN_PWD: '   ' }))
      .toThrow(/CASDOOR_ADMIN_PWD/)
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
