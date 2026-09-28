// report-content.ts — 报表**内容**的读-改-写与指纹（modules/data，spec §3③）。
//
// 一个职责：把「平台怎么读一份报表的真实内容、怎么算它的指纹」收在一处。
// 不碰路由、不碰登记表（那是 report-store）、不碰 Metabase 的 HTTP（那是 metabase.ts）。
import { createHash } from 'node:crypto'
import {
  getCard, getDashboardFull,
} from './metabase'
import type { DashcardRef, DashboardFull, MetabaseDeps } from './metabase'

export interface DashboardContent extends DashboardFull {
  /** 内容指纹（现算）。**覆盖卡片层**——那是 updated_at 抓不到的一层。 */
  fingerprint: string
  /** cardId → 该卡原生查询里的模板标签名 */
  cardTags: Record<number, string[]>
}

/**
 * 指纹的输入与算法。**顺序无关**（dashcards 先按 id 排序、对象键排序后序列化）——
 * 否则同一份内容因返回顺序不同会算出不同指纹，冲突判定就成了随机数。
 *
 * ⚠️ `parameters` 收的是**读侧那份原样列表**（`DashboardFull.parameters` 就是
 *    `Record<string, unknown>[]`）：Task 3 定的硬约束是「参数不许窄化」（窄化了回写会被真机
 *    400）。指纹只取 `slug`，缺 `slug` 归一成 `''`——归一仍是确定性的，且参数**条数**一变
 *    指纹照样变。
 */
export function fingerprintOf(input: {
  dashcards: DashcardRef[]
  parameters: Record<string, unknown>[]
  embeddingParams: Record<string, string>
  cardSqlDigests: Record<number, string>
}): string {
  const canonical = {
    dashcards: [...input.dashcards]
      .sort((a, b) => a.id - b.id)
      .map((d) => [d.id, d.cardId, d.row, d.col, d.sizeX, d.sizeY]),
    parameters: [...input.parameters].map((p) => String(p['slug'] ?? '')).sort(),
    embeddingParams: Object.entries(input.embeddingParams).sort(([a], [b]) => (a < b ? -1 : 1)),
    cardSqlDigests: Object.entries(input.cardSqlDigests).sort(([a], [b]) => Number(a) - Number(b)),
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 24)
}

/** 读一份报表的真实内容 + 指纹。卡片读失败 ⇒ 抛（不静默当成"没卡"）。 */
export async function readDashboardContent(
  deps: MetabaseDeps, dashboardId: number,
): Promise<DashboardContent> {
  const full = await getDashboardFull(deps, dashboardId)
  const cardTags: Record<number, string[]> = {}
  const cardSqlDigests: Record<number, string> = {}
  const seen = new Set<number>()
  for (const dc of full.dashcards) {
    // ⚠️ 文本/虚拟卡没有 card ⇒ 没有模板标签也没有 SQL 可摘要。**跳过**（而不是当 id=null 去查）。
    if (dc.cardId === null) continue
    if (seen.has(dc.cardId)) continue
    seen.add(dc.cardId)
    // 一次 GET 同时取标签与 SQL 正文（`getCard` 的注：分两次调用 = 同一资源取两份快照）。
    const { tags, sql } = await getCard(deps, dc.cardId)
    cardTags[dc.cardId] = tags
    // SQL 摘要：模板标签名参与不了"人改了 SQL 但标签没变"那种改动 ⇒ 摘要要覆盖查询正文
    cardSqlDigests[dc.cardId] = createHash('sha256').update(sql).digest('hex').slice(0, 16)
  }
  return {
    ...full, cardTags,
    fingerprint: fingerprintOf({
      dashcards: full.dashcards, parameters: full.parameters,
      embeddingParams: full.embeddingParams, cardSqlDigests,
    }),
  }
}
