// stores/index.tsx — 门店档案 + 门店画像（品牌/等级，issue #2924 / #2930）。
//
// 读：`GET /stores`（aftersales:manage，join data.v_store_profile 的 tag）
//     + `GET /stores/profile-options`（品牌/等级选项 + 覆盖率）。
// 写：data 模块的 `data:store` 面（PUT /store-profiles/:code、POST /brands、
//     POST /store-levels、POST /store-profiles/import）；本页不复制校验逻辑。
//
// 交互（#2930）：品牌/等级不再有「编辑抽屉」或「等级字典」独立入口——表格里直接点标签，
// 弹出单选下拉，选中即保存；下拉里没有想要的选项时，填名称直接新建（code 自动生成）。
//
// 权限：没有 `data:store` 时只读（标签不可点，批量导入隐藏）；data API 403 仍是真闸。
import { useCallback, useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import {
  Alert, Button, Card, Input, Modal, Popover, Select, Space, Switch, Table, Tag, Typography,
  message,
} from 'antd'
import { platformFetch } from '@platform/sdk/web'
import { apiGet } from '../lib/api'
import type { Paged, StoreItem, StoreProfileOptions } from '../../api-types'

interface ConsoleContext { session: { scopes: string[] } }

const DATA_BASE = '/api/modules/data'

interface ImportRowResult {
  row: number
  storeCode: string
  status: 'ok' | 'skipped' | 'error' | 'duplicate'
  code?: string
  changed?: boolean
}
interface ImportResult {
  dryRun: boolean
  total: number
  applied: number
  skipped: number
  errors: number
  duplicates: number
  rows: ImportRowResult[]
}

type Option = StoreProfileOptions['brands'][number]

async function dataSend<T>(
  path: string, method: 'POST' | 'PUT' | 'PATCH', body?: unknown,
): Promise<T> {
  const res = await platformFetch(DATA_BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  if (!res.ok) {
    const b = (await res.json().catch(() => null)) as { error?: string; detail?: string } | null
    throw new Error(b?.detail ? `${b.error ?? res.status}：${b.detail}` : (b?.error ?? `HTTP_${res.status}`))
  }
  return (await res.json()) as T
}

/** 自动 code：用户只填名称；code 是内部标识，展示一律用 name。 */
function autoCode(prefix: 'b' | 'lv'): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** CSV → rows。空字段 = 保持不变；`__clear__` = 清空（服务端两样都懂）。 */
function parseCsv(text: string): { rows: Array<Record<string, unknown>>; error: string | null } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '')
  if (lines.length === 0) return { rows: [], error: 'CSV 为空' }
  if (/^store[_-]?code\b/i.test(lines[0])) lines.shift()
  const rows: Array<Record<string, unknown>> = []
  for (const line of lines) {
    const [storeCode = '', brandCode = '', levelCode = ''] = line.split(',').map((x) => x.trim())
    if (storeCode === '') continue
    const row: Record<string, unknown> = { storeCode }
    if (brandCode !== '') row.brandCode = brandCode
    if (levelCode !== '') row.levelCode = levelCode
    rows.push(row)
  }
  if (rows.length === 0) return { rows, error: '没有可导入的门店行' }
  return { rows, error: null }
}

/** 表格里的可点标签：单选下拉 + 内联新建。 */
function TagEditor(props: {
  label: '品牌' | '等级'
  emptyLabel: string
  code: string | null
  name: string | null
  options: Option[]
  canEdit: boolean
  onAssign: (code: string | null) => Promise<void>
  onCreate: (name: string) => Promise<string>
}) {
  const [open, setOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const text = props.name || props.code
  const tag = (
    <Tag style={props.canEdit ? { cursor: 'pointer', marginInlineEnd: 0 } : { marginInlineEnd: 0 }}>
      {text || props.emptyLabel}
    </Tag>
  )
  if (!props.canEdit) return tag

  const assign = async (code: string | null): Promise<void> => {
    setBusy(true)
    try {
      await props.onAssign(code)
      setOpen(false)
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const create = async (): Promise<void> => {
    const name = newName.trim()
    if (name === '') return
    setBusy(true)
    try {
      const code = await props.onCreate(name)
      await props.onAssign(code)
      setNewName('')
      setOpen(false)
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const content = (
    <Space direction="vertical" size={8} style={{ width: 230 }}>
      <Select
        size="small"
        style={{ width: '100%' }}
        allowClear
        disabled={busy}
        placeholder={`选择${props.label}`}
        value={props.code ?? undefined}
        options={props.options.map((o) => ({
          value: o.code,
          label: o.enabled ? o.name : `${o.name}（停用）`,
        }))}
        onChange={(v?: string) => void assign(v ?? null)}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        没有想要的？直接新建
      </Typography.Text>
      <Input
        size="small"
        placeholder={`新${props.label}名称`}
        value={newName}
        disabled={busy}
        onChange={(e) => setNewName(e.target.value)}
        onPressEnter={() => void create()}
      />
      <Button
        size="small"
        type="primary"
        ghost
        block
        loading={busy}
        disabled={newName.trim() === ''}
        onClick={() => void create()}
      >
        新建「{newName.trim() || '…'}」
      </Button>
    </Space>
  )

  return (
    <Popover
      open={open}
      onOpenChange={(v) => { setOpen(v); if (!v) setNewName('') }}
      trigger="click"
      content={content}
    >
      {tag}
    </Popover>
  )
}

export default function StoresPage() {
  const outlet = useOutletContext<ConsoleContext | null>()
  const canEdit = (outlet?.session.scopes ?? []).includes('data:store')

  const [stores, setStores] = useState<StoreItem[]>([])
  const [options, setOptions] = useState<StoreProfileOptions | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [importOpen, setImportOpen] = useState(false)
  const [csvText, setCsvText] = useState('store_code,brand_code,level_code\n')
  const [overrideLocked, setOverrideLocked] = useState(false)
  const [importPreview, setImportPreview] = useState<ImportResult | null>(null)
  const [importing, setImporting] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const paged = await apiGet<Paged<StoreItem>>('/stores')
      setStores(paged.items)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStores([])
    } finally {
      setLoading(false)
    }
    // 选项失败不拖垮门店列表（data 057 未部署时视图缺失 ⇒ 只读降级）
    try {
      setOptions(await apiGet<StoreProfileOptions>('/stores/profile-options'))
    } catch {
      setOptions(null)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const assignProfile = async (
    store: StoreItem, patch: { brandCode?: string | null; levelCode?: string | null },
  ): Promise<void> => {
    await dataSend(`/store-profiles/${encodeURIComponent(store.code)}`, 'PUT', patch)
    message.success('已保存')
    await reload()
  }

  const createBrand = async (name: string): Promise<string> => {
    const created = await dataSend<{ code: string }>('/brands', 'POST', { code: autoCode('b'), name })
    return created.code
  }

  const createLevel = async (name: string): Promise<string> => {
    const created = await dataSend<{ code: string }>('/store-levels', 'POST', { code: autoCode('lv'), name })
    return created.code
  }

  const runImport = async (dryRun: boolean) => {
    const parsed = parseCsv(csvText)
    if (parsed.error !== null) {
      message.error(parsed.error)
      return
    }
    setImporting(true)
    try {
      const result = await dataSend<ImportResult>('/store-profiles/import', 'POST', {
        dryRun, overrideLocked, rows: parsed.rows,
      })
      setImportPreview(result)
      if (dryRun) {
        message.success(`预检完成：${result.applied} 行可写入，${result.errors} 行错误，${result.skipped} 行跳过`)
      } else {
        message.success(`已导入：${result.applied} 行写入，${result.errors} 行错误，${result.duplicates} 行重复`)
        await reload()
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e))
    } finally {
      setImporting(false)
    }
  }

  const coverage = options?.coverage
  const problemRows = (importPreview?.rows ?? []).filter((r) => r.status !== 'ok')

  return (
    <Card>
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} /> : null}
      {options?.degraded ? (
        <Alert
          type="warning" showIcon style={{ marginBottom: 12 }}
          message="门店画像数据未就绪"
          description="data 模块 057 迁移尚未部署，品牌/等级 tag 暂不可用；门店列表仍可查看。"
        />
      ) : null}

      <Space wrap style={{ marginBottom: 12 }}>
        {coverage ? (
          <Typography.Text type="secondary">
            已标记品牌 {coverage.brandTagged}/{coverage.stores} · 已分级 {coverage.levelTagged}/{coverage.stores}
          </Typography.Text>
        ) : null}
        {canEdit ? (
          <Button onClick={() => { setCsvText('store_code,brand_code,level_code\n'); setImportPreview(null); setImportOpen(true) }}>
            批量导入
          </Button>
        ) : null}
      </Space>

      <Table<StoreItem>
        rowKey="code"
        size="small"
        dataSource={stores}
        loading={loading}
        pagination={false}
        locale={{ emptyText: '还没有门店档案。数据面的门店维表发布后会出现在这里。' }}
        columns={[
          { title: '编码', dataIndex: 'code', width: 120 },
          { title: '门店', dataIndex: 'name' },
          {
            title: '品牌', width: 130,
            render: (_, r) => (
              <TagEditor
                label="品牌"
                emptyLabel="未标记"
                code={r.brandCode ?? null}
                name={r.brandName ?? null}
                options={options?.brands ?? []}
                canEdit={canEdit}
                onAssign={(code) => assignProfile(r, { brandCode: code })}
                onCreate={createBrand}
              />
            ),
          },
          {
            title: '等级', width: 130,
            render: (_, r) => (
              <TagEditor
                label="等级"
                emptyLabel="未分级"
                code={r.levelCode ?? null}
                name={r.levelName ?? null}
                options={options?.levels ?? []}
                canEdit={canEdit}
                onAssign={(code) => assignProfile(r, { levelCode: code })}
                onCreate={createLevel}
              />
            ),
          },
          {
            title: '启用', width: 70,
            render: (_, r) => r.enable === null ? '—' : (r.enable ? '是' : '否'),
          },
          { title: '地址', dataIndex: 'address' },
          { title: '电话', dataIndex: 'phone', width: 150 },
        ]}
      />

      <Modal
        open={importOpen}
        title="批量导入门店画像"
        width={820}
        onCancel={() => setImportOpen(false)}
        footer={[
          <Button key="close" onClick={() => setImportOpen(false)}>关闭</Button>,
          <Button key="dry" loading={importing} onClick={() => void runImport(true)}>预检（dry-run）</Button>,
          <Button key="apply" type="primary" loading={importing} onClick={() => void runImport(false)}>执行导入</Button>,
        ]}
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            CSV 三列：store_code,brand_code,level_code。空字段 = 保持不变；要清空请填 __clear__。
          </Typography.Text>
          <Input.TextArea
            rows={8}
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            style={{ fontFamily: 'monospace' }}
          />
          <Space>
            <Switch checked={overrideLocked} onChange={setOverrideLocked} />
            <Typography.Text>覆盖手工锁定值（默认跳过 locked 行）</Typography.Text>
          </Space>
          {importPreview ? (
            <>
              <Alert
                type={importPreview.errors > 0 ? 'warning' : 'success'}
                showIcon
                message={`${importPreview.dryRun ? '预检' : '已导入'}：共 ${importPreview.total} 行，可写入/已写入 ${importPreview.applied}，错误 ${importPreview.errors}，跳过 ${importPreview.skipped}，重复 ${importPreview.duplicates}`}
              />
              {problemRows.length > 0 ? (
                <Table<ImportRowResult>
                  size="small"
                  rowKey={(r) => `${r.row}-${r.storeCode}`}
                  dataSource={problemRows}
                  pagination={false}
                  scroll={{ y: 220 }}
                  columns={[
                    { title: '行', dataIndex: 'row', width: 60 },
                    { title: '门店', dataIndex: 'storeCode' },
                    { title: '结果', dataIndex: 'status', width: 90 },
                    { title: '原因', dataIndex: 'code', width: 160 },
                  ]}
                />
              ) : null}
            </>
          ) : null}
        </Space>
      </Modal>
    </Card>
  )
}
