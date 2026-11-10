// guide.ts —— data_agent_guide / data_harness_catalog（spec §5 前两行）。
// guide 文案是三通道同源的正典落点（Wave 2 的 A SYSTEM_PROMPT 与 C SKILL.md 从这里取）；
// Wave 1 只接 B 通道。今天日期由 deps.now 注入（Asia/Shanghai 日历日）——测试不必改时钟。
import { ANALYST_TOOLS, type ToolImpl } from './registry'
import { guideInvariants, renderSkill } from '../../skill/render'

/**
 * 通道中性硬约束（Wave 2 决策 D-G1）：三通道同源内容的事实源。
 * B = content/mcp.md 渲染（GUIDE_TEXT_BUILDER）；A = agent-loop SYSTEM_PROMPT 编译期 import；
 * C 由构建期渲染器从同一正典生成（scripts/gen-openclaw-skill.mjs），契约测试钉住。措辞必须通道中性：不出现任何通道
 * 专属工具名；通道特有机制（A 的 freshness_line 附行、C 的 📅 传输层自动附加）留各通道本地
 * 文案，不进这里。
 *
 * ⚠️ 加载期只对 content/shared.md 做 eager fail-fast：这四行是安全关键约束，构建产物缺
 * shared.md 时必须起不来，而不是静默退化成三行/零行。content/mcp.md 是调用期读取
 * （renderSkill），缺失时由 guideImpl 的 try/catch 转成工具级 guide_unavailable。
 */
export const GUIDE_INVARIANTS: readonly string[] = guideInvariants()

/** B 通道指南：content/mcp.md 渲染（日期由调用方注入）。 */
export const GUIDE_TEXT_BUILDER = (today: string): string => renderSkill('mcp', { today })

const shanghaiToday = (now: () => Date): string => {
  // 与 query-service 的日期格式化同一口径（en-CA = YYYY-MM-DD）
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now())
}

export const guideImpl: ToolImpl = async (deps) => {
  try {
    const today = shanghaiToday(deps.now ?? (() => new Date()))
    return {
      payload: { status: 'ok', today, workflow: GUIDE_TEXT_BUILDER(today) },
      isError: false,
      auditRowCount: null,
    }
  } catch (err) {
    return {
      payload: {
        status: 'error',
        reason: 'guide_unavailable',
        detail: err instanceof Error ? err.message : String(err),
      },
      isError: true,
      auditRowCount: null,
    }
  }
}

export const harnessCatalogImpl: ToolImpl = async () => ({
  payload: {
    status: 'ok',
    tools: ANALYST_TOOLS.map((t) => ({
      name: t.name, group: t.group, title: t.title, description: t.description,
      requiredScope: t.requiredScope, mutating: t.mutating, annotations: t.annotations,
    })),
  },
  isError: false,
  auditRowCount: null,
})
