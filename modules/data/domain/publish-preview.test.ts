// publish-preview.test.ts — 发布前可见面解释（R6）：宽窄判据与提示。
import { describe, expect, it } from 'vitest'
import { summarizeExposure } from './publish-preview'

const acl = [{ subjectType: 'user' as const, subjectId: 'u1', relation: 'viewer' as const }]

describe('summarizeExposure', () => {
  it('全租户 + 无门 + 无部门 ⇒ 最宽可见面，警告明确', () => {
    const s = summarizeExposure({ visibility: 'tenant', requiredScope: null, requiredDepts: [], acl: [] })
    expect(s.audience).toBe('tenant')
    expect(s.summary).toContain('本租户所有持 data:query 的成员')
    expect(s.warnings.join('；')).toContain('最宽的可见面')
  })

  it('全租户 + 页门 + 部门门 ⇒ 逐条写清约束', () => {
    const s = summarizeExposure({
      visibility: 'tenant', requiredScope: 'data:cost', requiredDepts: ['T7D1'], acl: [],
    })
    expect(s.summary).toContain('且需具备 data:cost')
    expect(s.summary).toContain('且属于 1 个部门')
    expect(s.warnings).toEqual([])
  })

  it('restricted 且名单为空 ⇒ 提示只有 owner 能看到', () => {
    const s = summarizeExposure({ visibility: 'restricted', requiredScope: 'data:query', requiredDepts: [], acl: [] })
    expect(s.audience).toBe('acl')
    expect(s.warnings.join('；')).toContain('只有所有者能看到')
  })

  it('restricted 有名单 ⇒ 名单人数写进摘要', () => {
    const s = summarizeExposure({ visibility: 'restricted', requiredScope: null, requiredDepts: [], acl })
    expect(s.summary).toContain('1 人/部门/角色')
  })
})
