// seed.test.ts — 文案正典的守卫 + 播种内核（探活 / create-if-absent / 旧版端点回退）。
import { describe, it, expect } from 'vitest'
import { WORKFLOW_COPIES } from './workflows'
import { seedWorkflows } from './seed'

const json = (status: number, body: unknown) => ({
  ok: status < 400,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
})

describe('WORKFLOW_COPIES（文案正典）', () => {
  it('恰好覆盖 §2.6 v1 事件清单的 6 条', () => {
    expect([...WORKFLOW_COPIES].map((w) => w.name).sort()).toEqual([
      'case_awaiting_approval',
      'case_reassigned',
      'case_status_changed',
      'form_assigned',
      'form_due_reminder',
      'sla_breach_warning',
    ])
  })

  it('变量一律摊平——不得出现 {{payload.X}}（Novu 3.19 会渲染为空）', () => {
    for (const w of WORKFLOW_COPIES) {
      expect(w.text.includes('{{payload.'), w.name).toBe(false)
    }
  })

  it('markdown 链接必须闭合（issue #44 教训：漏右括号 ⇒ 企微渲染成字面文本）', () => {
    for (const w of WORKFLOW_COPIES) {
      for (const line of w.text.split('\n')) {
        let i = line.indexOf('](')
        while (i !== -1) {
          expect(line.indexOf(')', i), `${w.name} 未闭合：${line}`).not.toBe(-1)
          i = line.indexOf('](', i + 1)
        }
      }
    }
  })

  it('每条都带 {{link}}（点通知要能跳详情）', () => {
    for (const w of WORKFLOW_COPIES) {
      expect(w.text.includes('{{link}}'), w.name).toBe(true)
    }
  })
})

describe('seedWorkflows', () => {
  it('探活 403 ⇒ 抛错并带基建提示', async () => {
    await expect(
      seedWorkflows({ base: 'https://n', key: 'k', fetchImpl: (async () => json(403, {})) as unknown as typeof fetch }),
    ).rejects.toThrow(/403/)
  })

  it('已存在的不覆盖，缺失的按 WORKFLOW_COPIES 顺序创建', async () => {
    const posts: string[] = []
    const fetchImpl = (async (url: string, opts: { method?: string; body?: string } = {}) => {
      if (url.includes('/v1/workflows?limit=')) return json(200, { data: [{ name: 'case_awaiting_approval' }] })
      if (url.includes('/v1/notification-groups') && opts.method !== 'POST') return json(200, { data: [{ _id: 'g1' }] })
      if (url.includes('/v1/workflows') && opts.method === 'POST') {
        posts.push((JSON.parse(opts.body!) as { name: string }).name)
        return json(201, {})
      }
      throw new Error(`unexpected ${url}`)
    }) as unknown as typeof fetch

    const r = await seedWorkflows({ base: 'https://n', key: 'k', fetchImpl })
    expect(r.skipped).toEqual(['case_awaiting_approval'])
    expect(posts).toEqual([
      'case_status_changed',
      'case_reassigned',
      'form_assigned',
      'form_due_reminder',
      'sla_breach_warning',
    ])
  })

  it('写端点 400 ⇒ 回退 deprecated 别名 /v1/notification-templates', async () => {
    const hits: string[] = []
    const fetchImpl = (async (url: string, opts: { method?: string; body?: string } = {}) => {
      if (url.includes('?limit=')) return json(200, { data: [] })
      if (url.includes('/v1/notification-groups')) return json(200, { data: [{ _id: 'g1' }] })
      if (opts.method === 'POST') {
        hits.push(url)
        return url.includes('/v1/workflows') ? json(400, {}) : json(201, {})
      }
      throw new Error(`unexpected ${url}`)
    }) as unknown as typeof fetch

    const r = await seedWorkflows({ base: 'https://n', key: 'k', fetchImpl, copies: [WORKFLOW_COPIES[0]!] })
    expect(r.created).toEqual(['case_awaiting_approval'])
    expect(hits.some((u) => u.includes('/v1/notification-templates'))).toBe(true)
  })
})
