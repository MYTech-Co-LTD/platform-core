// console/lib/ui.tsx — 模块 console 的共享视觉原语（对齐 DESIGN.md / console-ui-conventions）。
//
// 为什么在模块内而不是 import 宿主：模块 console 由 web 构建打包，但模块代码不 import
// `apps/web`（与宿主组件保持同构即可，避免跨层依赖）。宿主管理页（Users/Keys/Integrations）
// 用的就是同一形状：6px 圆点 + 文字。
import type { ReactNode } from 'react'
import { Card } from 'antd'

/** 语义色（DESIGN.md Color·语义）：状态用圆点+文字，不用大面积色块。 */
export const TONE = {
  ok: '#0FA958',
  warn: '#E08A00',
  danger: '#E5484D',
  muted: '#C9CDD4',
} as const
export type Tone = keyof typeof TONE

/** 状态：圆点 + 文字（替代 antd Tag 色块）。 */
export function Status({ tone, children }: { tone: Tone, children: ReactNode }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <i style={{ width: 6, height: 6, borderRadius: '50%', display: 'inline-block', background: TONE[tone] }} />
      {children}
    </span>
  )
}

/**
 * 列表页外壳（console-ui §3：一律 Card 包 Table）。无 title——页头由宿主按 manifest 渲染，
 * 卡片里再画标题就是「像两个人做的」。
 */
export function ListCard({ children }: { children: ReactNode }) {
  return <Card>{children}</Card>
}
