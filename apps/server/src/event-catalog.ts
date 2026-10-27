// event-catalog.ts — 事件目录：manifest → 内存 reader + platform.event_catalog 快照。
// 正典：docs/superpowers/specs/2026-10-27-notification-infrastructure-design.md §3.2
// 事实源是 manifest；本表是投影（UI/agent/规则校验读它，运行时派发不依赖它）。
import type { Pool } from 'pg'
import type { EventCatalogReader, ModuleManifest, NotificationEventDecl } from '@platform/sdk'

export interface CatalogEntry {
  key: string
  moduleId: string
  title: string
  description?: string
  scopeKey?: string
  payloadSchema: Record<string, unknown>
  recipients: Record<string, unknown>
  defaults?: unknown
  source: 'module' | 'external'
}

export function buildCatalog(
  manifests: Pick<ModuleManifest, 'id' | 'notifications'>[],
): CatalogEntry[] {
  const out: CatalogEntry[] = []
  for (const m of manifests) {
    for (const ev of m.notifications?.events ?? []) {
      out.push({
        key: ev.key,
        moduleId: m.id,
        title: ev.title,
        description: ev.description,
        scopeKey: ev.scope?.key,
        payloadSchema: ev.payload,
        recipients: ev.recipients,
        defaults: ev.defaults,
        source: 'module',
      })
    }
  }
  return out
}

export function createCatalogReader(entries: CatalogEntry[]): EventCatalogReader {
  const byKey = new Map<string, NotificationEventDecl>()
  for (const e of entries) {
    byKey.set(e.key, {
      key: e.key,
      title: e.title,
      description: e.description,
      scope: e.scopeKey ? { key: e.scopeKey } : undefined,
      payload: e.payloadSchema as NotificationEventDecl['payload'],
      recipients: e.recipients as NotificationEventDecl['recipients'],
      defaults: e.defaults as NotificationEventDecl['defaults'],
    })
  }
  return {
    get: (key) => byKey.get(key),
    list: (filter) => {
      if (filter?.active === false) return []
      return [...byKey.values()].filter((ev) =>
        filter?.moduleId ? ev.key.startsWith(filter.moduleId + '.') : true,
      )
    },
  }
}

/**
 * 全量 upsert + 缺失标 inactive。
 * **只对本次已加载模块**做 inactive 标记：未加载的模块/外部生产者一律不动，
 * 避免部分部署把别人的事件误下线。
 */
export async function upsertCatalog(
  pool: Pool,
  entries: CatalogEntry[],
  loadedModuleIds: string[],
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    for (const e of entries) {
      await client.query(
        `insert into platform.event_catalog
           (key,module_id,title,description,scope_key,payload_schema,recipients,defaults,source,active,updated_at)
         values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,true,now())
         on conflict (key) do update set
           module_id=excluded.module_id,
           title=excluded.title,
           description=excluded.description,
           scope_key=excluded.scope_key,
           payload_schema=excluded.payload_schema,
           recipients=excluded.recipients,
           defaults=excluded.defaults,
           source=excluded.source,
           active=true,
           updated_at=now()`,
        [
          e.key,
          e.moduleId,
          e.title,
          e.description ?? null,
          e.scopeKey ?? null,
          JSON.stringify(e.payloadSchema),
          JSON.stringify(e.recipients),
          e.defaults === undefined ? null : JSON.stringify(e.defaults),
          e.source,
        ],
      )
    }
    await client.query(
      `update platform.event_catalog
          set active = false, updated_at = now()
        where module_id = any($1::text[]) and not (key = any($2::text[]))`,
      [loadedModuleIds, entries.map((e) => e.key)],
    )
    await client.query('commit')
  } catch (e) {
    await client.query('rollback')
    throw e
  } finally {
    client.release()
  }
}
