// tickets/index.tsx — 售后工单列表（2026-11-26 对齐无极重写，#2884）。
//
// 页面编排：筛选/分页/勾选状态、数据加载、弹窗开关。展示拆在 FilterBar / SearchBar /
// TicketTable / ProcessDialog / DetailDialog / AttachmentPreview / ExportDialog（spec §3.1）。
//
// **服务端真分页与真计数**：列表用响应里的 `total` 驱动分页，计数来自 `/tickets/counts`——
// 不在前端全量拉取再数（§0.3「迁移即重构」）。
import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Dropdown, Modal, Space, Typography, message } from 'antd'
import type { MenuProps } from 'antd'
import { useOutletContext } from 'react-router-dom'
import type {
  BatchDeleteResult, Paged, ProcessResult, TicketAttachment, TicketCounts, TicketDetail, TicketListItem,
} from '../../api-types'
import { apiGet, apiSend, messageOf } from '../lib/api'
import { formatMinor } from '../lib/format'
import { ListCard } from '../lib/ui'
import { FilterBar } from './FilterBar'
import { SearchBar } from './SearchBar'
import { TicketTable } from './TicketTable'
import { ProcessDialog } from './ProcessDialog'
import { DetailDialog } from './DetailDialog'
import { AttachmentPreview } from './AttachmentPreview'
import { ExportDialog } from './ExportDialog'
import { EMPTY_FILTERS, ticketQuery } from './lib/query'
import type { TicketFilters } from './lib/query'
import type { ExportRange } from './lib/export'

const SIZE_KEY = 'aftersales.tickets.pageSize'
const SIZES = [20, 50, 100]

function readSize(): number {
  try {
    const n = Number(localStorage.getItem(SIZE_KEY))
    return SIZES.includes(n) ? n : 20
  } catch {
    return 20
  }
}

export default function TicketsPage() {
  /** 删除按钮按权限显隐：门卫在服务端兜底，这里只是不做无效展示。 */
  const outlet = useOutletContext<{ session?: { scopes?: string[] } } | null>()
  const canDelete = (outlet?.session?.scopes ?? []).includes('aftersales:delete')

  const [filters, setFilters] = useState<TicketFilters>(EMPTY_FILTERS)
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(readSize)
  const [items, setItems] = useState<TicketListItem[]>([])
  const [total, setTotal] = useState(0)
  const [counts, setCounts] = useState<TicketCounts | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<number[]>([])

  const [processing, setProcessing] = useState<number | null>(null)
  const [detail, setDetail] = useState<number | null>(null)
  const [preview, setPreview] = useState<{ items: TicketAttachment[]; index: number } | null>(null)
  const [exportFor, setExportFor] = useState<ExportRange | null>(null)

  const [messageApi, contextHolder] = message.useMessage()

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const body = await apiGet<Paged<TicketListItem>>(`/tickets?${ticketQuery(filters, page, size)}`)
      setItems(body.items)
      setTotal(body.total)
    } catch (e: unknown) {
      setItems([])
      setTotal(0)
      setError(messageOf(e))
    } finally {
      setLoading(false)
    }
  }, [filters, page, size])

  // 层级：状态 → 搜索/时间 → 等级 → 品牌（最末级）。
  // 计数串排除 brand、保留 level ⇒ 点品牌只刷新列表；点等级/搜索/状态/时间会重拉计数。
  const countsQuery = ticketQuery({ ...filters, brand: '' })
  const loadCounts = useCallback(async () => {
    try {
      setCounts(await apiGet<TicketCounts>(`/tickets/counts${countsQuery ? `?${countsQuery}` : ''}`))
    } catch {
      // 计数失败不阻断列表：胶囊上的数字可以暂时保留旧值（比整页报错更有用）。
    }
  }, [countsQuery])

  useEffect(() => { void load() }, [load])
  useEffect(() => { void loadCounts() }, [loadCounts])

  /** 任何条件变化：回第 1 页 + 清空勾选（勾选只对当前页有意义）。 */
  const apply = (next: TicketFilters): void => {
    setFilters(next)
    setPage(1)
    setSelected([])
  }

  const onPageChange = (p: number, s: number): void => {
    if (s !== size) {
      setSize(s)
      try {
        localStorage.setItem(SIZE_KEY, String(s))
      } catch {
        // 隐私模式下只是不记住。
      }
    }
    setPage(p)
    setSelected([])
  }

  const onProcessed = (r: ProcessResult): void => {
    setProcessing(null)
    messageApi.success(r.status === 'cancelled' ? '已驳回' : `已处理，赔付 ${formatMinor(r.amountMinor)}`)
    void load()
    void loadCounts()
  }

  const onPreviewRow = async (row: TicketListItem): Promise<void> => {
    try {
      const d = await apiGet<TicketDetail>(`/tickets/${row.id}`)
      setPreview({ items: d.attachments, index: 0 })
    } catch (e: unknown) {
      messageApi.error(messageOf(e))
    }
  }

  const doDelete = (): void => {
    if (selected.length === 0) return
    const picked = items.filter((i) => selected.includes(i.id))
    const byStatus = { pending: 0, completed: 0, cancelled: 0 }
    for (const r of picked) byStatus[r.status]++
    const attachments = picked.reduce((n, r) => n + (r.image_count ?? 0) + (r.video_count ?? 0), 0)

    Modal.confirm({
      title: `删除 ${selected.length} 条工单？`,
      content: `待处理 ${byStatus.pending} 条、已处理 ${byStatus.completed} 条、已驳回 ${byStatus.cancelled} 条；附件共 ${attachments} 个。工单与附件会一并删除，不可恢复。`,
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const res = await apiSend<BatchDeleteResult>('/tickets/batch-delete', 'POST', { ids: selected })
          if (res.failed.length > 0) {
            Modal.warning({
              title: '部分工单未删除',
              content: res.failed.map((f) => `${f.code || `#${f.id}`}：${f.error}`).join('；'),
            })
          }
          messageApi.success(`已删除 ${res.deleted.length} 条`)
          setSelected([])
          void load()
          void loadCounts()
        } catch (e: unknown) {
          messageApi.error(messageOf(e))
        }
      },
    })
  }

  const exportMenu: MenuProps['items'] = [
    { key: 'selected', label: `选中（${selected.length}）`, disabled: selected.length === 0 },
    { key: 'filtered', label: '筛选结果' },
    { key: 'all', label: '全部' },
  ]

  return (
    <ListCard>
      {contextHolder}
      <FilterBar
        status={filters.status}
        level={filters.level}
        brand={filters.brand}
        counts={counts}
        onStatus={(v) => apply({ ...filters, status: v })}
        onLevel={(v) => apply({ ...filters, level: v })}
        onBrand={(v) => apply({ ...filters, brand: v })}
      />
      <SearchBar
        filters={filters}
        onSearch={apply}
        onReset={() => apply({ ...EMPTY_FILTERS })}
      />

      {error ? <Alert type="error" showIcon title={error} style={{ marginBottom: 12 }} /> : null}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <Typography.Text type="secondary">已选择 {selected.length} 项</Typography.Text>
        <Space>
          <Dropdown
            menu={{ items: exportMenu, onClick: ({ key }) => setExportFor(key as ExportRange) }}
            trigger={['click']}
          >
            <Button>导出</Button>
          </Dropdown>
          {canDelete ? (
            <Button danger disabled={selected.length === 0} onClick={doDelete}>删除</Button>
          ) : null}
        </Space>
      </div>

      <TicketTable
        items={items}
        total={total}
        page={page}
        size={size}
        loading={loading}
        selected={selected}
        onSelectedChange={setSelected}
        onPageChange={onPageChange}
        onProcess={setProcessing}
        onDetail={setDetail}
        onPreview={(row) => void onPreviewRow(row)}
      />

      {processing !== null ? (
        <ProcessDialog
          ticketId={processing}
          open
          onClose={() => setProcessing(null)}
          onDone={onProcessed}
          onConflict={() => { void load(); void loadCounts() }}
          onPreview={(attachments, index) => setPreview({ items: attachments, index })}
        />
      ) : null}

      {detail !== null ? (
        <DetailDialog
          ticketId={detail}
          open
          onClose={() => setDetail(null)}
          onPreview={(attachments, index) => setPreview({ items: attachments, index })}
        />
      ) : null}

      {preview !== null ? (
        <AttachmentPreview
          items={preview.items}
          index={preview.index}
          open
          onClose={() => setPreview(null)}
        />
      ) : null}

      {exportFor !== null ? (
        <ExportDialog
          open
          range={exportFor}
          ids={selected}
          filters={filters}
          onClose={() => setExportFor(null)}
        />
      ) : null}
    </ListCard>
  )
}
