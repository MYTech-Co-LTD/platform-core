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

function harness(over: { targets?: any[]; users?: string[]; submitted?: string[]; accepted?: boolean; dueRounds?: any[] } = {}) {
  const enqueues: any[] = []
  const pool = {
    query: vi.fn(async () => ({ rows: (over.submitted ?? []).map((s) => ({ submitted_by: s })) })),
  }
  const deps = {
    listTargets: async () => over.targets ?? [target()],
    resolveAssignees: async () => over.users ?? ['u1', 'u2'],
    // 收集轮次催办（#2707）：缺省空集（既有用例零入队不受影响）；用例经 over.dueRounds 注入
    listDueRounds: async () => over.dueRounds ?? [],
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

  // ── ③ 收集轮次催办（件③ / #2707）──

  const dueRound = (over: Record<string, unknown> = {}): any => ({
    round: {
      id: 'r-1', org: ORG, assetId: 'round-form', version: 1, roundKey: '2026-11',
      kind: 'targets', name: '十一月巡检', createdBy: 'op-1',
      ...((over.round as Record<string, unknown>) ?? {}),
    },
    pendingKeys: over.pendingKeys ?? ['u2'],
  })

  it('过期名单轮 ⇒ 逐未交 key 入队 forms.collection.due，event_id 含日期', async () => {
    const now = new Date('2026-11-20T00:00:00Z')
    const { pool, deps, enqueues } = harness({
      dueRounds: [dueRound({ pendingKeys: ['u2'] })],
    })
    const r = await reconcileOnce(pool as any, { deps: deps as any, now })
    const dues = enqueues.filter((e: any) => e.eventKey === 'forms.collection.due')
    expect(dues.map((e: any) => e.eventId)).toEqual([`forms:round:r-1:due:u2:${now.toISOString().slice(0, 10)}`])
    expect(dues[0]).toMatchObject({
      org: ORG, scope: 'r-1', producer: 'forms',
      payload: { roundId: 'r-1', assetId: 'round-form', roundKey: '2026-11', name: '十一月巡检', assignee: 'u2' },
    })
    expect(dues[0].payload.link).toContain('/console/forms/fill/round-form')
    expect(r).toMatchObject({ dueRounds: 1 })
    // emitted 计全部入队（含缺省 target 的 assigned/reminder）；due 恰好 1 条
    expect(dues).toHaveLength(1)
  })

  it('过期值集轮 ⇒ assignee = 开轮人（v1 无逐格收件人，人追格子）', async () => {
    const now = new Date('2026-11-20T00:00:00Z')
    const { pool, deps, enqueues } = harness({
      dueRounds: [dueRound({ round: { id: 'r-2', kind: 'value_grid' }, pendingKeys: ['S001', 'S002'] })],
    })
    await reconcileOnce(pool as any, { deps: deps as any, now })
    const dues = enqueues.filter((e: any) => e.eventKey === 'forms.collection.due')
    expect(dues.map((e: any) => e.eventId)).toEqual([
      `forms:round:r-2:due:S001:${now.toISOString().slice(0, 10)}`,
      `forms:round:r-2:due:S002:${now.toISOString().slice(0, 10)}`,
    ])
    expect(dues.every((e: any) => e.payload.assignee === 'op-1')).toBe(true)
  })

  it('同日跑两次 ⇒ 收集催办 event_id 完全相同（幂等去重的前提）；dryRun 零入队', async () => {
    const now = new Date('2026-11-20T00:00:00Z')
    const a = harness({ dueRounds: [dueRound()] })
    const b = harness({ dueRounds: [dueRound()] })
    await reconcileOnce(a.pool as any, { deps: a.deps as any, now })
    await reconcileOnce(b.pool as any, { deps: b.deps as any, now })
    expect(a.enqueues.filter((e: any) => e.eventKey === 'forms.collection.due').map((e: any) => e.eventId))
      .toEqual(b.enqueues.filter((e: any) => e.eventKey === 'forms.collection.due').map((e: any) => e.eventId))

    const dry = harness({ dueRounds: [dueRound()] })
    const r = await reconcileOnce(dry.pool as any, { deps: dry.deps as any, now, dryRun: true })
    expect(dry.enqueues).toEqual([])
    expect(r.dueRounds).toBe(1) // 只探查不投递
  })
})
