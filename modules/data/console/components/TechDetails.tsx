// components/TechDetails.tsx — 「技术细节」折叠层（单页双层设计的专业读法）。
//
// 设计约束（2026-11-12 与用户定案）：**不做按角色的多页面**，同一页两层——
//   ① 默认层：人话结论 + 一个主动作（工程词一律不出现）；
//   ② 展开层：专家要的**全量**细节（SQL / 口径 / 血缘 / 证据 / 错误码 / 置信度）。
//
// 三条纪律：
//   · 专业信息**不隐藏，只折叠**——展开必须是全量，不许做「简化版」；
//   · 用原生 `<details>`（无状态、可被测试直接断言、不依赖 antd 折叠动画）；
//   · 术语解释统一走本组件 + `lib/explain.ts` 的映射表，各页不各写一套。
import type { ReactNode } from 'react'

export function TechDetails({
  children,
  title = '技术细节',
  style,
}: {
  children: ReactNode
  title?: string
  style?: React.CSSProperties
}) {
  return (
    <details style={{ marginTop: 8, ...style }}>
      <summary style={{ cursor: 'pointer', fontSize: 12, color: '#6B7280', userSelect: 'none' }}>
        {title}
      </summary>
      <div style={{ marginTop: 6, fontSize: 12, color: '#4B5563', lineHeight: 1.7 }}>
        {children}
      </div>
    </details>
  )
}
