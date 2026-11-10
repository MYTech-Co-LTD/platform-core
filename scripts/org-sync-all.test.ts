// org-sync-all.test.ts — 定时同步脚本的纯函数（issue #1819）。
// 主流程（DB/企微/Casdoor）靠真机 dry-run 验；这里只钉「租户选择」与「不打印 secret」的形状。
import { describe, it, expect } from 'vitest'
import { formatResult, pickTenants } from './org-sync-all.mjs'

const t = (org: string, secret: string | null = 's') => ({
  id: 1,
  casdoor_org: org,
  wecom_corp_id: 'ww',
  wecom_secret: secret,
})

describe('pickTenants', () => {
  it('无 --org ⇒ 全量；有 --org ⇒ 精确匹配', () => {
    const rows = [t('acme'), t('beta')]
    expect(pickTenants(rows, undefined).map((x) => x.casdoor_org)).toEqual(['acme', 'beta'])
    expect(pickTenants(rows, 'beta').map((x) => x.casdoor_org)).toEqual(['beta'])
    expect(pickTenants(rows, 'nope')).toEqual([])
  })

  it('★ 不在此处过滤无企微配置的租户（要让主流程打印 skipped，不能静默消失）', () => {
    expect(pickTenants([t('acme', null)], undefined)).toHaveLength(1)
  })
})

describe('formatResult', () => {
  it('★ 输出只含计划数字与未建号数量，不含 secret/名单', () => {
    const line = formatResult('acme', {
      dryRun: true,
      deptCount: 3,
      userCount: 5,
      nodesCreated: 1,
      nodesRenamed: 0,
      nodesReparented: 0,
      nodesDisabled: 0,
      nodesReactivated: 0,
      membersAdded: 2,
      membersRemoved: 0,
      usersNotInCasdoor: ['alice', 'bob'],
    })
    expect(line).toContain('org=acme dryRun=true depts=3 users=5')
    expect(line).toContain('notInCasdoor=2')
    expect(line).not.toContain('alice')
  })
})
