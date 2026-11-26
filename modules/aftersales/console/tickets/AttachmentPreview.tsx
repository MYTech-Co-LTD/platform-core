// AttachmentPreview.tsx — 单工单附件预览（图片/视频 + 上一个/下一个 + 键盘）。spec §3.7。
import { useEffect, useState } from 'react'
import { Alert, Button, Modal, Space, Typography } from 'antd'
import type { TicketAttachment } from '../../api-types'

export function AttachmentPreview(props: {
  items: TicketAttachment[]
  index: number
  open: boolean
  onClose: () => void
}) {
  const [current, setCurrent] = useState(props.index)

  useEffect(() => {
    if (props.open) setCurrent(Math.min(Math.max(props.index, 0), Math.max(props.items.length - 1, 0)))
  }, [props.open, props.index, props.items])

  const go = (delta: number): void => {
    if (props.items.length === 0) return
    setCurrent((v) => (v + delta + props.items.length) % props.items.length)
  }

  useEffect(() => {
    if (!props.open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowLeft') go(-1)
      else if (e.key === 'ArrowRight') go(1)
      else if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const item = props.items[current]
  const total = props.items.length

  return (
    <Modal
      open={props.open}
      title={total > 0 ? `第 ${current + 1} / ${total} 个` : '附件预览'}
      footer={null}
      width={800}
      onCancel={props.onClose}
      destroyOnHidden
    >
      {!item ? <Alert type="warning" showIcon title="没有可预览的附件" /> : (
        <Space orientation="vertical" size={12} style={{ width: '100%', alignItems: 'center' }}>
          {item.url === null ? (
            <Alert type="warning" showIcon title="附件存储配置解析失败，暂时无法预览" />
          ) : item.contentType.startsWith('video/') ? (
            <video src={item.url} controls style={{ maxWidth: '100%', maxHeight: '65vh' }} />
          ) : item.contentType.startsWith('image/') ? (
            <img src={item.url} alt={`附件 ${current + 1}`} style={{ maxWidth: '100%', maxHeight: '65vh', objectFit: 'contain' }} />
          ) : (
            <Typography.Text>
              <a href={item.url} target="_blank" rel="noreferrer">下载附件 {current + 1}</a>
            </Typography.Text>
          )}
          <Space>
            <Button disabled={total <= 1} onClick={() => go(-1)}>上一个</Button>
            <Button disabled={total <= 1} onClick={() => go(1)}>下一个</Button>
          </Space>
        </Space>
      )}
    </Modal>
  )
}
