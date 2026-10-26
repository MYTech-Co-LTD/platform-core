// report-narrative-store.ts — AI 文本（`ai_text`）的**内容寻址缓存 + 审计**读写层。
//
// 表 `data.report_narratives` 见迁移 023：唯一键就是缓存键，`factsHash` 进键 ⇒ 数据一变
// （事实包内容变）自然失效，**不需要失效逻辑**。同一份事实只生成一次；命中即不调模型
// （计划 2026-10-26 Task 6；设计 spec §7）。
//
// 三条读纪律：
//  ① 每个读写都带 `org`——隔离键是 org（text，值 = 租户 Casdoor org），漏一处就是跨租户串数据；
//  ② 写侧 `on conflict do nothing`：并发下同一 key 必有一个撞唯一键，这是去重闸而不是错误；
//  ③ 表名/列名与 SQL 一一对应，改任一侧都要同步另一侧（迁移头部同样写了这句）。
//
// `NarrativeKey` 定义在这里、`narrativeKeyOf` 在 `narrative.ts`：后者依赖
// `NARRATIVE_PROMPT_VERSION` / `NarrativeDeps`，放这里会形成 store ↔ narrative 循环依赖。
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'

export interface NarrativeKey {
  org: string
  reportId: string
  specKey: string
  panelIndex: number
  focus: string
  /** `YYYY-MM-DD..YYYY-MM-DD`。 */
  periodKey: string
  /** 门店号 / `*`（无门店筛选）。 */
  branchKey: string
  /** 事实包规范化 JSON 的 sha256。 */
  factsHash: string
  /** `narrative-v1`；改提示词 = 升版本号（旧缓存自然不再命中）。 */
  promptVersion: string
  /** 模型标识；未配模型时写 `none`（模板结果同样被缓存）。 */
  model: string
}

export interface CachedNarrative {
  text: string
  fallback: boolean
  /** ISO 串（`created_at` 是 timestamptz，pg 回 Date ⇒ 统一成 ISO）。 */
  createdAt: string
}

/** 命中返回行；未命中返回 null（不是抛错——缓存未命中是常态）。 */
export async function getCachedNarrative(
  pool: Pool,
  k: NarrativeKey,
): Promise<CachedNarrative | null> {
  const r = await pool.query(
    `select text, fallback, created_at from data.report_narratives
      where org=$1 and report_id=$2 and spec_key=$3 and panel_index=$4 and focus=$5
        and period_key=$6 and branch_key=$7 and facts_hash=$8 and prompt_version=$9 and model=$10`,
    [k.org, k.reportId, k.specKey, k.panelIndex, k.focus,
      k.periodKey, k.branchKey, k.factsHash, k.promptVersion, k.model],
  )
  if (r.rowCount === 0) return null
  const row = r.rows[0]
  return {
    text: String(row.text),
    // 列是 boolean not null default false；收严到真值比较，避免驱动/替身给出非布尔值时误判
    fallback: row.fallback === true,
    createdAt: new Date(row.created_at as string | Date).toISOString(),
  }
}

/** 写一行审计/缓存。撞唯一键（并发同 key）静默忽略：先到者的文本就是结果。 */
export async function putNarrative(
  pool: Pool,
  k: NarrativeKey,
  text: string,
  fallback: boolean,
  createdBy: string,
): Promise<void> {
  await pool.query(
    `insert into data.report_narratives
       (id, org, report_id, spec_key, panel_index, focus, period_key, branch_key, facts_hash, prompt_version, model, text, fallback, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     on conflict (org, report_id, spec_key, panel_index, focus, period_key, branch_key, facts_hash, prompt_version, model) do nothing`,
    [randomUUID(), k.org, k.reportId, k.specKey, k.panelIndex, k.focus,
      k.periodKey, k.branchKey, k.factsHash, k.promptVersion, k.model,
      text, fallback, createdBy],
  )
}
