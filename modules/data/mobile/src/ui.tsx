// ui.tsx — 移动数据 App 的视觉基线（tokens + 线性图标 + 通用容器手）。
//
// 方向：Operate（业务工具）。冷灰底 + 纯白面 + 墨黑字 + 单一墨绿强调色；
// 卡片只靠 1px 边与留白分层，不用阴影/渐变；图标统一 1.7px 描边，不用 emoji。
import type { ReactNode } from 'react'

export const C = {
  bg: '#F3F5F7',
  surface: '#FFFFFF',
  ink: '#111827',
  sub: '#6B7280',
  mute: '#9CA3AF',
  line: '#E5E7EB',
  lineSoft: '#F1F3F5',
  accent: '#0F766E',
  accentDeep: '#0B5C55',
  accentSoft: '#E7F3F1',
  danger: '#B42318',
  warning: '#B54708',
  success: '#067647',
  warningSoft: '#FEF3E7',
  successSoft: '#E9F6EF',
  dangerSoft: '#FDECEA',
} as const

export const radius = { card: 16, field: 12, chip: 999 } as const

export const cardStyle = {
  background: C.surface,
  border: `1px solid ${C.line}`,
  borderRadius: radius.card,
} as const

export const pressable = {
  WebkitTapHighlightColor: 'transparent',
  transition: 'background-color 140ms ease',
} as const

/** 3 个 tab + 通用动作的线性图标（统一 1.7 描边、圆角端点）。 */
export function Icon({ name, size = 20, color = 'currentColor' }: {
  name: 'reports' | 'metrics' | 'ask' | 'search' | 'chevron' | 'source' | 'file'
  size?: number
  color?: string
}) {
  const common = {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: color, strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  }
  switch (name) {
    case 'reports':
      return <svg {...common} aria-hidden><rect x="4.5" y="3.5" width="15" height="17" rx="2.5" /><path d="M8 8h8M8 12h8M8 16h5" /></svg>
    case 'metrics':
      return <svg {...common} aria-hidden><rect x="4" y="4" width="6.5" height="6.5" rx="1.4" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.4" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.4" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.4" /></svg>
    case 'ask':
      return <svg {...common} aria-hidden><path d="M20 11.5a7.5 7.5 0 0 1-10.7 6.8L4.5 19.5l1.2-4A7.5 7.5 0 1 1 20 11.5Z" /><path d="M8.5 11.5h7M8.5 8.5h4.5" /></svg>
    case 'search':
      return <svg {...common} aria-hidden><circle cx="11" cy="11" r="6.5" /><path d="m16 16 3.5 3.5" /></svg>
    case 'chevron':
      return <svg {...common} aria-hidden><path d="m9 5 7 7-7 7" /></svg>
    case 'source':
      return <svg {...common} aria-hidden><path d="M10 13.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.5 3.5 0 0 0-5-5L11 7.5" /><path d="M14 10.5a3.5 3.5 0 0 0-5 0L6.5 13a3.5 3.5 0 0 0 5 5L13 16.5" /></svg>
    case 'file':
      return <svg {...common} aria-hidden><path d="M6 3.5h8l4 4v13H6z" /><path d="M14 3.5v4h4M9 12h6M9 16h6" /></svg>
  }
}

/** 小状态片：只做 1 行字，颜色从语义 token 来。 */
export function Chip({ children, tone = 'neutral' }: {
  children: ReactNode
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
}) {
  const map = {
    neutral: { bg: C.lineSoft, fg: C.sub },
    accent: { bg: C.accentSoft, fg: C.accentDeep },
    success: { bg: C.successSoft, fg: C.success },
    warning: { bg: C.warningSoft, fg: C.warning },
    danger: { bg: C.dangerSoft, fg: C.danger },
  } as const
  const t = map[tone]
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', height: 22, padding: '0 8px',
      borderRadius: radius.chip, background: t.bg, color: t.fg,
      fontSize: 11, fontWeight: 500, whiteSpace: 'nowrap',
    }}>{children}</span>
  )
}

/** 空态：图标 + 一句主句 + 一句解释，居中但不占满整屏。 */
export function EmptyState({ icon, title, hint }: {
  icon: 'file' | 'search' | 'reports' | 'metrics'
  title: string
  hint?: string
}) {
  return (
    <div style={{ textAlign: 'center', padding: '56px 24px', color: C.mute }}>
      <div style={{
        width: 56, height: 56, margin: '0 auto 14px', borderRadius: 18,
        background: C.surface, border: `1px solid ${C.line}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.mute,
      }}>
        <Icon name={icon} size={24} />
      </div>
      <div style={{ fontSize: 14, color: C.sub, fontWeight: 500 }}>{title}</div>
      {hint !== undefined && <div style={{ fontSize: 12, color: C.mute, marginTop: 6, lineHeight: 1.7 }}>{hint}</div>}
    </div>
  )
}
