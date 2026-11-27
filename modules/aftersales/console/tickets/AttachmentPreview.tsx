// AttachmentPreview.tsx — 单工单附件预览（图片/视频 + 上一个/下一个 + 键盘）。
//
// 2026-11-27（省对象存储下行 / 加载速度）：
//   · 只有本弹窗打开时才加载**当前这一张**附件；列表/处理/详情弹窗不再放 `<img>` 缩略图。
//   · 图片取 Blob → object URL 缓存（按 attachment id），同一附件会话内只真正下载一次；
//   · 视频只缓存预签名 URL，用 `preload="metadata"` 流式播放，不整段下载。
import { useEffect, useState } from 'react'
import { Alert, Button, Modal, Space, Spin, Typography } from 'antd'
import type { TicketAttachment } from '../../api-types'
import { ApiError, messageOf } from '../lib/api'
import { imageObjectUrl, refreshUrl, videoUrl } from './lib/attachment-cache'

function errText(e: unknown): string {
  if (e instanceof ApiError) return messageOf(e)
  if (e instanceof Error) return e.message
  return '附件加载失败'
}

export function AttachmentPreview(props: {
  items: TicketAttachment[]
  index: number
  open: boolean
  onClose: () => void
}) {
  const [current, setCurrent] = useState(props.index)
  const [src, setSrc] = useState<string | null>(null)
  const [kind, setKind] = useState<'image' | 'video' | 'link'>('image')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [videoRetried, setVideoRetried] = useState(false)

  const total = props.items.length

  useEffect(() => {
    if (props.open) {
      setCurrent(Math.min(Math.max(props.index, 0), Math.max(props.items.length - 1, 0)))
      setAttempt(0)
      setVideoRetried(false)
    }
  }, [props.open, props.index, props.items.length])

  // 每次切到当前附件才加载；缓存命中时 imageObjectUrl/videoUrl 不发网络请求。
  useEffect(() => {
    if (!props.open) return
    const item = props.items[current]
    setSrc(null)
    setError(null)
    setVideoRetried(false)
    if (!item) { setLoading(false); return }

    let alive = true
    setLoading(true)
    const type = item.contentType
    if (type.startsWith('image/')) {
      setKind('image')
      imageObjectUrl(item)
        .then((url) => { if (alive) setSrc(url) })
        .catch((e: unknown) => { if (alive) setError(errText(e)) })
        .finally(() => { if (alive) setLoading(false) })
    } else if (type.startsWith('video/')) {
      setKind('video')
      videoUrl(item)
        .then((url) => { if (alive) setSrc(url) })
        .catch((e: unknown) => { if (alive) setError(errText(e)) })
        .finally(() => { if (alive) setLoading(false) })
    } else {
      setKind('link')
      setSrc(item.url)
      setLoading(false)
    }
    return () => { alive = false }
  }, [props.open, current, props.items, attempt])

  const go = (delta: number): void => {
    if (total === 0) return
    setCurrent((v) => (v + delta + total) % total)
  }

  useEffect(() => {
    if (!props.open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowLeft') setCurrent((v) => (total === 0 ? 0 : (v - 1 + total) % total))
      else if (e.key === 'ArrowRight') setCurrent((v) => (total === 0 ? 0 : (v + 1) % total))
      else if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.open, props.onClose, total])

  const item = props.items[current]

  const onVideoError = (): void => {
    if (!item) return
    if (videoRetried) { setError('视频加载失败，请重试'); return }
    setVideoRetried(true)
    // URL 可能过期（预签名 10 分钟）：换一个再试，不重新下载整段。
    refreshUrl(item.id)
      .then((url) => setSrc(url))
      .catch((e: unknown) => setError(errText(e)))
  }

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
          {error ? (
            <Alert
              type="error"
              showIcon
              title={error}
              action={<Button size="small" onClick={() => setAttempt((a) => a + 1)}>重试</Button>}
            />
          ) : loading ? (
            <Spin />
          ) : kind === 'video' && src ? (
            <video
              src={src}
              controls
              preload="metadata"
              onError={onVideoError}
              style={{ maxWidth: '100%', maxHeight: '65vh' }}
            />
          ) : kind === 'image' && src ? (
            <img src={src} alt={`附件 ${current + 1}`} style={{ maxWidth: '100%', maxHeight: '65vh', objectFit: 'contain' }} />
          ) : kind === 'link' && src ? (
            <Typography.Text>
              <a href={src} target="_blank" rel="noreferrer">下载附件 {current + 1}</a>
            </Typography.Text>
          ) : (
            <Alert type="warning" showIcon title="附件存储配置解析失败，暂时无法预览" />
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
