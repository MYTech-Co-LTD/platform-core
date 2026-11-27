// stores/index.tsx — 门店档案 + 门店画像（品牌/等级，issue #2924）。
//
// 读：`GET /stores`（aftersales:manage，join data.v_store_profile 的 tag）
//     + `GET /stores/profile-options`（品牌/等级选项 + 覆盖率）。
// 写：data 模块的 `data:store` 面（PUT /store-profiles/:code、POST /store-profiles/import、
//     POST/PATCH /store-levels）；本页不复制校验逻辑，服务端的逐行错误原样回显。
//
// 权限：没有 `data:store` 时只读（tag 可见，编辑/导入/等级字典隐藏）；data API 403 仍是真闸。
import { useCallback, useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import {
  Alert, Button, Card, Drawer, Input, InputNumber, Modal, Select, Space, Switch, Table, Tag,
  Typography, message,
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

export default function StoresPage() {
  const outlet = useOutletContext<ConsoleContext | null>()
  const canEdit = (outlet?.session.scopes ?? []).includes('data:store')

  const [stores, setStores] = useState<StoreItem[]>([])
  const [options, setOptions] = useState<StoreProfileOptions | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [editing, setEditing] = useState<StoreItem | null>(null)
  const [editBrand, setEditBrand] = useState<string | undefined>()
  const [editLevel, setEditLevel] = useState<string | undefined>()
  const [saving, setSaving] = useState(false)

  const [importOpen, setImportOpen] = useState(false)
  const [csvText, setCsvText] = useState('store_code,brand_code,level_code\n')
  const [overrideLocked, setOverrideLocked] = useState(false)
  const [importPreview, setImportPreview] = useState<ImportResult | null>(null)
  const [importing, setImporting] = useState(false)

  const [levelsOpen, setLevelsOpen] = useState(false)
  const [levels, setLevels] = useState<StoreProfileOptions['levels']>([])
  const [newLevel, setNewLevel] = useState({ code: '', name: '', sort: 0 })
  const [levelSaving, setLevelSaving] = useState(false)

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

  const openEdit = (row: StoreItem) => {
    setEditing(row)
    setEditBrand(row.brandCode ?? undefined)
    setEditLevel(row.levelCode ?? undefined)
  }

  const saveProfile = async () => {
    if (!editing) return
    setSaving(true)
    try {
      await dataSend(`/store-profiles/${encodeURIComponent(editing.code)}`, 'PUT', {
        brandCode: editBrand ?? null,
        levelCode: editLevel ?? null,
      })
      message.success('门店画像已保存')
      setEditing(null)
      await reload()
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
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

  const openLevels = async () => {
    if (options !== null) {
      setLevels(options.levels)
    } else {
      try {
        const opts = await apiGet<StoreProfileOptions>('/stores/profile-options')
        setOptions(opts)
        setLevels(opts.levels)
      } catch { /* 保持空列表 */ }
    }
    setLevelsOpen(true)
  }

  const createLevel = async () => {
    if (newLevel.code.trim() === '' || newLevel.name.trim() === '') {
      message.error('等级 code 与名称都必填')
      return
    }
    setLevelSaving(true)
    try {
      await dataSend('/store-levels', 'POST', newLevel)
      message.success('等级已新增')
      setNewLevel({ code: '', name: '', sort: 0 })
      const opts = await apiGet<StoreProfileOptions>('/stores/profile-options')
      setOptions(opts)
      setLevels(opts.levels)
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e))
    } finally {
      setLevelSaving(false)
    }
  }

  const saveLevel = async (level: StoreProfileOptions['levels'][number]) => {
    setLevelSaving(true)
    try {
      await dataSend(`/store-levels/${encodeURIComponent(level.code)}`, 'PATCH', {
        name: level.name, sort: level.sort, enabled: level.enabled,
      })
      message.success(`等级 ${level.code} 已保存`)
      const opts = await apiGet<StoreProfileOptions>('/stores/profile-options')
      setOptions(opts)
      setLevels(opts.levels)
      await reload()
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e))
    } finally {
      setLevelSaving(false)
    }
  }

  const coverage = options?.coverage
  const brandOptions = (options?.brands ?? []).map((b) => ({
    value: b.code, label: b.enabled ? b.name : `${b.name}（停用）`,
  }))
  const levelOptions = (options?.levels ?? []).map((l) => ({
    value: l.code, label: l.enabled ? l.name : `${l.name}（停用）`,
  }))
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
          <>
            <Button onClick={() => { setCsvText('store_code,brand_code,level_code\n'); setImportPreview(null); setImportOpen(true) }}>
              批量导入
            </Button>
            <Button onClick={() => void openLevels()}>等级字典</Button>
          </>
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
            title: '品牌', width: 120,
            render: (_, r) => r.brandCode
              ? <Tag>{r.brandName || r.brandCode}</Tag>
              : <Typography.Text type="secondary">未标记</Typography.Text>,
          },
          {
            title: '等级', width: 120,
            render: (_, r) => r.levelCode
              ? <Tag>{r.levelName || r.levelCode}</Tag>
              : <Typography.Text type="secondary">未分级</Typography.Text>,
          },
          {
            title: '启用', width: 70,
            render: (_, r) => r.enable === null ? '—' : (r.enable ? '是' : '否'),
          },
          { title: '地址', dataIndex: 'address' },
          { title: '电话', dataIndex: 'phone', width: 150 },
          ...(canEdit ? [{
            title: '操作', width: 80,
            render: (_: unknown, r: StoreItem) => <Button size="small" onClick={() => openEdit(r)}>编辑</Button>,
          }] : []),
        ]}
      />

      <Drawer
        open={editing !== null}
        title={editing ? `编辑门店画像 · ${editing.name}` : '编辑门店画像'}
        onClose={() => setEditing(null)}
        width={380}
        extra={<Button type="primary" loading={saving} onClick={() => void saveProfile()}>保存</Button>}
      >
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <div>
            <Typography.Text strong>品牌</Typography.Text>
            <Select
              style={{ width: '100%', marginTop: 6 }}
              allowClear
              placeholder="未标记（清空）"
              value={editBrand}
              options={brandOptions}
              onChange={(v) => setEditBrand(v)}
            />
          </div>
          <div>
            <Typography.Text strong>等级</Typography.Text>
            <Select
              style={{ width: '100%', marginTop: 6 }}
              allowClear
              placeholder="未分级（清空）"
              value={editLevel}
              options={levelOptions}
              onChange={(v) => setEditLevel(v)}
            />
          </div>
          <Typography.Text type="secondary">
            保存后：新工单按新值快照；历史工单保持提单时的品牌/等级。
          </Typography.Text>
        </Space>
      </Drawer>

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

      <Modal
        open={levelsOpen}
        title="等级字典"
        width={760}
        onCancel={() => setLevelsOpen(false)}
        footer={<Button onClick={() => setLevelsOpen(false)}>关闭</Button>}
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Space wrap>
            <Input
              placeholder="code（如 A）" style={{ width: 120 }}
              value={newLevel.code}
              onChange={(e) => setNewLevel({ ...newLevel, code: e.target.value })}
            />
            <Input
              placeholder="名称（如 一级）" style={{ width: 160 }}
              value={newLevel.name}
              onChange={(e) => setNewLevel({ ...newLevel, name: e.target.value })}
            />
            <InputNumber
              placeholder="排序" value={newLevel.sort}
              onChange={(v) => setNewLevel({ ...newLevel, sort: Number(v ?? 0) })}
            />
            <Button type="primary" loading={levelSaving} onClick={() => void createLevel()}>新增</Button>
          </Space>
          <Table<StoreProfileOptions['levels'][number]>
            rowKey="code"
            size="small"
            dataSource={levels}
            pagination={false}
            columns={[
              { title: 'code', dataIndex: 'code', width: 100 },
              {
                title: '名称', width: 200,
                render: (_, l) => (
                  <Input
                    value={l.name}
                    onChange={(e) => setLevels(levels.map((x) => x.code === l.code ? { ...x, name: e.target.value } : x))}
                  />
                ),
              },
              {
                title: '排序', width: 100,
                render: (_, l) => (
                  <InputNumber
                    value={l.sort}
                    onChange={(v) => setLevels(levels.map((x) => x.code === l.code ? { ...x, sort: Number(v ?? 0) } : x))}
                  />
                ),
              },
              {
                title: '启用', width: 80,
                render: (_, l) => (
                  <Switch
                    checked={l.enabled}
                    onChange={(v) => setLevels(levels.map((x) => x.code === l.code ? { ...x, enabled: v } : x))}
                  />
                ),
              },
              {
                title: '操作', width: 80,
                render: (_, l) => (
                  <Button size="small" loading={levelSaving} onClick={() => void saveLevel(l)}>保存</Button>
                ),
              },
            ]}
          />
        </Space>
      </Modal>
    </Card>
  )
}
