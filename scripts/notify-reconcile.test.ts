// notify-reconcile.test.ts — §2.4「指派与催办」对账脚本的**编排纯核**（无 DB）。
// 口径照 scripts/reconcile-tenant-sources.test.ts：scripts/ 的测试只钉纯核（根 vitest 解析不到 pg，
// 且真库连不上）；真库端到端在 modules/notify/notify-reconcile-db.test.ts（那里 pg 可解析）。
// 依赖注入：reconcileOnce 的 DB 触面全部可替换 ⇒ 断言编排（确定性 event_id / 分支 / 幂等前提）。
import { describe, expect, it, vi } from 'vitest'
import { reconcileOnce } from './notify-reconcile.mjs'

const ORG = 'acme'
const DAY = 86400000
const PUB = '2026-10-01T00:00:00.000Z' // publishedAt 夹具

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

function harness(over: { targets?: any[]; users?: string[]; submitted?: string[] } = {}) {
  const emits: any[] = []
  const upserts: any[] = []
  const pool = {
    query: vi.fn(async () => ({ rows: (over.submitted ?? []).map((s) => ({ submitted_by: s })) })),
  }
  const deps = {
    listTargets: async () => over.targets ?? [target()],
    resolveAssignees: async () => over.users ?? ['u1', 'u2'],
    emitEvent: async (_d: unknown, input: unknown) => {
      emits.push(input)
      return { matched: 1, delivered: 1, failed: 0 }
    },
    upsert: async (_p: unknown, _o: string, rule: unknown) => {
      upserts.push(rule)
    },
  }
  return { pool, deps, emits, upserts }
}

describe('reconcileOnce（编排，依赖注入）', () => {
  it('含 assignees 无 due ⇒ 派生 form.assigned 一条；逐人 emit，event_id 确定性', async () => {
    const { pool, deps, emits, upserts } = harness({
      targets: [target({ body: { assignees: { dictRef: 'dict:staff' } } })],
    })
    const r = await reconcileOnce(pool as any, { deps: deps as any, now: new Date('2026-10-02T00:00:00Z') })
    expect(upserts.map((u: any) => u.id)).toEqual(['derived:form:form-1:form.assigned'])
    expect(emits.map((e: any) => e.eventId)).toEqual(['form:form-1:1:assigned:u1', 'form:form-1:1:assigned:u2'])
    expect(emits.every((e: any) => e.eventType === 'form.assigned' && e.payload.assignee)).toBe(true)
    expect(r).toMatchObject({ derived: 1, emitted: 2, failed: 0, targets: 1 })
  })

  it('含 due 但未到期 ⇒ 派生两条规则，只 emit assigned（无 due_reminder）', async () => {
    const { pool, deps, emits, upserts } = harness()
    await reconcileOnce(pool as any, { deps: deps as any, now: new Date(PUB) }) // = 发布时刻，未到期
    expect(upserts.map((u: any) => u.id)).toEqual([
      'derived:form:form-1:form.assigned',
      'derived:form:form-1:form.due_reminder',
    ])
    expect(emits.every((e: any) => e.eventType === 'form.assigned')).toBe(true)
  })

  it('到期且 u2 已提交 ⇒ 只给 u1 发 due_reminder，event_id 含日期', async () => {
    const { pool, deps, emits } = harness({ submitted: ['u2'] })
    const now = new Date(new Date(PUB).getTime() + 8 * DAY)
    await reconcileOnce(pool as any, { deps: deps as any, now })
    const reminders = emits.filter((e: any) => e.eventType === 'form.due_reminder')
    expect(reminders.map((e: any) => e.eventId)).toEqual([
      `form:form-1:1:remind:u1:${now.toISOString().slice(0, 10)}`,
    ])
    expect(reminders[0].payload.assignee).toBe('u1')
  })

  it('契约不含 assignees ⇒ 零派生、零 emit（负对照：存量表单不受影响）', async () => {
    const { pool, deps, emits, upserts } = harness({ targets: [target({ body: { schema: {} } })] })
    const r = await reconcileOnce(pool as any, { deps: deps as any })
    expect(emits).toEqual([])
    expect(upserts).toEqual([])
    expect(r).toMatchObject({ derived: 0, emitted: 0, targets: 1 })
  })

  it('名单空（字典无条目 / 全软删）⇒ 零 emit', async () => {
    const { pool, deps, emits } = harness({ users: [] })
    await reconcileOnce(pool as any, { deps: deps as any })
    expect(emits).toEqual([])
  })

  it('dryRun ⇒ 不 upsert，但仍 emit（只读探查）', async () => {
    const { pool, deps, emits, upserts } = harness()
    await reconcileOnce(pool as any, { deps: deps as any, dryRun: true, now: new Date(PUB) }) // 未到期
    expect(upserts).toEqual([])
    expect(emits.length).toBe(2)
  })

  it('同日跑两次 ⇒ event_id 完全相同（幂等去重的前提，去重由 emit 侧 claim 落）', async () => {
    const now = new Date(new Date(PUB).getTime() + 8 * DAY)
    const a = harness({ submitted: [] })
    const b = harness({ submitted: [] })
    await reconcileOnce(a.pool as any, { deps: a.deps as any, now })
    await reconcileOnce(b.pool as any, { deps: b.deps as any, now })
    expect(a.emits.map((e: any) => e.eventId)).toEqual(b.emits.map((e: any) => e.eventId))
  })

  it('emit 报 failed 时计入返回值（fail-open：不抛，只计数）', async () => {
    const { pool, deps } = harness()
    const failing = {
      ...deps,
      emitEvent: async () => ({ matched: 1, delivered: 0, failed: 1 }),
    }
    const r = await reconcileOnce(pool as any, { deps: failing as any, now: new Date(PUB) }) // 未到期
    expect(r.failed).toBe(2)
    expect(r.emitted).toBe(0)
  })
})

// ── 回归 #936：Novu 装配传「值」不传「函数」（#929 改 emit 签名时漏改本脚本）──────────────
// 判据为什么钉在**缺省 DI** 这条缝上：脚本的 CLI 入口被
// `import.meta.url === pathToFileURL(process.argv[1]).href` 守着，测试 import 不到它；
// 但 CLI 传给 reconcileOnce 的 `novu` 与 reconcileOnce 的**缺省值**是同一个槽，缺省
// `emitEvent` 又 = 真 `emit`（modules/notify/pipeline.ts）——它在管道内按 `deps.novu(input.org)`
// **调用** novu。于是「缺省 DI 跑一轮不抛 TypeError」正是本 bug 的判据：
// 修复前缺省 novu = null ⇒ `TypeError: deps.novu is not a function`（实测红）。
// 负对照：上面那组用例全部注入假 emitEvent ⇒ 结构性绕开真管道，故对本 bug 恒绿。
describe('缺省 DI 装配（#936：novu 必须是 resolver 函数，不是 NovuConfig 值）', () => {
  it('不传 novu / 不传 emitEvent ⇒ 走真 emit 管道，不得抛 TypeError', async () => {
    const pool = { query: vi.fn(async () => ({ rows: [] })) } // notify.rule 空 ⇒ emit 内 matched=0
    const r = await reconcileOnce(pool as any, {
      now: new Date(PUB), // = 发布时刻，未到期 ⇒ 不查 forms.submission
      deps: {
        listTargets: async () => [target()],
        resolveAssignees: async () => ['u1'],
        upsert: async () => {},
      } as any,
    })
    // 含 due ⇒ 派生 2 条；规则表空 + 无 NOVU_* env ⇒ 零投递零失败（fail-open，不抛）
    expect(r).toMatchObject({ targets: 1, derived: 2, emitted: 0, failed: 0 })
  })
})
