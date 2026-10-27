// event-catalog.test.ts — 事件目录构建 / 快照 upsert / reader（2026-10-27 通知基础设施 §3.2）
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { fileURLToPath } from 'node:url'
import { buildCatalog, createCatalogReader, upsertCatalog } from './event-catalog'
import { runMigrations } from './migrate'

const url = process.env.DATABASE_URL
const describePg = url ? describe : describe.skip

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
