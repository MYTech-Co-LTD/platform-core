// domain/wecom-binding.test.ts — 标准审批绑定形状校验（OA P2 Task 6 / issue #2385）。
import { describe, expect, it } from 'vitest'
import { itemWecomRefOf, validateWecomBinding } from './wecom-binding'

const valid = (extra: Record<string, unknown> = {}) => ({
  provider: 'wecom_native',
  processCode: 'PC-EXPENSE-001',
  deepLink: 'https://open.work.weixin.qq.com/oa/approval?template=PC-EXPENSE-001',
  name: '差旅报销（企微标准审批）',
  verifiedChain: ['2026-11-16 真机提交 SP-01 → 回调到达', '2026-11-16 审批通过 → 状态 approved'],
  verifiedAt: '2026-11-16T10:00:00Z',
  ...extra,
})

describe('validateWecomBinding', () => {
  it('缺 processCode/deepLink 等必填 ⇒ BINDING_INCOMPLETE（不猜默认值）', () => {
    expect(validateWecomBinding({ provider: 'wecom_native' }))
      .toMatchObject({ ok: false, code: 'BINDING_INCOMPLETE' })
    expect(validateWecomBinding(valid({ processCode: '  ' })))
      .toMatchObject({ ok: false, code: 'BINDING_INCOMPLETE' })
    expect(validateWecomBinding(valid({ name: '' })))
      .toMatchObject({ ok: false, code: 'BINDING_INCOMPLETE' })
    expect(validateWecomBinding(valid({ verifiedChain: [] })))
      .toMatchObject({ ok: false, code: 'BINDING_INCOMPLETE' })
    expect(validateWecomBinding(null)).toMatchObject({ ok: false, code: 'BINDING_INCOMPLETE' })
  })

  it('合法绑定通过，字段归一（trim），provider 钉住 wecom_native', () => {
    const r = validateWecomBinding(valid({ processCode: ' PC-EXPENSE-001 ' }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.body.provider).toBe('wecom_native')
      expect(r.body.processCode).toBe('PC-EXPENSE-001')
      expect(r.body.verifiedChain).toHaveLength(2)
    }
  })

  it('deepLink 必须是 https（http / 非 URL ⇒ BINDING_DEEPLINK_INVALID）', () => {
    for (const deepLink of ['http://open.work.weixin.qq.com/x', 'open.work.weixin.qq.com', 'not a url']) {
      expect(validateWecomBinding(valid({ deepLink })), deepLink)
        .toMatchObject({ ok: false, code: 'BINDING_DEEPLINK_INVALID' })
    }
  })

  it('verifiedAt 必须是带时区的 RFC3339（裸本地时间/坏串 ⇒ BINDING_VERIFIED_AT_INVALID）', () => {
    for (const verifiedAt of ['2026-11-16 10:00:00', '2026-11-16T10:00:00', 'not-a-date', 12345]) {
      expect(validateWecomBinding(valid({ verifiedAt })), String(verifiedAt))
        .toMatchObject({ ok: false, code: 'BINDING_VERIFIED_AT_INVALID' })
    }
    // 带偏移量也是 RFC3339（平台写入用 Z）
    expect(validateWecomBinding(valid({ verifiedAt: '2026-11-16T18:00:00+08:00' })).ok).toBe(true)
  })

  it('provider 不是 wecom_native ⇒ BINDING_PROVIDER_INVALID（不静默改写）', () => {
    expect(validateWecomBinding(valid({ provider: 'inapp' })))
      .toMatchObject({ ok: false, code: 'BINDING_PROVIDER_INVALID' })
  })
})

describe('itemWecomRefOf（事项模板 → 绑定引用）', () => {
  it('合法引用读出 id/version', () => {
    expect(itemWecomRefOf({ approvalRef: { id: 'expense', version: 3 } }))
      .toEqual({ ok: true, ref: { id: 'expense', version: 3 } })
  })

  it('缺引用 / 坏 id / 坏版本 ⇒ APPROVAL_REF_INVALID（不猜版本）', () => {
    for (const body of [
      {},
      { approvalRef: { version: 1 } },
      { approvalRef: { id: 'Bad_Id', version: 1 } },
      { approvalRef: { id: 'expense', version: 0 } },
      { approvalRef: { id: 'expense', version: 1.5 } },
      null,
    ]) {
      expect(itemWecomRefOf(body), JSON.stringify(body))
        .toMatchObject({ ok: false, code: 'APPROVAL_REF_INVALID' })
    }
  })
})
