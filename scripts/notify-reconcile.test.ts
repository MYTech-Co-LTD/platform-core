// notify-reconcile.test.ts — 对账脚本的编排纯核（无 DB；scripts/ 测试只钉纯核）
import { describe, expect, it, vi } from 'vitest'
import { reconcileOnce } from './notify-reconcile.mjs'

const ORG = 'acme'
const DAY = 86400000
const PUB = '2026-10-01T00:00:00.000Z'

/* eslint-disable @typescript-eslint/no-explicit-any */
function target(over: Record<string, unknown> = {}): any {
  return {
    org: ORG,
    assetId: 'form-1',
    version: 1,
    publishedAt: PUB,
    body: { schema: {}, assignees: { dictRef: 'dict:staff' }, due: { afterDays: 7 } },
    ...over,
  }
}

function harness(over: { targets?: any[]; users?: string[]; submitted?: string[]; accepted?: boolean } = {}) {
  const enqueues: any[] = []
  const pool = {
    query: vi.fn(async () => ({ rows: (over.submitted ?? []).map((s) => ({ submitted_by: s })) })),
  }
  const deps = {
    listTargets: async () => over.targets ?? [target()],
    resolveAssignees: async () => over.users ?? ['u1', 'u2'],
    enqueue: async (_pool: unknown, input: unknown) => {
      enqueues.push(input)
      return over.accepted === false
        ? { accepted: false, reason: 'duplicate' }
        : { accepted: true }
    },
  }
  return { pool, deps, enqueues }
}

describe('reconcileOnce（编排，依赖注入）', () => {
  it('无 due ⇒ 逐人入队 forms.form.assigned；event_id 确定性', async () => {
    const { pool, deps, enqueues } = harness({
      targets: [target({ body: { assignees: { dictRef: 'dict:staff' } } })],
    })
    const r = await reconcileOnce(pool as any, {
      deps: deps as any, now: new Date('2026-10-02T00:00:00Z'),
    })
    expect(enqueues.map((e: any) => e.eventId)).toEqual([
      'form:form-1:1:assigned:u1', 'form:form-1:1:assigned:u2',
    ])
    expect(enqueues.every((e: any) => e.eventKey === 'forms.form.assigned')).toBe(true)
    expect(enqueues.every((e: any) => e.payload.assignee && e.payload.assetId === 'form-1')).toBe(true)
    expect(r).toMatchObject({ targets: 1, emitted: 2, duplicates: 0 })
  })

  it('含 due 但未到期 ⇒ 只入队 assigned', async () => {
    const { pool, deps, enqueues } = harness()
    await reconcileOnce(pool as any, { deps: deps as any, now: new Date(PUB) })
    expect(enqueues.every((e: any) => e.eventKey === 'forms.form.assigned')).toBe(true)
  })

  it('到期且 u2 已提交 ⇒ 只给 u1 入队 due_reminder，event_id 含日期', async () => {
    const { pool, deps, enqueues } = harness({ submitted: ['u2'] })
    const now = new Date(new Date(PUB).getTime() + 8 * DAY)
    await reconcileOnce(pool as any, { deps: deps as any, now })
    const reminders = enqueues.filter((e: any) => e.eventKey === 'forms.form.due_reminder')
    expect(reminders.map((e: any) => e.eventId)).toEqual([
      `form:form-1:1:remind:u1:${now.toISOString().slice(0, 10)}`,
    ])
    expect(reminders[0].payload.assignee).toBe('u1')
  })

  it('契约不含 assignees / 名单空 ⇒ 零入队', async () => {
    const noDecl = harness({ targets: [target({ body: { schema: {} } })] })
    await reconcileOnce(noDecl.pool as any, { deps: noDecl.deps as any })
    expect(noDecl.enqueues).toEqual([])

    const empty = harness({ users: [] })
    await reconcileOnce(empty.pool as any, { deps: empty.deps as any })
    expect(empty.enqueues).toEqual([])
  })

  it('dryRun ⇒ 零入队（只读探查）', async () => {
    const { pool, deps, enqueues } = harness()
    await reconcileOnce(pool as any, { deps: deps as any, dryRun: true, now: new Date(PUB) })
    expect(enqueues).toEqual([])
  })

  it('同日跑两次 ⇒ event_id 完全相同（幂等去重的前提）', async () => {
    const now = new Date(new Date(PUB).getTime() + 8 * DAY)
    const a = harness({ submitted: [] })
    const b = harness({ submitted: [] })
    await reconcileOnce(a.pool as any, { deps: a.deps as any, now })
    await reconcileOnce(b.pool as any, { deps: b.deps as any, now })
    expect(a.enqueues.map((e: any) => e.eventId)).toEqual(b.enqueues.map((e: any) => e.eventId))
  })

  it('重复入队计入 duplicates（不抛，fail-open）', async () => {
    const { pool, deps } = harness({ accepted: false })
    const r = await reconcileOnce(pool as any, { deps: deps as any, now: new Date(PUB) })
    expect(r.emitted).toBe(0)
    expect(r.duplicates).toBe(2)
  })
})
