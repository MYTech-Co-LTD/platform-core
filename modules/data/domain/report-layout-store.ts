// report-layout-store.ts — 个人版式的存储（issue #2295；迁移 053）。
//
// 只存「本人对某张报表的顺序 + 宽度」。默认版式不在这里——它落在 `data.reports.spec`，
// 走既有的版本/发布语义（`PUT /reports/:id/layout`）。
//
// 读写都过 `validateLayoutItems`：读也要验（库里可能有旧形态/手改数据），
// 不合法按「没有个人版式」处理，绝不让一条坏数据拖垮观看面。
import type { Pool } from 'pg'
import { validateLayoutItems, type LayoutItem } from './report-layout'

export async function getMyLayout(
  pool: Pool, org: string, reportId: string, viewer: string,
): Promise<LayoutItem[] | null> {
  const r = await pool.query(
    'select items from data.report_layout_pref where org = $1 and report_id = $2 and viewer = $3',
    [org, reportId, viewer],
  )
  if (r.rowCount === 0) return null
  const raw = (r.rows[0].items as { items?: unknown } | null)?.items
  return validateLayoutItems(raw)
}

export async function saveMyLayout(
  pool: Pool, org: string, reportId: string, viewer: string, items: LayoutItem[],
): Promise<void> {
  await pool.query(
    `insert into data.report_layout_pref (org, report_id, viewer, items, updated_at)
     values ($1, $2, $3, $4::jsonb, now())
     on conflict (org, report_id, viewer) do update
       set items = excluded.items, updated_at = now()`,
    [org, reportId, viewer, JSON.stringify({ items })],
  )
}

export async function deleteMyLayout(
  pool: Pool, org: string, reportId: string, viewer: string,
): Promise<void> {
  await pool.query(
    'delete from data.report_layout_pref where org = $1 and report_id = $2 and viewer = $3',
    [org, reportId, viewer],
  )
}
