// report-content.ts — 报表**内容**的读-改-写与指纹（modules/data，spec §3③）。
//
// 一个职责：把「平台怎么读一份报表的真实内容、怎么算它的指纹」收在一处。
// 不碰路由、不碰登记表（那是 report-store）、不碰 Metabase 的 HTTP（那是 metabase.ts）。
import { createHash } from 'node:crypto'
import {
  getCard, getDashboardFull, putDashboardMerged,
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
      // ⚠️ 投影带 `visualizationSettings` + `parameterMappings`（人裁 2026-09-29）：前者是文本卡
      // （cardId=null）内容的唯一居所——丢了它，"人改文本卡文字"指纹不动；后者是 Task 5 要写的
      // 东西——丢了它，人手动改映射指纹也不动。两类都是写保护该看见的改动。
      .map((d) => [d.id, d.cardId, d.row, d.col, d.sizeX, d.sizeY,
                   d.visualizationSettings, d.parameterMappings]),
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
    // 一次 GET 同时取标签与查询定义（`getCard` 的注：分两次调用 = 同一资源取两份快照）。
    const { tags, queryJson } = await getCard(deps, dc.cardId)
    cardTags[dc.cardId] = tags
    // 查询摘要：模板标签名参与不了"人改了查询但标签没变"那种改动 ⇒ 摘要要覆盖**查询定义本身**
    // （取 native SQL 字符串的话 MBQL 卡恒得 hash('')，那类卡的改动就整类漏掉）。
    cardSqlDigests[dc.cardId] = createHash('sha256').update(queryJson).digest('hex').slice(0, 16)
  }
  return {
    ...full, cardTags,
    fingerprint: fingerprintOf({
      dashcards: full.dashcards, parameters: full.parameters,
      embeddingParams: full.embeddingParams, cardSqlDigests,
    }),
  }
}

/** 平台保留的锁定参数名（routes 侧直接 import 本常量——单一来源，终审修复 2026-09-29）。 */
export const TENANT_SLUG = 'tenant'
/**
 * dashboard 级 tenant 参数在 Metabase 侧的 `id`（参数声明与卡片 `parameter_mappings` 都指它）。
 * 对账判「锁了但绑不到」要按 `parameter_id === TENANT_PARAM_ID` 自己比——**从这里 import**，
 * 别另写一份字面量（两处漂移 ⇒ 对账恒假绿）。
 */
export const TENANT_PARAM_ID = 'tenant-param'

/**
 * 发布：**一次做全三件**（spec §3②）。
 *   ① 声明 dashboard 级 `tenant` 参数（缺它 ⇒ 锁住的值**绑不到任何东西**）
 *   ② 把**真正用到** `{{tenant}}` 模板标签的卡片映射到它（不带的别映射，映射了会报错）
 *   ③ 设 `embedding_params.tenant = 'locked'`
 * 全程走 `putDashboardMerged`（非破坏性）。
 *
 * 返回发布后的 `fingerprint`（现算）——写保护守卫（计划 3）的比对物由这里产出；
 * 只回读 `embedding_params` 的对账会把「只锁参、没声明/没映射」判成 OK（静默失效）。
 */
export async function publishWithTenantBinding(
  deps: MetabaseDeps, dashboardId: number,
): Promise<{ mapped: number; fingerprint: string; embeddingParams: Record<string, string> }> {
  const cur = await readDashboardContent(deps, dashboardId)
  let mapped = 0
  // 逐卡决定：**带 tenant 模板标签的**才映射（不带的映射了会报错），布局与已有映射原样保留
  const dashcards = cur.dashcards.map((d) => {
    const hasTenant = d.cardId !== null && (cur.cardTags[d.cardId] ?? []).includes(TENANT_SLUG)
    if (hasTenant) mapped += 1
    return {
      ...d,
      ...(hasTenant
        ? { parameterMappings: [{ parameter_id: TENANT_PARAM_ID, card_id: d.cardId,
                                  target: ['variable', ['template-tag', TENANT_SLUG]] }] }
        : {}),
    }
  })
  // ⚠️ 参数是**合并保留**不是整表替换（人裁 2026-09-29）：putDashboardMerged 对 parameters 是
  // `patch.parameters ?? cur.parameters` 整表替换——单元素列表会把人在 Metabase 手动声明的其它
  // 参数静默抹掉（与 Task 3「裸 PUT 清卡」同构，作用在参数维度）。先剔旧 tenant 项再追加。
  const tenantParam = { id: TENANT_PARAM_ID, name: TENANT_SLUG, slug: TENANT_SLUG, type: 'category', sectionId: 'string' }
  const otherParams = cur.parameters.filter(
    (p) => p['id'] !== TENANT_PARAM_ID && p['slug'] !== TENANT_SLUG)
  await putDashboardMerged(deps, dashboardId, {
    parameters: [...otherParams, tenantParam],
    dashcards,
    enable_embedding: true, embedding_type: 'signed',
    embedding_params: { [TENANT_SLUG]: 'locked' },
  })
  const after = await readDashboardContent(deps, dashboardId)
  return { mapped, fingerprint: after.fingerprint, embeddingParams: after.embeddingParams }
}
