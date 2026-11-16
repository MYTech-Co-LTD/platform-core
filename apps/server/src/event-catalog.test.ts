// event-catalog.test.ts — 事件目录构建 / 快照 upsert / reader（2026-10-27 通知基础设施 §3.2）
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { fileURLToPath } from 'node:url'
import { buildCatalog, createCatalogReader, upsertCatalog } from './event-catalog'
import { runMigrations } from './migrate'
import { ManifestSchema } from '@platform/sdk'

const url = process.env.DATABASE_URL
const describePg = url ? describe : describe.skip

// 无 DB 依赖：external 生产者协议（OA P0 Task 3）+ 事件 key 前缀回归。
// 刻意放在 describePg 之外——buildCatalog 与 ManifestSchema 都不碰 PG，放进 DB 门里会在
// 无 DATABASE_URL 的环境被整体跳过，协议缺陷就静默不可见。
describe('event-catalog external 生产者', () => {
  it('producer 存在时 moduleId 记为 external:<name>，source=external', () => {
    const entries = buildCatalog([{
      id: 'forms',
      notifications: { events: [{
        key: 'forms.approval.awaiting', title: '待审批',
        producer: 'external:case-engine',
        payload: { submissionId: { type: 'string', required: true } },
        recipients: { approver: { kind: 'field', field: 'assignee' } },
      }] },
    }] as never)
    expect(entries[0]).toMatchObject({ moduleId: 'external:case-engine', source: 'external' })
  })

  it('无 producer 时行为逐字不变：moduleId=模块 id，source=module', () => {
    const entries = buildCatalog([{
      id: 'forms',
      notifications: { events: [{
        key: 'forms.approval.awaiting', title: '待审批',
        payload: { submissionId: { type: 'string', required: true } },
        recipients: { approver: { kind: 'field', field: 'assignee' } },
      }] },
    }] as never)
    expect(entries[0].moduleId).toBe('forms')
    expect(entries[0].source).toBe('module')
  })

  it('ManifestSchema：external 事件的 key 仍必须以声明模块 id 开头', () => {
    const base = { id: 'forms', name: 'x', version: '0.2.0', platform: '>=0.1', permissions: [], notifications: { events: [] } }
    // payload 必须带 recipients.approver 指向的 user 字段——否则「合法 key」那条会因收件人
    // 形状不合法而误判为 false（与 producer 无关的既有校验）。
    const ev = { key: 'forms.approval.awaiting', title: 't', producer: 'external:case-engine',
      payload: { submissionId: { type: 'string', required: true }, assignee: { type: 'user', required: true } },
      recipients: { approver: { kind: 'field', field: 'assignee' } } }
    expect(ManifestSchema.safeParse({ ...base, notifications: { events: [ev] } }).success).toBe(true)
    expect(ManifestSchema.safeParse({ ...base, notifications: { events: [{ ...ev, key: 'approval.awaiting' }] } }).success).toBe(false)
  })
})

describePg('event-catalog', () => {
  let pool: Pool

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await runMigrations(pool, 'platform', fileURLToPath(new URL('./migrations', import.meta.url)))
  })
  afterAll(async () => {
    await pool.query("delete from platform.event_catalog where module_id = 'm1'")
    await pool.end()
  })
  beforeEach(async () => {
    await pool.query("delete from platform.event_catalog where module_id = 'm1'")
  })

  it('buildCatalog 只取声明的事件', () => {
    const out = buildCatalog([
      {
        id: 'm1',
        notifications: {
          events: [{
            key: 'm1.a.b',
            title: 't',
            payload: { u: { type: 'user' } },
            recipients: { r: { kind: 'field', field: 'u' } },
          }],
        },
      },
      { id: 'm2' },
    ] as never)

    expect(out).toEqual([{
      key: 'm1.a.b',
      moduleId: 'm1',
      title: 't',
      description: undefined,
      scopeKey: undefined,
      payloadSchema: { u: { type: 'user' } },
      recipients: { r: { kind: 'field', field: 'u' } },
      defaults: undefined,
      source: 'module',
    }])
  })

  it('upsert 幂等 + 已加载模块的旧事件标 inactive', async () => {
    await upsertCatalog(pool, [
      { key: 'm1.a.old', moduleId: 'm1', title: 'old', payloadSchema: {}, recipients: {}, source: 'module' },
      { key: 'm1.a.new', moduleId: 'm1', title: 'new', payloadSchema: {}, recipients: {}, source: 'module' },
    ], ['m1'])

    await upsertCatalog(pool, [
      { key: 'm1.a.new', moduleId: 'm1', title: 'new2', payloadSchema: {}, recipients: {}, source: 'module' },
    ], ['m1'])

    const r = await pool.query(
      "select key,title,active from platform.event_catalog where module_id='m1' order by key",
    )
    expect(r.rows).toEqual([
      { key: 'm1.a.new', title: 'new2', active: true },
      { key: 'm1.a.old', title: 'old', active: false },
    ])

    const reader = createCatalogReader([{
      key: 'm1.a.new', moduleId: 'm1', title: 'new2', payloadSchema: {}, recipients: {}, source: 'module',
    }])
    expect(reader.get('m1.a.new')?.title).toBe('new2')
  })

  it('未加载的模块不被误标 inactive（部分部署安全）', async () => {
    await upsertCatalog(pool, [
      { key: 'other.x.y', moduleId: 'other', title: 'keep', payloadSchema: {}, recipients: {}, source: 'module' },
    ], ['other'])

    await upsertCatalog(pool, [], ['m1'])

    const r = await pool.query(
      "select active from platform.event_catalog where key='other.x.y'",
    )
    expect(r.rows[0].active).toBe(true)
    await pool.query("delete from platform.event_catalog where module_id='other'")
  })
})
