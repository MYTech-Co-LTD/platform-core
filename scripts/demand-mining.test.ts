// scripts/demand-mining.test.ts — 多 org 参数面（纯函数，不起进程、不连库）。
//
// 钉三件事：
//   ① `--org` / `--all-tenants` 互斥、打错参数不静默；
//   ② 租户枚举为空 ⇒ 不猜、不空跑成功；
//   ③ 单 org 失败隔离（其余 org 继续），失败要汇总点名。
import { describe, expect, it } from 'vitest'
import { convMiningAllowed, parseArgs, resolveOrgs, runPerOrg } from './demand-mining.mjs'

describe('demand-mining parseArgs', () => {
  it('都不传 ⇒ platform 模式（向后兼容 PLATFORM_ORG）', () => {
    expect(parseArgs([])).toEqual({ allTenants: false, org: null })
  })

  it('--org 与 --all-tenants 两种形态', () => {
    expect(parseArgs(['--org', 'acme'])).toEqual({ allTenants: false, org: 'acme' })
    expect(parseArgs(['--org=acme'])).toEqual({ allTenants: false, org: 'acme' })
    expect(parseArgs(['--all-tenants'])).toEqual({ allTenants: true, org: null })
  })

  it('互斥 / 缺值 / 空值 / 未知参数 ⇒ 抛错（不静默）', () => {
    expect(() => parseArgs(['--org', 'acme', '--all-tenants'])).toThrow(/互斥/)
    expect(() => parseArgs(['--all-tenants', '--org', 'acme'])).toThrow(/互斥/)
    expect(() => parseArgs(['--org'])).toThrow(/缺值/)
    expect(() => parseArgs(['--org', '  '])).toThrow(/--org/)
    expect(() => parseArgs(['acme'])).toThrow(/无法识别/)
    expect(() => parseArgs(['--bogus'])).toThrow(/未知参数/)
  })
})

describe('demand-mining resolveOrgs', () => {
  it('platform 模式用 PLATFORM_ORG；缺了响亮失败', () => {
    expect(resolveOrgs({ allTenants: false, org: null }, { platformOrg: 'p', tenants: ['a'] }))
      .toEqual(['p'])
    expect(() => resolveOrgs({ allTenants: false, org: null }, { platformOrg: '', tenants: ['a'] }))
      .toThrow(/PLATFORM_ORG/)
  })

  it('--org 模式只跑该 org（即使租户表有多行）', () => {
    expect(resolveOrgs({ allTenants: false, org: 'mytech' }, { platformOrg: 'p', tenants: ['a', 'mytech'] }))
      .toEqual(['mytech'])
  })

  it('--all-tenants 用枚举顺序；空列表不猜、不空跑成功', () => {
    expect(resolveOrgs({ allTenants: true, org: null }, { platformOrg: '', tenants: ['b', 'a'] }))
      .toEqual(['b', 'a'])
    expect(() => resolveOrgs({ allTenants: true, org: null }, { platformOrg: '', tenants: [] }))
      .toThrow(/platform\.tenant/)
  })
})

describe('demand-mining conv 归因护栏', () => {
  it('只有部署恰好 1 个租户时才允许挖对话侧', () => {
    expect(convMiningAllowed(1)).toBe(true)
    expect(convMiningAllowed(0)).toBe(false)
    expect(convMiningAllowed(2)).toBe(false)
  })
})

describe('demand-mining runPerOrg（失败隔离）', () => {
  it('单个 org 失败不拖停其余；汇总点名失败 org', async () => {
    const seen: string[] = []
    const out = await runPerOrg(['a', 'b', 'c'], async (org: string) => {
      seen.push(org)
      if (org === 'b') throw new Error('boom')
      return `${org}-ok`
    })
    expect(seen).toEqual(['a', 'b', 'c'])
    expect(out.ok).toEqual([{ org: 'a', value: 'a-ok' }, { org: 'c', value: 'c-ok' }])
    expect(out.failed).toEqual([{ org: 'b', error: 'boom' }])
  })

  it('顺序按入参（串行，不并发打库）', async () => {
    const seen: string[] = []
    await runPerOrg(['x', 'y'], async (org: string) => { seen.push(org) })
    expect(seen).toEqual(['x', 'y'])
  })
})
