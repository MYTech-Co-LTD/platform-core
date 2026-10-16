// console/Submissions.tsx — 提交记录页（issue #718）：按资产列出提交，展开看逐字段视图。
// 字典绑定字段做 options/resolve 同源翻译（退役值显式标注——正典：取已退役值渲染历史）；
// 非字典字段原样 JSON。历史提交按其钉住版本的契约解释（contract 由 /submissions/:id 回带）。
import { useEffect, useState } from 'react'
import { Select, Spin, Table, Tag, Typography } from 'antd'
import { apiGet, parseDictRef } from './api'
import type { DefSummary, OptionItem } from './api'

interface SubmissionRow {
  id: string
  version: number
  payload: unknown
  submittedBy: string
  submittedAt: string
}

export default function Submissions({
  assetId,
  onAssetChange,
}: {
  assetId: string | undefined
  onAssetChange: (assetId: string | null) => void
}) {
  const [defs, setDefs] = useState<DefSummary[]>([])
  const [rows, setRows] = useState<SubmissionRow[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    apiGet<{ defs: DefSummary[] }>('/api/modules/forms/defs')
      .then((body) => setDefs(body.defs))
      .catch(() => setDefs([]))
  }, [])

  useEffect(() => {
    if (assetId === undefined) {
      setRows([])
      return
    }
    setLoading(true)
    apiGet<{ submissions: SubmissionRow[] }>(
      `/api/modules/forms/defs/${encodeURIComponent(assetId)}/submissions`,
    )
      .then((body) => setRows(body.submissions))
      .catch(() => setRows([]))
      .finally(() => setLoading(false))
  }, [assetId])

  return (
    <div>
      <Typography.Title level={5}>提交记录</Typography.Title>
      <Select
        showSearch
        placeholder="选择表单"
        style={{ width: 320, marginBottom: 16 }}
        value={assetId}
        options={defs.map((d) => ({ value: d.assetId, label: d.assetId }))}
        onChange={(v) => onAssetChange(v)}
      />
      <Table<SubmissionRow>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
        pagination={{ pageSize: 20 }}
        columns={[
          { title: '记录', dataIndex: 'id', width: 90 },
          { title: '契约版本', dataIndex: 'version', width: 90, render: (v: number) => `v${v}` },
          { title: '提交人', dataIndex: 'submittedBy' },
          {
            title: '提交时间',
            dataIndex: 'submittedAt',
            render: (t: string) => new Date(t).toLocaleString(),
          },
        ]}
        expandable={{
          expandedRowRender: (row) => <PayloadView id={row.id} payload={row.payload} />,
        }}
      />
    </div>
  )
}

interface DictLabel {
  label: string
  enabled: boolean
}

/** 展开视图：按提交钉住版本的契约（/submissions/:id 回带）判字段引用——
 *  字典绑定字段翻译 label（退役标注），其余字段原样 JSON。 */
function PayloadView({ id, payload }: { id: string; payload: unknown }) {
  const [labels, setLabels] = useState<Map<string, DictLabel>>(new Map())
  const [props, setProps] = useState<string[]>([])
  const [dictRefsByField, setDictRefsByField] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const detail = await apiGet<{ contract: unknown }>(
          `/api/modules/forms/submissions/${encodeURIComponent(id)}`,
        )
        if (cancelled) return
        const propsObj = (detail.contract as { schema?: { properties?: Record<string, Record<string, unknown>> } } | null)
          ?.schema?.properties
        const fields = propsObj !== undefined ? Object.keys(propsObj) : []
        const refsByField = new Map<string, string>()
        for (const [field, prop] of Object.entries(propsObj ?? {})) {
          if (typeof prop['x-dict'] === 'string') refsByField.set(field, prop['x-dict'])
        }
        // 按 ref 批量 resolve 本行出现过的 key（含退役——resolve 面向历史渲染）
        const resolved = new Map<string, DictLabel>()
        const byRef = new Map<string, string[]>()
        const obj = (payload ?? {}) as Record<string, unknown>
        for (const [field, ref] of refsByField) {
          const v = obj[field]
          if (typeof v === 'string' && v.length > 0) {
            const list = byRef.get(ref) ?? []
            list.push(v)
            byRef.set(ref, list)
          }
        }
        for (const [ref, keys] of byRef) {
          const parsed = parseDictRef(ref)
          if (!parsed) continue
          const base = parsed.scope === 'global' ? '/api/modules/forms/global-dicts' : '/api/modules/forms/dicts'
          const body = await apiGet<{ resolved: Record<string, DictLabel> }>(
            `${base}/${parsed.dictId}/resolve?keys=${encodeURIComponent(keys.join(','))}`,
          )
          for (const [k, v] of Object.entries(body.resolved)) resolved.set(k, v)
        }
        if (!cancelled) {
          setProps(fields)
          setDictRefsByField(refsByField)
          setLabels(resolved)
        }
      } catch {
        if (!cancelled) setLabels(new Map())
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id, payload])

  if (loading) return <Spin size="small" />
  const obj = (payload ?? {}) as Record<string, unknown>
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      {props.map((field) => {
        const value = obj[field]
        const ref = dictRefsByField.get(field)
        if (ref !== undefined && typeof value === 'string') {
          const hit = labels.get(value)
          return (
            <Typography.Text key={field}>
              <Typography.Text type="secondary">{field}：</Typography.Text>
              {hit === undefined ? (
                value
              ) : (
                <>
                  {hit.label} <Typography.Text type="secondary">({value})</Typography.Text>
                  {!hit.enabled && <Tag color="orange" style={{ marginLeft: 4 }}>已退役</Tag>}
                </>
              )}
            </Typography.Text>
          )
        }
        return (
          <Typography.Text key={field}>
            <Typography.Text type="secondary">{field}：</Typography.Text>
            <code>{value === undefined || value === null ? '—' : JSON.stringify(value)}</code>
          </Typography.Text>
        )
      })}
    </div>
  )
}

// OptionItem 供后续候选装配复用（当前页只做翻译，不做编辑）
export type { OptionItem }
