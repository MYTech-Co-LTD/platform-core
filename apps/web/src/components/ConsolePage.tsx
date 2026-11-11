// ConsolePage.tsx — 管理台的统一页面头（#1953）：标题 + 说明 + 右侧主操作，内容另起卡片。
//
// 为什么统一到这里：管理页此前各写各的（多数把标题塞进 Card title，Keys 页却用 Typography.Title），
// 首页与二级页的标题字号/间距/操作位置各不相同，切页时“像换了个人做的”。
// 本组件只提供**版式**，不接管权限（门禁在 App.tsx 的 AdminGate 与宿主 manifest）。
import type { ReactNode } from 'react'
import { Space, Typography } from 'antd'

export interface ConsolePageProps {
  title: string
  /** 一句话说明「这页能干什么」；缺省不占位。 */
  description?: ReactNode
  /** 右上主操作（按钮组；与标题同基线）。 */
  extra?: ReactNode
  children: ReactNode
}

export function ConsolePage({ title, description, extra, children }: ConsolePageProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {title}
          </Typography.Title>
          {description !== undefined && (
            <Typography.Text type="secondary" style={{ display: 'block', marginTop: 4 }}>
              {description}
            </Typography.Text>
          )}
        </div>
        {extra !== undefined && <Space wrap>{extra}</Space>}
      </div>
      {children}
    </div>
  )
}
