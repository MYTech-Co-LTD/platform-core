// guide.ts —— data_agent_guide / data_harness_catalog（spec §5 前两行）。
// guide 文案是三通道同源的正典落点（Wave 2 的 A SYSTEM_PROMPT 与 C SKILL.md 从这里取）；
// Wave 1 只接 B 通道。今天日期由 deps.now 注入（Asia/Shanghai 日历日）——测试不必改时钟。
import { ANALYST_TOOLS, type ToolImpl } from './registry'

/**
 * 通道中性硬约束（Wave 2 决策 D-G1）：三通道同源内容的事实源。
 * B = 本文件 GUIDE_TEXT_BUILDER 内嵌；A = agent-loop SYSTEM_PROMPT 编译期 import；
 * C = SKILL.md 逐字入文 + scripts/check-guide-sync.mjs 机检（C 消费静态 md，无法 import TS
 * ⇒ 机检钉同源）。措辞必须通道中性：不出现任何通道专属工具名；通道特有机制（A 的
 * freshness_line 附行、C 的 📅 传输层自动附加）留各通道本地文案，不进这里。
 */
export const GUIDE_INVARIANTS: readonly string[] = [
  '· 主体（org/租户/数据主体）由平台按身份钉死：不要索要、不要猜测，参数里出现即被拒；',
  '· 行上限 1000，truncated=true 说明被截断：不得把截断集当全量下结论，也不得对截断集自行求和；',
  '· 合计以回包的 total 字段为准：字段在场就直接引用，不要自己把行加总；切片/截断产生的部分合计不是全局合计；',
  '· 数据截止与新鲜度必须如实呈现：回包没有相应字段或正典行 = 新鲜度未知，如实说明，不要编；',
]

/** 硬约束（与授权核心口径逐字对齐：主体钉死 / 1000 行 / 新鲜度脚注 / total 语义）。 */
export const GUIDE_TEXT_BUILDER = (today: string): string => [
  `今天是 ${today}（Asia/Shanghai）。`,
  '工作流七步：',
  '1. 先读本指南（本工具）；',
  '2. data_harness_catalog 看有哪些工具；',
  '3. search_catalog 找指标；describe_metric 拿口径/参数/维度（查数前必做）；',
  '4. sample_dimension_values 确认过滤值的确切写法（如门店名）；',
  '5. preview_query 核对将执行的 SQL；',
  '6. query_metric 取数——回包是信任信封：口径版本/数据截止/审计 id 都在里面，照实转述；',
  '7. get_freshness/get_quality/get_lineage 回答「数据新不新/可不可信/从哪来」。',
  '硬约束：',
  ...GUIDE_INVARIANTS,
].join('\n')

const shanghaiToday = (now: () => Date): string => {
  // 与 query-service 的日期格式化同一口径（en-CA = YYYY-MM-DD）
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now())
}

export const guideImpl: ToolImpl = async (deps) => {
  const today = shanghaiToday(deps.now ?? (() => new Date()))
  return {
    payload: { status: 'ok', today, workflow: GUIDE_TEXT_BUILDER(today) },
    isError: false,
    auditRowCount: null,
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
