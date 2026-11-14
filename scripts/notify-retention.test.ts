// notify-retention.test.ts — 保留期天数解析纯核（无 DB）
import { describe, it, expect } from 'vitest'
import { retentionDays } from './notify-retention.mjs'

describe('retentionDays', () => {
  it('缺省 90 / 180 / 365 / 90 / 365', () => {
    expect(retentionDays({})).toEqual({
      inboxDays: 90, attemptDays: 180, deliveryDays: 365, eventDays: 90, auditDays: 365,
    })
  })

  it('env 覆盖；空串/非数字/非正数回落缺省', () => {
    expect(retentionDays({
      NOTIFY_INBOX_RETENTION_DAYS: '30',
      NOTIFY_ATTEMPT_RETENTION_DAYS: '60',
      NOTIFY_DELIVERY_RETENTION_DAYS: '120',
      NOTIFY_EVENT_RETENTION_DAYS: '14',
      NOTIFY_AUDIT_RETENTION_DAYS: '180',
    })).toEqual({
      inboxDays: 30, attemptDays: 60, deliveryDays: 120, eventDays: 14, auditDays: 180,
    })

    expect(retentionDays({
      NOTIFY_INBOX_RETENTION_DAYS: '',
      NOTIFY_ATTEMPT_RETENTION_DAYS: 'abc',
      NOTIFY_DELIVERY_RETENTION_DAYS: '-5',
      NOTIFY_EVENT_RETENTION_DAYS: '0',
      NOTIFY_AUDIT_RETENTION_DAYS: 'nope',
    })).toEqual({
      inboxDays: 90, attemptDays: 180, deliveryDays: 365, eventDays: 90, auditDays: 365,
    })
  })
})
