// check-integrations.test.ts — 集成判据门禁（spec 2026-10-31 §2.5）
//
// 门禁的存在意义是「新增集成必须回答凭什么判它活着」。所以断言的不是「代码能跑」，
// 而是**三种漏答都会被拦**：没覆盖、拼错 provider、豁免不写理由。
import { describe, it, expect } from 'vitest'
import { checkCoverage, checkRegistry } from './check-integrations.mjs'
import { NOTIFY_PROVIDERS } from '../modules/notify/domain/providers'

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'x', kind: 'channel', source: 'http-healthz:ENV_KEY', slaSeconds: 600, ...over,
})

describe('checkRegistry', () => {
  it('合法 registry 无违规', () => {
    expect(checkRegistry({ integrations: [entry()] })).toEqual([])
  })

  it('★ 四种写错都拦：id 重复 / kind 未知 / source 未知 / sla 非正', () => {
    const bad = checkRegistry({
      integrations: [
        entry({ id: 'dup' }), entry({ id: 'dup' }),
        entry({ id: 'k', kind: 'webhook' }),
        entry({ id: 's', source: 'nonsense' }),
        entry({ id: 'z', slaSeconds: 0 }),
      ],
    })
    expect(bad.length).toBe(4)
  })
})

describe('checkCoverage', () => {
  const providers = ['wecom_chat', 'in_app', 'webhook']

  it('★ 没覆盖也没豁免 ⇒ 逐个 provider 报出来', () => {
    const v = checkCoverage({ integrations: [entry()], exempt: [] }, providers)
    expect(v).toHaveLength(3)
    expect(v.map((x) => x.message).join('\n')).toContain('wecom_chat')
  })

  it('★ covers + 带理由豁免 ⇒ 通过', () => {
    const v = checkCoverage({
      integrations: [entry({ covers: ['wecom_chat'] })],
      exempt: [{ provider: 'in_app', reason: '纯库内写入' }, { provider: 'webhook', reason: '当前无实例' }],
    }, providers)
    expect(v).toEqual([])
  })

  it('★ 无理由豁免 = 静默 ⇒ 照样红', () => {
    const v = checkCoverage({
      integrations: [entry({ covers: ['wecom_chat'] })],
      exempt: [{ provider: 'in_app', reason: '   ' }, { provider: 'webhook', reason: 'x' }],
    }, providers)
    expect(v).toHaveLength(1)
    expect(v[0]!.message).toContain('必须写理由')
  })

  it('★ covers 里拼错 provider ⇒ 报错（以为覆盖了其实没有）', () => {
    const v = checkCoverage({ integrations: [entry({ covers: ['wecom-chat'] })], exempt: [] }, providers)
    expect(v.some((x) => x.message.includes('不是已知 provider'))).toBe(true)
  })
})

describe('真 registry 与真 provider 清单', () => {
  it('providers.ts 的清单非空且与迁移/worker 同源（门禁据此判覆盖）', () => {
    expect(NOTIFY_PROVIDERS.length).toBeGreaterThan(0)
    expect([...NOTIFY_PROVIDERS].sort()).toEqual(['in_app', 'webhook', 'wecom_chat'])
  })
})
