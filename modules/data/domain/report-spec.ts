// report-spec.ts — 平台自绘的**声明式规格**（spec §3⑥；计划 6）。
//
// 两条硬约束写在类型里，不写在提示词里：
//  ① **每一层 `.strict()`**：白名单外的键一律 400。理由与 routes/metrics.ts 那句同款——
//     `.strict()` 是「禁任意 SQL」的**机检落点**：用 zod 默认的 strip，调用方塞一个 `selectSql`
//     会**静默无效**（spec §3⑥ 实测过：没有白名单时，规格里多塞一个可执行字段被**照单接受**）。
//  ② **图型白名单是代码常量**（人裁 2026-09-30）：租户与 agent 只能选、不能扩；
//     加图型 = 改这个常量 + 加渲染分支 + 测试，**走 PR**。做成 env/DB 可配会让
//     「渲染器能力」与「平台代码」脱钩 ⇒ 库里加了图型而渲染器不认 = **静默空白**。
import { z } from 'zod'

export const CHART_TYPES = ['line', 'bar', 'table'] as const
export const MAX_PANELS = 24
export const MAX_DIMS = 4

const PanelSchema = z.object({
  chart: z.enum(CHART_TYPES),
  title: z.string().trim().min(1).max(120),
  metricId: z.string().min(1).max(128),                  // 语义 id；合法性由 runQuery 判（同源判据）
  dims: z.array(z.string().min(1).max(64)).max(MAX_DIMS).default([]),
  args: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),   // 等值过滤，与 /query 同形
  span: z.number().int().min(1).max(24).default(12),     // 24 栅格
}).strict()

export const ReportSpecSchema = z.object({ panels: z.array(PanelSchema).max(MAX_PANELS) }).strict()

export type ReportSpec = z.infer<typeof ReportSpecSchema>
export type SpecErrorCode = 'INVALID_SPEC' | 'UNKNOWN_CHART_TYPE' | 'SPEC_TOO_LARGE'

export function parseReportSpec(input: unknown): { ok: true; spec: ReportSpec } | { ok: false; code: SpecErrorCode } {
  // 体量闸先判（避免超大体量先被逐字段解析）
  const panels = (input as { panels?: unknown })?.panels
  if (Array.isArray(panels) && panels.length > MAX_PANELS) return { ok: false, code: 'SPEC_TOO_LARGE' }
  const parsed = ReportSpecSchema.safeParse(input)
  if (parsed.success) return { ok: true, spec: parsed.data }
  // 未知图型单独给码：前端要能说「这个图型平台还不支持」，而不是笼统的「规格不合法」
  const bad = parsed.error.issues.find((i) => i.path.at(-1) === 'chart')
  if (bad) return { ok: false, code: 'UNKNOWN_CHART_TYPE' }
  return { ok: false, code: 'INVALID_SPEC' }
}
