// ExportDialog.tsx — 导出字段勾选 + 是否含附件 + 进度。2026-11-26 / #2884，spec §3.8。
//
// 字段默认全选并记住上次选择（localStorage）；「含附件」默认不勾——多数导出只要表格。
import { useEffect, useState } from 'react'
import { Alert, Checkbox, Modal, Space, Typography } from 'antd'
import { EXPORT_FIELDS } from '../../export-fields'
import { ExportError, runExport } from './lib/export'
import type { ExportPhase, ExportProgress, ExportRange } from './lib/export'
import type { TicketFilters } from './lib/query'

const LS_KEY = 'aftersales.tickets.exportColumns'
const ALL_KEYS = EXPORT_FIELDS.map((f) => f.key)

function readColumns(): string[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        const valid = parsed.filter((k): k is string => typeof k === 'string' && ALL_KEYS.includes(k))
        if (valid.length > 0) return valid
      }
    }
  } catch {
    // 损坏的就当作没存过——导出字段是可重建的用户偏好，不值得让页面崩。
  }
  return [...ALL_KEYS]
}

function progressText(p: ExportProgress | null): string {
  if (!p) return ''
  const phase: Record<ExportPhase, string> = {
    excel: '生成 Excel…',
    manifest: '读取附件清单…',
    attachments: `下载附件 ${p.done ?? 0}/${p.total ?? 0}…`,
    zip: '打包…',
  }
  return phase[p.phase]
}

export function ExportDialog(props: {
  open: boolean
  range: ExportRange
  ids: number[]
  filters: TicketFilters
  onClose: () => void
}) {
  const [columns, setColumns] = useState<string[]>(readColumns)
  const [includeAttachments, setIncludeAttachments] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  useEffect(() => {
    if (!props.open) return
    setColumns(readColumns())
    setIncludeAttachments(false)
    setBusy(false)
    setProgress(null)
    setError(null)
    setDone(null)
  }, [props.open])

  const setAndPersist = (next: string[]): void => {
    setColumns(next)
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(next))
    } catch {
      // 隐私模式禁用 localStorage 时只是不记住，不影响本次导出。
    }
  }

  const rangeText = props.range === 'selected'
    ? `选中 ${props.ids.length} 条`
    : props.range === 'filtered' ? '当前筛选结果' : '全部工单'

  const start = async (): Promise<void> => {
    if (columns.length === 0) return
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const name = await runExport({
        range: props.range,
        ids: props.ids,
        filters: props.filters,
        columns,
        includeAttachments,
        onProgress: setProgress,
      })
      setDone(name)
    } catch (e: unknown) {
      setError(e instanceof ExportError ? e.message : '导出失败，请重试')
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  return (
    <Modal
      open={props.open}
      title="导出工单"
      width={640}
      okText="导出"
      cancelText="取消"
      confirmLoading={busy}
      okButtonProps={{ disabled: busy || columns.length === 0 }}
      onOk={() => void start()}
      onCancel={props.onClose}
      destroyOnHidden
    >
      <Space orientation="vertical" size={12} style={{ width: '100%' }}>
        <Typography.Text type="secondary">范围：{rangeText}</Typography.Text>

        <div>
          <Typography.Text strong>字段</Typography.Text>
          <div style={{ marginTop: 8 }}>
            <Checkbox
              checked={columns.length === ALL_KEYS.length}
              indeterminate={columns.length > 0 && columns.length < ALL_KEYS.length}
              onChange={(e) => setAndPersist(e.target.checked ? [...ALL_KEYS] : [])}
            >
              全选
            </Checkbox>
          </div>
          <Checkbox.Group
            value={columns}
            onChange={(v) => setAndPersist(v.map(String))}
            style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6, marginTop: 8 }}
            options={EXPORT_FIELDS.map((f) => ({ label: f.header, value: f.key }))}
          />
        </div>

        <Checkbox
          checked={includeAttachments}
          onChange={(e) => setIncludeAttachments(e.target.checked)}
        >
          包含附件（打包为 zip；附件直接走对象存储，不经应用服务器）
        </Checkbox>

        {progress ? <Alert type="info" showIcon title={progressText(progress)} /> : null}
        {error ? <Alert type="error" showIcon title={error} /> : null}
        {done ? <Alert type="success" showIcon title={`已导出：${done}`} /> : null}
      </Space>
    </Modal>
  )
}
