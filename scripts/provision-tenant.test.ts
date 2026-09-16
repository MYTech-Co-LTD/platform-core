import { describe, expect, it } from 'vitest'
import {
  maskWechatOaAppId, parseLoginMethods, parseWechatOaArgs, planAllTenantGrants, provisionPerms,
  tenantProvisionSteps, tenantRowUpsert,
} from './provision-tenant.mjs'

describe('tenantProvisionSteps（纯核）', () => {
  it('默认 org 命名 + 无模块四步；带 --module 逐模块追加 plan/subscribe', () => {
    expect(tenantProvisionSteps('acme')).toEqual(['org:acme-org', 'tenant-row:acme', 'anchor', 'permissions'])
    expect(tenantProvisionSteps('acme', { org: 'o1', modules: ['demo', 'case-engine'] })).toEqual([
      'org:o1', 'tenant-row:acme', 'anchor', 'permissions', 'plan:demo', 'subscribe:demo', 'plan:case-engine', 'subscribe:case-engine',
    ])
  })
  it('带 domain 时 steps 在 anchor 后插入 domain 步（spec-3 §2.3）', () => {
    expect(tenantProvisionSteps('acme', { org: 'o1', domain: 'acme.example.com' })).toEqual([
      'org:o1', 'tenant-row:acme', 'anchor', 'domain:acme.example.com', 'permissions',
    ])
  })
  it('带公众号两参：紧跟 tenant-row 插一步，且计划里只有遮蔽后的 appId（secret 永不出现）', () => {
    const steps = tenantProvisionSteps('acme', { org: 'o1', wechatOaAppId: 'wx0123456789abcdef' })
    expect(steps).toEqual(['org:o1', 'tenant-row:acme', 'wechat-oa wx0123…', 'anchor', 'permissions'])
    expect(steps.join(' ')).not.toContain('89abcdef')
  })
  it('不带公众号两参：计划里没有任何 wechat 步（与既有的四步计划逐字一致）', () => {
    expect(tenantProvisionSteps('acme')).toEqual(['org:acme-org', 'tenant-row:acme', 'anchor', 'permissions'])
  })
})

describe('parseWechatOaArgs（缺口 1：公众号两参可选但必须成对）', () => {
  it('都不给 → null（调用方据此不写那两列，见 tenantRowUpsert）', () => {
    expect(parseWechatOaArgs(undefined, undefined)).toBeNull()
    expect(parseWechatOaArgs('', '')).toBeNull()
  })
  it('都给 → 原样透传给 upsert', () => {
    expect(parseWechatOaArgs('wx123', 'app-secret-9')).toEqual({ appId: 'wx123', secret: 'app-secret-9' })
  })
  it('只给一个 → throw（写半个 = 看起来配了其实不启用的半途态，不进 IO）', () => {
    expect(() => parseWechatOaArgs('wx123', undefined)).toThrow(/必须同时提供/)
    expect(() => parseWechatOaArgs(undefined, 'app-secret-9')).toThrow(/必须同时提供/)
  })
  it('报错文案不含任何一方的值（本 CLI 对敏感值的口径：从不打印）', () => {
    const msgOf = (f: () => unknown) => { try { f() } catch (e) { return (e as Error).message } return '' }
    const a = msgOf(() => parseWechatOaArgs('wx-appid-1', undefined))
    expect(a).toMatch(/必须同时提供/)
    expect(a).not.toContain('wx-appid-1')
    expect(msgOf(() => parseWechatOaArgs(undefined, 'app-secret-9'))).not.toContain('app-secret-9')
  })
})

describe('maskWechatOaAppId（打印遮蔽）', () => {
  it('只留前 6 位；不超过 6 位则原样（appId 本身不是敏感值，secret 才是）', () => {
    expect(maskWechatOaAppId('wx0123456789abcdef')).toBe('wx0123…')
    expect(maskWechatOaAppId('wx1234')).toBe('wx1234')
    expect(maskWechatOaAppId(undefined)).toBe('')
  })
})

describe('tenantRowUpsert（纯核：给了才写那两列 = 幂等重跑不误清）', () => {
  it('不带公众号两参：SQL 里根本不出现 wechat_oa —— do update 只改列出的列', () => {
    const { text, values } = tenantRowUpsert({ slug: 'acme', org: 'o1', loginMethods: ['password'] })
    expect(text).not.toContain('wechat_oa')
    expect(text).toContain('insert into platform.tenant(slug, casdoor_org, product_name, login_methods)')
    expect(text).toContain('on conflict (slug) do update set')
    expect(values).toEqual(['acme', 'o1', 'acme', ['password']]) // productName 缺省 = slug
  })
  it('带两参：两列进 insert 与 do update，secret 只落 values（不进 SQL 文本）', () => {
    const { text, values } = tenantRowUpsert({
      slug: 'acme', org: 'o1', productName: '售后', loginMethods: ['password', 'wecom-qr'],
      wechatOa: { appId: 'wx123', secret: 'app-secret-9' },
    })
    expect(text).toContain('wechat_oa_app_id, wechat_oa_secret')
    expect(text).toContain('wechat_oa_app_id = excluded.wechat_oa_app_id')
    expect(text).toContain('wechat_oa_secret = excluded.wechat_oa_secret')
    expect(text).toContain('$5, $6')
    expect(text).not.toContain('app-secret-9') // 值一律走参数位，不拼进 SQL
    expect(values).toEqual(['acme', 'o1', '售后', ['password', 'wecom-qr'], 'wx123', 'app-secret-9'])
  })
})

describe('planAllTenantGrants（纯核，spec-1 §4 批量发放）', () => {
  it('每 org × 每 module 生成 plan/subscribe 两步，顺序稳定（幂等重跑的计划面）', () => {
    expect(planAllTenantGrants(['acme', 'beta'], ['demo'])).toEqual([
      'plan:acme:demo', 'subscribe:acme:demo', 'plan:beta:demo', 'subscribe:beta:demo',
    ])
    expect(planAllTenantGrants(['o1', 'o2'], ['demo', 'case-engine'])).toEqual([
      'plan:o1:demo', 'subscribe:o1:demo', 'plan:o1:case-engine', 'subscribe:o1:case-engine',
      'plan:o2:demo', 'subscribe:o2:demo', 'plan:o2:case-engine', 'subscribe:o2:case-engine',
    ])
  })
  it('空 org 或空 module → 空计划', () => {
    expect(planAllTenantGrants([], ['demo'])).toEqual([])
    expect(planAllTenantGrants(['acme'], [])).toEqual([])
    expect(planAllTenantGrants([], [])).toEqual([])
  })
})

describe('parseLoginMethods（spec-3 §2.2：白名单入口拦）', () => {
  it('缺省 password；合法值解析去空格；顺序保留', () => {
    expect(parseLoginMethods()).toEqual(['password'])
    expect(parseLoginMethods('wecom-qr')).toEqual(['wecom-qr'])
    expect(parseLoginMethods('password, wecom-qr')).toEqual(['password', 'wecom-qr'])
  })
  it('坏值 throw 且报出合法集合——坏值进库=前端静默丢 tab', () => {
    expect(() => parseLoginMethods('password,oauth')).toThrow(/oauth.*password.*wecom-qr/)
  })
})

describe('provisionPerms（spec-3 §2.1：内置码在前并入扇出）', () => {
  it('builtin 在前 + 模块码随后（与装载器「内置码在前」同序）', () => {
    expect(provisionPerms([{ code: 'demo:view', name: 'x' }], [{ code: 'tenant:admin', name: '租户管理员' }]))
      .toEqual([{ code: 'tenant:admin', name: '租户管理员' }, { code: 'demo:view', name: 'x' }])
    expect(provisionPerms([{ code: 'demo:view', name: 'x' }])).toEqual([{ code: 'demo:view', name: 'x' }])
  })
})
