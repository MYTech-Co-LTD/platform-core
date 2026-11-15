// monitor-recipients.test.ts — 投递期复判（W7-V1 Task 3，spec §9）。
import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { resolveMonitorRecipients } from './monitor-recipients'

const pool = {} as Pool

describe('resolveMonitorRecipients', () => {
  it('成员保留；退权/不存在的人剔除并留原因', async () => {
    const r = await resolveMonitorRecipients(pool, 'org-mon', [
      { kind: 'user', ref: 'alice' },
      { kind: 'user', ref: 'gone' },
    ], { membersOf: async () => ['alice', 'bob'] })
    expect(r.to).toEqual(['alice'])
    expect(r.excluded).toEqual([{ ref: 'gone', reason: 'not_member' }])
  })

  it('部门展开为空 ⇒ 每个部门留 no_dept_members', async () => {
    const r = await resolveMonitorRecipients(pool, 'org-mon', [
      { kind: 'dept', ref: '101' }, { kind: 'dept', ref: '102' },
    ], { deptMembersOf: async () => [] })
    expect(r.to).toEqual([])
    expect(r.excluded).toEqual([
      { ref: '101', reason: 'no_dept_members' },
      { ref: '102', reason: 'no_dept_members' },
    ])
  })

  it('user 与 dept 去重（同一人只发一次，保插入序）', async () => {
    const r = await resolveMonitorRecipients(pool, 'org-mon', [
      { kind: 'user', ref: 'alice' },
      { kind: 'dept', ref: '101' },
    ], {
      membersOf: async () => ['alice'],
      deptMembersOf: async () => ['alice', 'bob'],
    })
    expect(r.to).toEqual(['alice', 'bob'])
    expect(r.excluded).toEqual([])
  })
})
