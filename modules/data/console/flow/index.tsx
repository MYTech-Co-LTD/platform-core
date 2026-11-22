// console/flow/index.tsx — 「全流程」页（2026-11-22，#2687/#2689/#2691）。
//
// 形态演进（三次）：
//   ① 全量节点图（200+ 节点铺一屏）→ 用户反馈「不直观」
//   ② 单域卡片（六层一条链）→ 仍不满意
//   ③ **本次：对标 dbt Explorer / DataHub 的「列表 → 对象详情」**（渐进披露）
//
// 为什么是这个结构（行业共性，不是拍脑袋）：
//   · dbt Explorer / DataHub / Atlan：全局用「搜索 + 列表」，局部用「以对象为中心的详情」；
//     血缘默认只给上下游 1–2 跳，点击再展开 —— 从不把全部节点铺一屏。
//   · 详情页分 Tab（字段 / 血缘 / 运行）——按问题组织信息，而不是按图层。
//
// 数据：GET /system-map/objects（列表，带上下游计数）+ GET /system-map/object（详情）。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Drawer, Input, Segmented, Skeleton, Space, Table, Tabs, Tag, Typography } from 'antd'
import { apiGet } from '../lib/api'
import { humanError, type HumanError } from '../lib/explain'

type ObjectKind = 'lake' | 'staging' | 'mart' | 'recon' | 'metric' | 'pipeline'
interface ObjectRow {
  kind: ObjectKind
  name: string
  domain: string | null
  upstreamCount: number
  downstreamCount: number
}
interface SimpleRef { kind: ObjectKind; name: string }
interface ObjectColumn { name: string; type: string | null; expr: string | null; description: string }
interface ObjectDetail {
  kind: ObjectKind
  name: string
  domain: string | null
  columns: ObjectColumn[]
  upstream: SimpleRef[]
  downstream: SimpleRef[]
  upstream2: SimpleRef[]
  downstream2: SimpleRef[]
  notes: string[]
}

const KIND_LABEL: Record<ObjectKind, string> = {
  pipeline: '采集管线', lake: '湖资产', staging: 'staging', mart: 'marts', recon: '对账族', metric: '指标',
}
const KIND_COLOR: Record<ObjectKind, string> = {
  pipeline: 'orange', lake: 'green', staging: 'gold', mart: 'purple', recon: 'red', metric: 'magenta',
}

/** 血缘一跳列表：组标题 + 可点击的引用。 */
function RefList(props: { title: string; refs: SimpleRef[]; onPick: (r: SimpleRef) => void; muted?: boolean }) {
  const { title, refs, onPick, muted = false } = props
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 12, color: muted ? '#9aa0a6' : '#6b7280', marginBottom: 4 }}>{title}</div>
      {refs.length === 0 ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>无</Typography.Text> : (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {refs.map((r) => (
            <Tag
              key={`${r.kind}:${r.name}`}
              color={KIND_COLOR[r.kind]}
              style={{ marginInlineEnd: 0, cursor: 'pointer', fontFamily: 'ui-monospace, monospace', fontSize: 11.5 }}
              onClick={() => onPick(r)}
            >
              {r.name}
            </Tag>
          ))}
        </div>
      )}
    </div>
  )
}

export default function FlowPage() {
  const [rows, setRows] = useState<ObjectRow[] | null>(null)
  const [error, setError] = useState<HumanError | null>(null)
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<'all' | ObjectKind>('all')
  const [pick, setPick] = useState<SimpleRef | null>(null)
  const [detail, setDetail] = useState<ObjectDetail | null>(null)
  const [detailError, setDetailError] = useState<HumanError | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const res = (await apiGet('/system-map/objects')) as { rows: ObjectRow[] }
        setRows(res.rows)
        setError(null)
      } catch (e) { setError(humanError(e)) }
    })()
  }, [])

  const open = useCallback(async (ref: SimpleRef) => {
    setPick(ref)
    setDetail(null)
    setDetailError(null)
    try {
      const qs = new URLSearchParams({ kind: ref.kind, name: ref.name })
      setDetail((await apiGet(`/system-map/object?${qs.toString()}`)) as ObjectDetail)
    } catch (e) { setDetailError(humanError(e)) }
  }, [])

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase()
    return (rows ?? []).filter((r) =>
      (kind === 'all' || r.kind === kind)
      && (kw === '' || r.name.toLowerCase().includes(kw) || (r.domain ?? '').toLowerCase().includes(kw)))
  }, [rows, q, kind])

  const counts = useMemo(() => {
    const m = new Map<ObjectKind, number>()
    for (const r of rows ?? []) m.set(r.kind, (m.get(r.kind) ?? 0) + 1)
    return m
  }, [rows])

  if (error !== null) return <Alert type="error" showIcon message={error.text} description={`错误码：${error.code}`} />

  return (
    <div>
      <Space style={{ marginBottom: 10, flexWrap: 'wrap' }} size={10}>
        <Input.Search
          allowClear placeholder="搜表名 / 指标 / 管线 / 域" style={{ width: 280 }}
          onChange={(e) => setQ(e.target.value)}
        />
        <Segmented
          value={kind}
          onChange={(v) => setKind(v as typeof kind)}
          options={[
            { label: `全部 ${rows?.length ?? 0}`, value: 'all' },
            ...(Object.keys(KIND_LABEL) as ObjectKind[])
              .filter((k) => (counts.get(k) ?? 0) > 0)
              .map((k) => ({ label: `${KIND_LABEL[k]} ${counts.get(k)}`, value: k })),
          ]}
        />
      </Space>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12.5, margin: '0 0 10px' }}>
        选一个对象看它的**字段、上下游血缘、运行信息**（对标 dbt Explorer / DataHub 的对象详情页）。
      </Typography.Paragraph>

      {rows === null ? <Skeleton active paragraph={{ rows: 8 }} /> : (
        <Table<ObjectRow>
          size="small" rowKey={(r) => `${r.kind}:${r.name}`} dataSource={filtered}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          onRow={(r) => ({ onClick: () => { void open({ kind: r.kind, name: r.name }) }, style: { cursor: 'pointer' } })}
          columns={[
            {
              title: '对象', dataIndex: 'name', width: 340,
              render: (v: string, r) => (
                <Space size={6}>
                  <Tag color={KIND_COLOR[r.kind]} style={{ marginInlineEnd: 0, fontSize: 11 }}>{KIND_LABEL[r.kind]}</Tag>
                  <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12.5 }}>{v}</span>
                </Space>
              ),
            },
            { title: '域', dataIndex: 'domain', width: 160, render: (v: string | null) => v ?? <Typography.Text type="secondary">—</Typography.Text> },
            { title: '上游', dataIndex: 'upstreamCount', width: 80, render: (v: number) => (v === 0 ? '—' : `↑${v}`) },
            { title: '下游', dataIndex: 'downstreamCount', width: 80, render: (v: number) => (v === 0 ? '—' : `↓${v}`) },
            {
              title: '', width: 90,
              render: () => <span style={{ color: '#2a78d6', fontSize: 12 }}>详情 →</span>,
            },
          ]}
        />
      )}

      <Drawer
        open={pick !== null} onClose={() => setPick(null)} width={760}
        title={pick === null ? '' : (
          <Space size={8}>
            <Tag color={KIND_COLOR[pick.kind]} style={{ marginInlineEnd: 0 }}>{KIND_LABEL[pick.kind]}</Tag>
            <span style={{ fontFamily: 'ui-monospace, monospace' }}>{pick.name}</span>
          </Space>
        )}
      >
        {detailError !== null && <Alert type="error" showIcon message={detailError.text} description={`错误码：${detailError.code}`} />}
        {detail === null && detailError === null && <Skeleton active paragraph={{ rows: 6 }} />}
        {detail !== null && (
          <Tabs
            items={[
              {
                key: 'columns',
                label: `字段 ${detail.columns.length}`,
                children: detail.columns.length === 0
                  ? <Typography.Text type="secondary">没有解析到字段（事实源缺失——未知 ≠ 没有）</Typography.Text>
                  : (
                    <Table<ObjectColumn>
                      size="small" rowKey="name" dataSource={detail.columns} pagination={false}
                      columns={[
                        { title: '字段', dataIndex: 'name', width: 190, render: (v: string) => <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{v}</span> },
                        { title: '类型', dataIndex: 'type', width: 110, render: (v: string | null) => v ?? '—' },
                        {
                          title: '表达式 / 说明', dataIndex: 'expr',
                          render: (v: string | null, r) => (
                            <div style={{ fontSize: 12 }}>
                              {v !== null && <div style={{ fontFamily: 'ui-monospace, monospace', color: '#4b5563', wordBreak: 'break-all' }}>= {v}</div>}
                              {r.description !== '' && <div style={{ color: '#9aa0a6' }}>{r.description}</div>}
                              {v === null && r.description === '' && '—'}
                            </div>
                          ),
                        },
                      ]}
                    />
                  ),
              },
              {
                key: 'lineage',
                label: '血缘',
                children: (
                  <div>
                    <div style={{ fontSize: 12, color: '#9aa0a6', marginBottom: 8 }}>
                      以本对象为中心；点任意标签可跳到那个对象的详情（同 dbt Explorer 的 1–2 跳展开）。
                    </div>
                    <RefList title="上游 · 1 跳" refs={detail.upstream} onPick={(r) => void open(r)} />
                    <RefList title="上游 · 2 跳" refs={detail.upstream2} onPick={(r) => void open(r)} muted />
                    <div style={{ height: 1, background: '#f0f0f0', margin: '10px 0' }} />
                    <RefList title="下游 · 1 跳" refs={detail.downstream} onPick={(r) => void open(r)} />
                    <RefList title="下游 · 2 跳" refs={detail.downstream2} onPick={(r) => void open(r)} muted />
                  </div>
                ),
              },
              {
                key: 'notes',
                label: '说明',
                children: detail.notes.length === 0
                  ? <Typography.Text type="secondary">没有异常说明。</Typography.Text>
                  : (
                    <ul style={{ paddingLeft: 18, fontSize: 12.5, color: '#6b7280' }}>
                      {detail.notes.map((n) => <li key={n}>{n}</li>)}
                    </ul>
                  ),
              },
            ]}
          />
        )}
      </Drawer>
    </div>
  )
}
