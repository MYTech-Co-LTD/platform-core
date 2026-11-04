// scripts/tenant-sources.test.ts — 平台侧装配：org → 已接入源（回归 CLI 的 adoptedSources）。
//
// 不连库：假 exec 应答两条 SQL。SQL 本体已收在 `apps/server/src/tenant-source.ts`（单一事实源），
// 本测试只钉「编排顺序 / 参数 / 未知租户 fail-fast / enabled 过滤口径」，不复制 SQL 断言全文。
import { describe, expect, it } from 'vitest'
import { loadAdoptedSources, type SqlExecutor } from './tenant-sources'

function fakeExec(tenant: { id: number } | undefined, sources: string[]) {
  const calls: { text: string; params: unknown[] }[] = []
  const exec = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params: params ?? [] })
      if (/from\s+platform\.tenant\b/.test(text)) {
        return { rows: tenant === undefined ? [] : [tenant], rowCount: tenant === undefined ? 0 : 1 }
      }
      if (/from\s+platform\.tenant_source/.test(text)) {
        return { rows: sources.map((source) => ({ source })), rowCount: sources.length }
      }
      throw new Error(`fake exec: unexpected sql: ${text}`)
    },
  }
  return { calls, exec: exec as unknown as SqlExecutor }
}

describe('loadAdoptedSources', () => {
  it('casdoor_org → tenant_id → 只取 enabled=true 的源', async () => {
    const { exec, calls } = fakeExec({ id: 7 }, ['ama', 'lemeng'])
    const sources = await loadAdoptedSources(exec, 'org-a')
    expect([...sources].sort()).toEqual(['ama', 'lemeng'])
    // 第一条：tenant 解析（按 casdoor_org）；第二条：按 tenant_id 取已启用源
    expect(calls[0]?.text).toContain('casdoor_org = $1')
    expect(calls[0]?.params).toEqual(['org-a'])
    expect(calls[1]?.params).toEqual([7])
    expect(calls[1]?.text).toContain('enabled = true')
  })

  it('未知租户 ⇒ 抛错（不明显地退化成空集，避免全量假红）', async () => {
    const { exec, calls } = fakeExec(undefined, [])
    await expect(loadAdoptedSources(exec, 'nope')).rejects.toThrow(/未知租户/)
    // 解析不到 tenant 就不该再查 tenant_source
    expect(calls).toHaveLength(1)
  })
})
