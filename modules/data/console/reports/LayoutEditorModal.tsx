// LayoutEditorModal.tsx — 24 栅格版式编辑器（issue #2295）。
//
// 能力边界（与设计文档一致）：
//  · 只改**顺序**与**宽度**（span 1..24），没有 x/y 坐标、没有重叠——版式仍是「模板 + 槽位」；
//  · 拖动换位只在**同页内**生效（跨页归属由规格的 page 字段决定，编辑器不搬页）；
//  · 触屏/键盘有等价按钮（上移/下移/变窄/变宽）——HTML5 DnD 在触屏上不可用，不能让功能只对鼠标开放。
//
// 组件不取数、不调接口：保存与失败提示由调用方负责（管理面 = 默认版式；观看面 = 个人版式）。
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Alert, Button, Col, Modal, Row, Segmented, Space, Tag, Tooltip, Typography } from 'antd'
import { clampSpan, type LayoutItem } from '../../domain/report-layout'

export interface LayoutEditorPanel {
  key: string
  title: string
  chart: string
  span: number
  page: number
}

interface Props {
  open: boolean
  panels: LayoutEditorPanel[]
  /** 页清单（多页报表才有；下标 0 = 第 1 页）。 */
  pageTitles?: Array<string | undefined>
  initialItems: LayoutItem[]
  applying?: boolean
  error?: string | null
  onCancel: () => void
  onSave: (items: LayoutItem[]) => void
  /** 恢复默认（观看面个人版式才有）。 */
  onReset?: () => void
}

const CHART_LABEL: Record<string, string> = {
  line: '折线', bar: '柱状', table: '表格', cross_table: '交叉表', waterfall: '瀑布',
  bullet: '目标对比', sparkline: '迷你趋势', kpi: 'KPI', text: '文本', ai_text: 'AI 文本',
}

/** 同页内把 `from` 移到 `to` 之前（下标是当前 items 顺序）。 */
function moveBefore(items: LayoutItem[], fromKey: string, toKey: string): LayoutItem[] {
  if (fromKey === toKey) return items
  const from = items.findIndex((i) => i.key === fromKey)
  const to = items.findIndex((i) => i.key === toKey)
  if (from < 0 || to < 0) return items
  const next = [...items]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

function moveBy(items: LayoutItem[], key: string, delta: number, pageOfKey: (k: string) => number): LayoutItem[] {
  const page = pageOfKey(key)
  const samePage = items.filter((i) => pageOfKey(i.key) === page)
  const at = samePage.findIndex((i) => i.key === key)
  const target = samePage[at + delta]
  if (target === undefined) return items
  return moveBefore(items, key, target.key)
}

export function LayoutEditorModal({
  open, panels, pageTitles, initialItems, applying = false, error = null,
  onCancel, onSave, onReset,
}: Props) {
  const [items, setItems] = useState<LayoutItem[]>(initialItems)
  const [page, setPage] = useState(1)
  const dragKey = useRef<string | null>(null)
  const gridRef = useRef<HTMLDivElement | null>(null)

  // 每次打开都用调用方给的最新版式重置（对话框不是受控容器，避免上一次的临时拖动残留）。
  useEffect(() => { if (open) { setItems(initialItems); setPage(1); dragKey.current = null } },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open])

  const byKey = useMemo(() => new Map(panels.map((p) => [p.key, p])), [panels])
  const pageOfKey = (k: string): number => byKey.get(k)?.page ?? 1
  const pageCount = pageTitles !== undefined && pageTitles.length > 0 ? pageTitles.length : 1
  const visible = items.filter((i) => pageOfKey(i.key) === page)

  const setSpan = (key: string, delta: number) => {
    setItems((cur) => cur.map((i) => (i.key === key ? { ...i, span: clampSpan(i.span + delta) } : i)))
  }

  /** 拖右侧把手改宽：按 24 栅格换算，吸附整数列。 */
  const startResize = (key: string, e: ReactPointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const width = gridRef.current?.getBoundingClientRect().width ?? 0
    if (width <= 0) return
    const col = width / 24
    const startX = e.clientX
    const startSpan = items.find((i) => i.key === key)?.span ?? 12
    const onMove = (ev: PointerEvent) => {
      const delta = Math.round((ev.clientX - startX) / col)
      setItems((cur) => cur.map((i) => (i.key === key ? { ...i, span: clampSpan(startSpan + delta) } : i)))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <Modal
      open={open}
      title="编辑版式"
      width={920}
      onCancel={onCancel}
      footer={(
        <Space>
          {error !== null && <Typography.Text type="danger">{error}</Typography.Text>}
          {onReset !== undefined && <Button onClick={onReset}>恢复默认</Button>}
          <Button onClick={onCancel}>取消</Button>
          <Button type="primary" loading={applying} onClick={() => onSave(items)}>保存</Button>
        </Space>
      )}
    >
      {pageCount > 1 && (
        <Segmented
          style={{ marginBottom: 12 }}
          value={page}
          onChange={(v) => setPage(v as number)}
          options={Array.from({ length: pageCount }, (_, i) => ({
            label: pageTitles?.[i] ?? `第 ${i + 1} 页`, value: i + 1,
          }))}
        />
      )}
      <div ref={gridRef} data-testid="layout-grid">
        <Row gutter={[12, 12]}>
          {visible.map((item) => {
            const panel = byKey.get(item.key)
            return (
              <Col key={item.key} span={item.span}>
                <div
                  data-testid={`layout-card-${item.key}`}
                  draggable
                  onDragStart={(e) => {
                    dragKey.current = item.key
                    e.dataTransfer.effectAllowed = 'move'
                    // 某些浏览器要求设置数据才会触发 drop
                    e.dataTransfer.setData('text/plain', item.key)
                  }}
                  onDragOver={(e) => { e.preventDefault() }}
                  onDrop={(e) => {
                    e.preventDefault()
                    const from = dragKey.current
                    dragKey.current = null
                    if (from === null) return
                    if (pageOfKey(from) !== pageOfKey(item.key)) return
                    setItems((cur) => moveBefore(cur, from, item.key))
                  }}
                  onDragEnd={() => { dragKey.current = null }}
                  style={{
                    position: 'relative', border: '1px solid #EBEDF0', borderRadius: 12,
                    background: '#FFFFFF', padding: '12px 16px', minHeight: 72,
                    cursor: 'grab', transition: 'border-color 150ms ease-out',
                  }}
                >
                  <Space size={6} style={{ marginBottom: 4 }}>
                    <span aria-hidden style={{ color: '#9AA0A6', fontSize: 14 }}>⠿</span>
                    <Typography.Text strong ellipsis style={{ maxWidth: 260 }}>
                      {panel?.title ?? '（未命名）'}
                    </Typography.Text>
                    <Tag variant="filled" style={{ marginInlineEnd: 0 }}>
                      {CHART_LABEL[panel?.chart ?? ''] ?? panel?.chart ?? ''}
                    </Tag>
                  </Space>
                  <div>
                    <Space size={4}>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        宽 {item.span}/24
                      </Typography.Text>
                      <Tooltip title="变窄">
                        <Button size="small" type="text" aria-label="变窄"
                          onClick={() => setSpan(item.key, -1)}>‹</Button>
                      </Tooltip>
                      <Tooltip title="变宽">
                        <Button size="small" type="text" aria-label="变宽"
                          onClick={() => setSpan(item.key, 1)}>›</Button>
                      </Tooltip>
                      <Tooltip title="前移">
                        <Button size="small" type="text" aria-label="前移"
                          onClick={() => setItems((cur) => moveBy(cur, item.key, -1, pageOfKey))}>↑</Button>
                      </Tooltip>
                      <Tooltip title="后移">
                        <Button size="small" type="text" aria-label="后移"
                          onClick={() => setItems((cur) => moveBy(cur, item.key, 1, pageOfKey))}>↓</Button>
                      </Tooltip>
                    </Space>
                  </div>
                  {/* 拖右侧改宽（鼠标）：触屏用上面的「变窄/变宽」按钮 */}
                  <div
                    aria-hidden
                    data-testid={`layout-resize-${item.key}`}
                    onPointerDown={(e) => startResize(item.key, e)}
                    style={{
                      position: 'absolute', top: 0, right: 0, width: 10, height: '100%',
                      cursor: 'col-resize', borderRadius: '0 12px 12px 0',
                    }}
                  />
                </div>
              </Col>
            )
          })}
        </Row>
        {visible.length === 0 && <Alert type="info" showIcon title="这一页没有面板" />}
      </div>
    </Modal>
  )
}
