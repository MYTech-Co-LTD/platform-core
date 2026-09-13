import { describe, expect, it } from 'vitest'
import { planMigration } from './migrate-tenant-module-to-subs.mjs'

describe('planMigration（纯核）', () => {
  it('每租户每启用模块产出 锚用户→plan→订阅 三步；空租户跳过', () => {
    expect(planMigration([
      { casdoorOrg: 'acme-org', enabled: ['demo', 'case-engine'] },
      { casdoorOrg: 'woke-org', enabled: [] },
    ])).toEqual([
      { org: 'acme-org', moduleId: 'demo', steps: ['anchor', 'plan', 'subscribe'] },
      { org: 'acme-org', moduleId: 'case-engine', steps: ['anchor', 'plan', 'subscribe'] },
    ])
  })
})
