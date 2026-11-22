// console/flow/index.tsx — 「全流程」页（2026-11-22，#2687；#2689 改为单域卡片形态）。
//
// 形态演进（用户反馈「全图不直观」）：从「所有节点铺在一张可缩放画布」改为
// **一次看一个业务域、一条链六张大卡**——
//   源接口 → 采集管线 → 湖资产 → staging → marts → 指标
// 理由：全图有 200+ 节点、要缩放拖动，看不懂；单域链每层只有 1–N 项，字大、不用缩。
//
// 数据仍来自 GET /system-map/flow（后端按湖前缀聚合），本页在前端**按域切子图**：
//   · 域 = 湖前缀的第二段（`lemeng/retail_order_line` → `retail_order_line`）
//   · 沿边遍历取该域的 源/管线/湖/staging/marts/指标
// 细节展开复用现役端点：管线节点流（/system-map/pipelines/:id/flow）。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Drawer, Empty, Segmented, Skeleton, Tag, Typography } from 'antd'
import { apiGet } from '../lib/api'
import { humanError, type HumanError } from '../lib/explain'

type FlowKind = 'source' | 'pipeline' | 'lake' | 'staging' | 'mart' | 'recon' | 'metric' | 'consumer' | 'audit'

interface FlowNode {
  id: string
  kind: FlowKind
  label: string
  count?: number
  members?: string[]
  x: number
  y: number
}
interface FlowEdge { source: string; target: string; style?: 'dashed' }
interface FlowBody { generatedAt: string; nodes: FlowNode[]; edges: FlowEdge[]; notes: string[] }
interface FlowStep { id: string; step: number; component: string; kind: string; label: string; detail?: string; count?: number }

/** 一个业务域的子图：沿边从「湖」往两边走，收集各层成员。 */
interface DomainView {
  key: string
  lake: FlowNode | null
  sources: string[]
  pipelines: FlowNode[]
  staging: string[]
  marts: Array<{ name: string; kind: FlowKind }>
  metrics: FlowNode[]
}

export function domainsOf(body: FlowBody): DomainView[] {
  const byId = new Map(body.nodes.map((n) => [n.id, n]))
  const out: DomainView[] = []
  for (const lake of body.nodes.filter((n) => n.kind === 'lake')) {
    const key = lake.label.split('/')[1] ?? lake.label
    const pipes = body.nodes.filter(
      (n) => n.kind === 'pipeline' && body.edges.some((e) => e.source === n.id && e.target === lake.id),
    )
    const pipeIds = new Set(pipes.map((p) => p.id))
    const sources = [...new Set(
      body.edges.filter((e) => pipeIds.has(e.target)).map((e) => byId.get(e.source)?.label ?? '').filter(Boolean),
    )]
    const stagingEdges = body.edges.filter((e) => e.source === lake.id)
    const staging = stagingEdges.map((e) => byId.get(e.target)?.label ?? '').filter(Boolean)
    const stagingIds = new Set(stagingEdges.map((e) => e.target))
    const martNodes = body.nodes.filter(
      (n) => (n.kind === 'mart' || n.kind === 'recon')
        && body.edges.some((e) => stagingIds.has(e.source) && e.target === n.id),
    )
    const martIds = new Set(martNodes.map((n) => n.id))
    const metrics = body.nodes.filter(
      (n) => n.kind === 'metric' && body.edges.some((e) => martIds.has(e.source) && e.target === n.id),
    )
    out.push({
      key,
      lake,
      sources,
      pipelines: pipes,
      staging,
      marts: martNodes.map((n) => ({ name: n.label, kind: n.kind })),
      metrics,
    })
  }
  return out.sort((a, b) => a.key.localeCompare(b.key))
}

/** 一张阶段卡：标题 + 计数 + 成员（默认 6 项，可展开）。 */
function StageCard(props: {
  index: string
  title: string
  hint: string
  items: Array<{ label: string; badge?: string; onClick?: () => void }>
  empty?: string
}) {
  const { index, title, hint, items, empty = '这一层没有成员' } = props
  const [open, setOpen] = useState(false)
  const shown = open ? items : items.slice(0, 6)
  return (
    <div style={{
      border: '1px solid #e8e8e5', borderRadius: 12, padding: '12px 14px',
      background: '#fcfcfb', display: 'flex', flexDirection: 'column', minHeight: 136,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 }}>
        <span style={{ fontSize: 11, color: '#9aa0a6' }}>{index}</span>
        <b style={{ fontSize: 14 }}>{title}</b>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#6b7280' }}>{items.length} 项</span>
      </div>
      <div style={{ fontSize: 11.5, color: '#9aa0a6', marginBottom: 8 }}>{hint}</div>
      {items.length === 0 ? (
        <div style={{ fontSize: 12.5, color: '#9aa0a6' }}>{empty}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {shown.map((it) => (
            <div
              key={it.label}
              onClick={it.onClick}
              style={{
                fontSize: 12.5, cursor: it.onClick === undefined ? 'default' : 'pointer',
                display: 'flex', gap: 6, alignItems: 'baseline',
              }}
            >
              <span style={{ fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' }}>{it.label}</span>
              {it.badge !== undefined && <Tag style={{ marginInlineEnd: 0, fontSize: 11 }}>{it.badge}</Tag>}
              {it.onClick !== undefined && <span style={{ color: '#8c8c8c', fontSize: 11 }}>详情 →</span>}
            </div>
          ))}
          {items.length > 6 && (
            <span
              style={{ fontSize: 12, color: '#2a78d6', cursor: 'pointer', marginTop: 2 }}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? '收起' : `展开全部 ${items.length} 项`}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

export default function FlowPage() {
  const [body, setBody] = useState<FlowBody | null>(null)
  const [error, setError] = useState<HumanError | null>(null)
  const [domain, setDomain] = useState<string | null>(null)
  const [pipeId, setPipeId] = useState<string | null>(null)
  const [steps, setSteps] = useState<FlowStep[] | null>(null)

  const load = useCallback(async () => {
    try {
      setBody((await apiGet('/system-map/flow')) as FlowBody)
      setError(null)
    } catch (e) { setError(humanError(e)) }
  }, [])
  useEffect(() => { void load() }, [load])

  const domains = useMemo(() => (body === null ? [] : domainsOf(body)), [body])
  const active = useMemo(
    () => domains.find((d) => d.key === (domain ?? domains[0]?.key)) ?? null,
    [domains, domain],
  )

  const openPipeline = useCallback(async (id: string) => {
    setPipeId(id)
    setSteps(null)
    try {
      const res = (await apiGet(`/system-map/pipelines/${encodeURIComponent(id)}/flow`)) as { steps?: FlowStep[] }
      setSteps(res.steps ?? [])
    } catch { setSteps([]) }
  }, [])

  if (error !== null) return <Alert type="error" showIcon message={error.text} description={`错误码：${error.code}`} />
  if (body === null) {
    return <div><Skeleton active /><Typography.Text type="secondary" style={{ fontSize: 12 }}>正在读取流程定义…</Typography.Text></div>
  }
  if (active === null) return <Empty description="没有可展示的业务域" />

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        <Segmented
          value={active.key}
          onChange={(v) => setDomain(String(v))}
          options={domains.map((d) => ({ label: d.key, value: d.key }))}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          一次看一个业务域的一条链：源 → 采集 → 湖 → staging → marts → 指标。点条目看细节。
        </Typography.Text>
      </div>

      {body.notes.length > 0 && (
        <Alert type="warning" showIcon style={{ marginBottom: 10 }} message={body.notes.join('；')} />
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 10 }}>
        <StageCard
          index="①" title="源接口" hint="乐檬接口里这一域的数据"
          items={active.sources.map((s) => ({ label: s }))}
        />
        <StageCard
          index="②" title="采集管线" hint="按周期去源接口取数；点开看内部节点流"
          items={active.pipelines.map((p) => ({
            label: p.label,
            badge: p.count !== undefined ? `×${p.count}` : undefined,
            onClick: p.members !== undefined && p.members.length > 0
              ? () => { void openPipeline(p.members![0]) }
              : undefined,
          }))}
        />
        <StageCard
          index="③" title="湖资产" hint="parquet 按 账套/营业日/小时 分区落盘"
          items={active.lake === null ? [] : [{ label: active.lake.label }]}
        />
        <StageCard
          index="④" title="staging" hint="逐列 cast、补主体列——只规范化不改口径"
          items={active.staging.map((s) => ({ label: s }))}
        />
        <StageCard
          index="⑤" title="marts" hint="按 账套×营业日×门店 聚合出度量；对账族单独标"
          items={active.marts.map((m) => ({ label: m.name, badge: m.kind === 'recon' ? '对账' : undefined }))}
        />
        <StageCard
          index="⑥" title="指标" hint="口径的唯一实现；去「血缘」视角看公式与字段"
          items={active.metrics.map((m) => ({
            label: m.label,
            badge: m.count !== undefined ? `${m.count} 个` : undefined,
          }))}
        />
      </div>

      <Drawer
        open={pipeId !== null} onClose={() => setPipeId(null)} width={560}
        title={pipeId === null ? '' : `管线节点流：${pipeId}`}
      >
        {steps === null && <Skeleton active paragraph={{ rows: 4 }} />}
        {steps !== null && steps.length === 0 && <Typography.Text type="secondary">没有解析到节点流。</Typography.Text>}
        {steps !== null && steps.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {steps.map((st) => (
              <div key={st.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 13 }}>
                <span style={{ color: '#8c8c8c', minWidth: 22 }}>{st.step}</span>
                <span style={{ fontFamily: 'ui-monospace, monospace', color: '#8c8c8c', fontSize: 11.5 }}>{st.component}</span>
                <span>{st.label || st.kind}{st.count !== undefined && st.count > 1 ? ` ×${st.count}` : ''}</span>
                {st.detail !== undefined && <span style={{ color: '#aaa', fontSize: 11.5 }}>{st.detail}</span>}
              </div>
            ))}
          </div>
        )}
      </Drawer>
    </div>
  )
}
