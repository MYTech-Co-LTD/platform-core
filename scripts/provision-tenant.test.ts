import { describe, expect, it } from 'vitest'
import {
  maskWechatOaAppId, maskWecomCorpId, parseLoginMethods, parseWechatOaArgs, parseWecomArgs,
  planAllTenantGrants, provisionPerms, tenantProvisionSteps, tenantRowUpsert,
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
  it('带企微三参：紧跟 tenant-row 插 wecom 步（wechat-oa 之后），计划里只有遮蔽后的 corpId（secret 永不出现）', () => {
    const steps = tenantProvisionSteps('acme', { org: 'o1', wechatOaAppId: 'wx0123456789abcdef', wecomCorpId: 'ww88990011223344' })
    expect(steps).toEqual(['org:o1', 'tenant-row:acme', 'wechat-oa wx0123…', 'wecom ww8899…', 'anchor', 'permissions'])
    expect(steps.join(' ')).not.toContain('11223344')
  })
  it('只带企微（无公众号）：wecom 步紧跟 tenant-row，无 wechat-oa 步', () => {
    expect(tenantProvisionSteps('acme', { org: 'o1', wecomCorpId: 'ww889900' })).toEqual([
      'org:o1', 'tenant-row:acme', 'wecom ww8899…', 'anchor', 'permissions',
    ])
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

describe('parseWecomArgs（#115：企微三参，corp+secret 成对，agent 仅随行）', () => {
  it('都不给 → null（调用方据此三列全不动，幂等重跑语义）', () => {
    expect(parseWecomArgs(undefined, undefined, undefined)).toBeNull()
    expect(parseWecomArgs('', '', '')).toBeNull()
  })
  it('corp+secret（无 agent）→ 透传——启用判定只看这两列（auth-wecom.ts:159/255）', () => {
    expect(parseWecomArgs('ww10086', undefined, 'corp-secret-9')).toEqual({ corpId: 'ww10086', secret: 'corp-secret-9' })
  })
  it('corp+secret+agent 三全给 → 原样透传', () => {
    expect(parseWecomArgs('ww10086', '1000002', 'corp-secret-9')).toEqual({ corpId: 'ww10086', agentId: '1000002', secret: 'corp-secret-9' })
  })
  it('只给 corp 或只给 secret → throw（写半个 = WECOM_NOT_CONFIGURED 半途态，不进 IO）', () => {
    expect(() => parseWecomArgs('ww10086', undefined, undefined)).toThrow(/必须同时提供/)
    expect(() => parseWecomArgs(undefined, undefined, 'corp-secret-9')).toThrow(/必须同时提供/)
  })
  it('单给 agent（corp/secret 都没给）→ throw（判定不看它，单写 agent 无意义且是半配置）', () => {
    expect(() => parseWecomArgs(undefined, '1000002', undefined)).toThrow(/仅能与.*同时/)
  })
  it('报错文案不含任何一方的值（secret/corp 都不回显）', () => {
    const msgOf = (f: () => unknown) => { try { f() } catch (e) { return (e as Error).message } return '' }
    expect(msgOf(() => parseWecomArgs('ww10086', undefined, undefined))).not.toContain('ww10086')
    expect(msgOf(() => parseWecomArgs(undefined, undefined, 'corp-secret-9'))).not.toContain('corp-secret-9')
    expect(msgOf(() => parseWecomArgs(undefined, '1000002', undefined))).not.toContain('1000002')
  })
})

describe('maskWecomCorpId（打印遮蔽，与 appId 同口径：标识非凭证，留前 6 位）', () => {
  it('只留前 6 位；不超过 6 位则原样；corp_id 是企业标识不是凭证，secret 才是', () => {
    expect(maskWecomCorpId('ww0123456789abcdef')).toBe('ww0123…')
    expect(maskWecomCorpId('ww1234')).toBe('ww1234')
    expect(maskWecomCorpId(undefined)).toBe('')
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
  it('不带企微三参：SQL 里根本不出现 wecom_ —— 重跑不带三参不误清已配三列（#115）', () => {
    const { text } = tenantRowUpsert({ slug: 'acme', org: 'o1', loginMethods: ['password'] })
    expect(text).not.toContain('wecom_corp')
    expect(text).not.toContain('wecom_agent')
    expect(text).not.toContain('wecom_secret')
  })
  it('带企微 corp+secret（无 agent）：恰两列进 insert/update，agent 列不出现（给了才写 = 不清已有 agent）', () => {
    const { text, values } = tenantRowUpsert({
      slug: 'acme', org: 'o1', loginMethods: ['password', 'wecom-qr'],
      wecom: { corpId: 'ww10086', secret: 'corp-secret-9' },
    })
    expect(text).toContain('wecom_corp_id, wecom_secret')
    expect(text).toContain('wecom_corp_id = excluded.wecom_corp_id')
    expect(text).toContain('wecom_secret = excluded.wecom_secret')
    expect(text).not.toContain('wecom_agent_id')
    expect(text).not.toContain('corp-secret-9')
    expect(values).toEqual(['acme', 'o1', 'acme', ['password', 'wecom-qr'], 'ww10086', 'corp-secret-9'])
  })
  it('带企微三全参（含 agent）：三列都进 insert 与 do update', () => {
    const { text, values } = tenantRowUpsert({
      slug: 'acme', org: 'o1', loginMethods: ['password'],
      wecom: { corpId: 'ww10086', agentId: '1000002', secret: 'corp-secret-9' },
    })
    expect(text).toContain('wecom_corp_id, wecom_agent_id, wecom_secret')
    expect(text).toContain('wecom_agent_id = excluded.wecom_agent_id')
    expect(values).toEqual(['acme', 'o1', 'acme', ['password'], 'ww10086', '1000002', 'corp-secret-9'])
  })
  it('公众号与企微同给：六列全进同一句 upsert（两族互不干扰）', () => {
    const { text, values } = tenantRowUpsert({
      slug: 'acme', org: 'o1', loginMethods: ['password'],
      wechatOa: { appId: 'wx123', secret: 'app-secret-9' },
      wecom: { corpId: 'ww10086', secret: 'corp-secret-9' },
    })
    expect(text).toContain('wechat_oa_app_id, wechat_oa_secret, wecom_corp_id, wecom_secret')
    expect(values).toEqual(['acme', 'o1', 'acme', ['password'], 'wx123', 'app-secret-9', 'ww10086', 'corp-secret-9'])
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
