// console/metrics/index.tsx — 指标管理：词表（L1 平台 + L2 本租户）+ **声明式**的 L2 定义表单。
//
// ── T8 之后这里为什么可以给表单了（旧版整页只读，注释里写着「两条硬约束排除 UI 写」）──────
// 旧版的入参是自由 SQL（`subjectColumn` + `selectSql` 必填），于是两条硬约束都无法满足：
//   ① 简表单必然 400；② console 提供 SQL 输入框 = 在消费层第二次定义口径。
// T8 把入参收成 `L2Declaration`（结构化、可机检）之后，这两条**同时**消失了：
// 表单能表达完整声明（base + 别名 + 维度白名单 + 过滤），而 SQL 由服务端的唯一编译点生成——
// UI 结构上**没有地方**能写 SQL。
//
// ⚠️ 表单**不**提供 `target`（目标值）：服务端在 `data.metrics` 里没有它的存储列，
// 入参会以 400 `TARGET_NOT_SUPPORTED` 被**显式拒绝**（不静默丢弃）。所以这里也不摆一个
// 按了会报错的输入框——见 README「L2 的已知边界」。
import { useEffect, useMemo, useState } from 'react'
import { Button, Card, Drawer, Input, Modal, Popconfirm, Segmented, Select, Space, Switch, Table, Tag, Timeline, Typography, message } from 'antd'
import { apiGet, apiSend, messageOf } from '../lib/api'
import DeclarationModal from './DeclarationModal'
import type { DeclarationMode, DeclarationSeed } from './DeclarationModal'
import { useIsMobile } from '../lib/useIsMobile'
import { TechDetails } from '../components/TechDetails'

interface MetricRow {
  id: string
  title: string
  description: string
  requiredScope: string | null
  subjectColumn: string
  selectSql: string
  groupBy: string
  source: 'l1' | 'l2'
  /** #489：最后操作人（L1 行走 sync 物化 ⇒ null）；列表两列的数据源。 */
  updatedBy: string | null
  version: number
  /** #489 之后的治理字段（adminView 形状）：creator 判定 + certified 徽标 + 元数据三件套。 */
  createdBy: string | null
  certified?: 'certified' | 'draft'
  /** 元数据（030，spec §10.4.3）：null = 未标注；L1 行恒 null（平台口径，租户不得注解）。 */
  bizDescription: string | null
  unit: string | null
  caliberNote: string | null
  /** W8：测度档——declared = 租户全额声明（编辑走删除+重建，不走 L2 结构化编辑器）。 */
  basis?: 'l1_tree' | 'column_agg' | 'declared'
  /** W8：非空 = 本行是对该 L1 id 的口径覆盖（草稿或已确认）。 */
  overrideOf?: string | null
}

/** W8 覆盖清单的一行（`GET /metrics/overrides` 的形状；草稿不在合并词表里，故单独拉）。 */
interface OverrideRow {
  id: string
  title: string
  certified: 'certified' | 'draft'
  selectSql: string
  updatedBy: string | null
  version: number
  updatedAt: string | null
}

/** 变更史的一行（`GET /metrics/:id/audit` 的形状）。 */
/** 使用统计一行（GET /metrics/usage 的形状，spec §10.4.3 P1）。 */
interface UsageStat {
  metricId: string
  title: string
  source: 'l1' | 'l2'
  createdBy: string | null
  queries: number
  users: number
  lastUsedAt: string | null
}
/** 下线候选一行（source=l2 且窗口内 0 次使用——清单只读，动作另行）。 */
interface RetireCandidate {
  metricId: string
  title: string
  source: 'l2'
  createdBy: string | null
  lastUsedAt: string | null
}

interface AuditRow {
  id: number
  action: 'create' | 'update' | 'delete' | 'certify' | 'meta'
  userId: string
  channel: string
  createdAt: string
  /** 变更前/后的行快照；create 无 before、delete 无 after。 */
  before: { title: string; description: string } | null
  after: { title: string; description: string } | null
}

/** 表单里的过滤行（values 是逗号分隔的输入框文本，提交时拆成数组）。 */
interface FilterDraft { dim: string; op: '=' | 'in'; values: string }

interface Draft {
  id: string
  baseMetric: string
  alias: string
  /** 是否自定义维度（关闭 = 继承平台指标的全部维度 ⇒ 提交时**不带** visibility 字段）。 */
  restrictDims: boolean
  dims: string[]
  filters: FilterDraft[]
}

const emptyDraft = (): Draft => ({
  id: '', baseMetric: '', alias: '', restrictDims: false, dims: [], filters: [],
})

/** `group_by` 文本 → 维度名数组（服务端拼的就是 `a, b` 这一形态，两处口径必须一致）。 */
const dimsOf = (row: MetricRow | undefined): string[] =>
  (row?.groupBy ?? '').split(',').map((d) => d.trim()).filter((d) => d !== '')

export default function MetricsPage() {
  const [rows, setRows] = useState<MetricRow[]>([])
  // 列表工具条（UX 2026-11-03）：指标表列多、行多，搜索与来源筛选是第一需要。
  const isMobile = useIsMobile()
  const [sheetFor, setSheetFor] = useState<MetricRow | null>(null)
  const [filterOpen, setFilterOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [sourceFilter, setSourceFilter] = useState<'all' | 'l1' | 'l2'>('all')
  const SOURCE_OPTIONS = [
    { label: '全部', value: 'all' as const },
    { label: '平台指标', value: 'l1' as const },
    { label: '派生指标', value: 'l2' as const },
  ]
  const [draft, setDraft] = useState<Draft | null>(null)
  // #489：变更历史抽屉。historyId=null 即关闭（不用额外一个 open 布尔量，避免两处状态打架）
  const [historyId, setHistoryId] = useState<string | null>(null)
  const [history, setHistory] = useState<AuditRow[]>([])
  // 使用统计抽屉（spec 2026-11-01 §10.4.3 P1）；null = 关（与 history 同款单状态惯例）
  const [usageDays, setUsageDays] = useState<number | null>(null)
  const [usage, setUsage] = useState<{
    days: number; stats: UsageStat[]; retireCandidates: RetireCandidate[]; self?: { userId: string }
  } | null>(null)
  // 元数据编辑弹窗（§10.4.3 P1）：null = 关。只对 L2 行开放（L1 平台口径，租户不得注解 → 404）。
  const [metaDraft, setMetaDraft] = useState<{
    id: string; title: string; biz: string; unit: string; note: string
  } | null>(null)
  // W8：契约声明弹窗 + 覆盖清单（草稿不可见，单独拉）
  const [overrides, setOverrides] = useState<OverrideRow[]>([])
  const [declOpen, setDeclOpen] = useState(false)
  const [declMode, setDeclMode] = useState<DeclarationMode>('create')
  const [declSeed, setDeclSeed] = useState<DeclarationSeed>({ id: '', title: '', description: '', expression: '', grain: [] })
  const [messageApi, ctx] = message.useMessage()

  const load = () => Promise.all([apiGet('/metrics/all'), apiGet('/metrics/overrides')])
    .then(([all, ov]) => {
      setRows((all as { metrics: MetricRow[] }).metrics)
      setOverrides((ov as { overrides?: OverrideRow[] }).overrides ?? [])
    })
    .catch((e) => messageApi.error(messageOf(e)))
  useEffect(() => { void load() }, [])

  const l1Rows = useMemo(() => rows.filter((r) => r.source === 'l1'), [rows])
  const base = useMemo(() => rows.find((r) => r.id === draft?.baseMetric), [rows, draft?.baseMetric])
  const baseDims = useMemo(() => dimsOf(base), [base])

  /** 打开某条口径的变更历史（按需拉取；失败只提示，不阻塞页面）。 */
  const openHistory = (id: string) => {
    setHistoryId(id)
    setHistory([])
    apiGet(`/metrics/${id}/audit`)
      .then((b) => setHistory((b as { audit: AuditRow[] }).audit))
      .catch((e) => messageApi.error(messageOf(e)))
  }

  /** 打开使用统计抽屉（窗口切换即重新拉取；失败只提示）。 */
  const openUsage = (days: number) => {
    setUsageDays(days)
    setUsage(null)
    apiGet(`/metrics/usage?days=${days}`)
      .then((b) => setUsage(b as {
        days: number; stats: UsageStat[]; retireCandidates: RetireCandidate[]; self?: { userId: string }
      }))
      .catch((e) => messageApi.error(messageOf(e)))
  }

  /** 打开元数据编辑（预填当前值；null 显示为空串——保存时全部回传 = 全量更新）。 */
  function openMeta(r: MetricRow) {
    setMetaDraft({ id: r.id, title: r.title, biz: r.bizDescription ?? '', unit: r.unit ?? '', note: r.caliberNote ?? '' })
  }

  /** 保存元数据（全量三字段；空串 = 显式清空——后端 clean 成 null）。 */
  async function submitMeta() {
    if (metaDraft === null) return
    try {
      await apiSend(`/metrics/${metaDraft.id}/meta`, 'PUT', {
        bizDescription: metaDraft.biz.trim(),
        unit: metaDraft.unit.trim(),
        caliberNote: metaDraft.note.trim(),
      })
      setMetaDraft(null)
      await load()
    } catch (e) { messageApi.error(messageOf(e)) }
  }

  /** 从 L1 行的 select_sql 里反解表达式（仅用于表单预填；服务端仍按提交的声明重新编译）。 */
  const exprOf = (sql: string): string => {
    const m = /^select\s+([\s\S]+?)\s+as\s+value/i.exec(sql.trim())
    return m?.[1]?.trim() ?? ''
  }
  const seedOfL1 = (r: MetricRow): DeclarationSeed => ({
    id: r.id, title: r.title, description: r.description,
    expression: exprOf(r.selectSql), grain: dimsOf(r),
  })
  function openDeclaration(mode: DeclarationMode, seed: DeclarationSeed) {
    setDeclMode(mode); setDeclSeed(seed); setDeclOpen(true)
  }
  async function submitDeclaration(declaration: Record<string, unknown>) {
    try {
      if (declMode === 'override') await apiSend(`/metrics/${declSeed.id}/override`, 'POST', { declaration })
      else await apiSend('/metrics/declarations', 'POST', { declaration })
      setDeclOpen(false)
      await load()
    } catch (e) { messageApi.error(messageOf(e)) }
  }
  async function confirmOverride(id: string) {
    try { await apiSend(`/metrics/${id}/override/confirm`, 'POST'); await load() }
    catch (e) { messageApi.error(messageOf(e)) }
  }
  async function deleteOverride(id: string) {
    try { await apiSend(`/metrics/${id}/override`, 'DELETE'); await load() }
    catch (e) { messageApi.error(messageOf(e)) }
  }

  function openCreate() {
    setDraft({ ...emptyDraft(), baseMetric: l1Rows[0]?.id ?? '' })
  }

  function openEdit(r: MetricRow) {
    // 从**库里那行**反推草稿：只能还原出编译产物能表达的部分（visibility 与 filters 已经
    // 烘进 select_sql，不再是结构化字段）⇒ 编辑时按「继承全部维度、无过滤」起步，
    // 用户重选即可。这不是信息丢失的缺陷，是「编译产物是单向的」的必然结果：
    // 想看这条 L2 当初怎么定义的，看 description 里的派生来源 + 服务端日志。
    setDraft({
      id: r.id, baseMetric: '', alias: r.title, restrictDims: false, dims: [], filters: [],
    })
  }

  async function submit() {
    if (draft === null) return
    const body: Record<string, unknown> = {
      id: draft.id.trim(),
      baseMetric: draft.baseMetric,
      op: { kind: 'refine' },
    }
    if (draft.alias.trim() !== '') body.alias = draft.alias.trim()
    if (draft.restrictDims) body.visibility = { dims: draft.dims }
    const filters = draft.filters
      .filter((f) => f.dim !== '')
      .map((f) => ({
        dim: f.dim,
        op: f.op,
        values: f.values.split(',').map((v) => v.trim()).filter((v) => v !== ''),
      }))
    if (filters.length > 0) body.filters = filters

    try {
      const editing = rows.some((r) => r.id === body.id && r.source === 'l2')
      await apiSend(editing ? `/metrics/${String(body.id)}` : '/metrics', editing ? 'PUT' : 'POST', body)
      setDraft(null)
      await load()
    } catch (e) { messageApi.error(messageOf(e)) }
  }

  async function remove(id: string) {
    try { await apiSend(`/metrics/${id}`, 'DELETE'); await load() }
    catch (e) { messageApi.error(messageOf(e)) }
  }

  const q = query.trim().toLowerCase()
  const visibleRows = rows.filter((r) => {
    if (sourceFilter !== 'all' && r.source !== sourceFilter) return false
    if (q === '') return true
    return r.id.toLowerCase().includes(q)
      || r.title.toLowerCase().includes(q)
      || (r.description ?? '').toLowerCase().includes(q)
  })

  // ── 移动布局（<768px）：表格在手机上不可用 ⇒ 卡片列表（信息与桌面列等价 + 「更多」动作菜单）。
  const emptyText = rows.length === 0
    ? '还没有指标。平台指标随数据面接入自动出现；本租户可基于平台指标新建派生指标。'
    : '没有匹配的指标，试试清空搜索或切换筛选'

  const confirmRemove = (r: MetricRow) => {
    Modal.confirm({
      title: `删除派生指标 ${r.id}？`, okText: '确认删除', cancelText: '取消',
      okButtonProps: { danger: true }, onOk: () => remove(r.id),
    })
  }

  interface SheetAction { key: string; label: string; danger?: boolean; onClick: () => void }
  const sheetActions = (r: MetricRow): SheetAction[] => [
    { key: 'history', label: '变更历史', onClick: () => openHistory(r.id) },
    { key: 'edit', label: '编辑', onClick: () => openEdit(r) },
    { key: 'meta', label: '元数据', onClick: () => openMeta(r) },
    { key: 'remove', label: '删除指标', danger: true, onClick: () => confirmRemove(r) },
  ]

  const mobileCards = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {visibleRows.length === 0 ? (
        <div style={{ color: '#999', textAlign: 'center', padding: '32px 0', lineHeight: 1.8 }}>{emptyText}</div>
      ) : visibleRows.map((r) => (
        <div key={r.id} style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: '#fff', borderRadius: 14, border: '1px solid #eee',
          padding: '14px 10px 14px 16px',
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <span style={{
                fontSize: 16, fontWeight: 600, lineHeight: 1.4,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{r.title}</span>
              {r.source === 'l1' ? <Tag color="blue">平台（只读）</Tag> : <Tag color="green">本租户派生</Tag>}
            </div>
            <div style={{ fontSize: 12, color: '#999', marginTop: 4, wordBreak: 'break-all' }}>{r.id}</div>
            <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>
              {r.requiredScope ?? '不限'} · 主体列 {r.subjectColumn}
              {r.source === 'l2' ? ` · v${r.version}` : ''}
              {r.source === 'l2' && r.updatedBy ? ` · ${r.updatedBy}` : ''}
            </div>
          </div>
          {r.source === 'l2' ? (
            <button
              type="button"
              aria-label="更多操作"
              onClick={() => setSheetFor(r)}
              style={{
                width: 44, height: 44, flex: '0 0 auto', borderRadius: 22,
                border: 'none', background: 'transparent', color: '#999',
                fontSize: 22, lineHeight: '44px', cursor: 'pointer',
              }}
            >⋯</button>
          ) : (
            <span style={{ fontSize: 12, color: '#bbb', width: 44, textAlign: 'center' }}>只读</span>
          )}
        </div>
      ))}
    </div>
  )

  const mobileFilterSheet = (
    <Drawer
      placement="bottom"
      open={filterOpen}
      onClose={() => setFilterOpen(false)}
      closable={false}
      title="筛选来源"
      height="auto"
      styles={{ body: { padding: '4px 0 16px' } }}
    >
      {SOURCE_OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => { setSourceFilter(o.value); setFilterOpen(false) }}
          style={{
            display: 'flex', justifyContent: 'space-between', width: '100%',
            padding: '15px 24px', border: 'none', background: 'none',
            textAlign: 'left', fontSize: 16, cursor: 'pointer',
            color: sourceFilter === o.value ? '#1677ff' : '#1f1f1f',
          }}
        >
          {o.label}
          {sourceFilter === o.value ? <span aria-hidden>✓</span> : null}
        </button>
      ))}
      <button
        type="button"
        onClick={() => setFilterOpen(false)}
        style={{
          display: 'block', width: '100%', padding: '15px 24px', marginTop: 8,
          border: 'none', borderTop: '1px solid #f0f0f0', background: '#fafafa',
          textAlign: 'center', cursor: 'pointer', fontSize: 16, color: '#666',
        }}
      >取消</button>
    </Drawer>
  )

  const mobileSheet = (
    <Drawer
      placement="bottom"
      open={sheetFor !== null}
      onClose={() => setSheetFor(null)}
      closable={false}
      title={sheetFor?.title}
      height="auto"
      styles={{ body: { padding: '4px 0 16px' } }}
    >
      {sheetFor !== null && sheetActions(sheetFor).map((a) => (
        <button
          key={a.key}
          type="button"
          onClick={() => { const fn = a.onClick; setSheetFor(null); fn() }}
          style={{
            display: 'block', width: '100%', padding: '15px 24px',
            border: 'none', background: 'none', textAlign: 'left', cursor: 'pointer',
            fontSize: 16, color: a.danger === true ? '#ff4d4f' : '#1f1f1f',
          }}
        >{a.label}</button>
      ))}
      <button
        type="button"
        onClick={() => setSheetFor(null)}
        style={{
          display: 'block', width: '100%', padding: '15px 24px', marginTop: 8,
          border: 'none', borderTop: '1px solid #f0f0f0', background: '#fafafa',
          textAlign: 'center', cursor: 'pointer', fontSize: 16, color: '#666',
        }}
      >取消</button>
    </Drawer>
  )

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {ctx}
      <Space wrap>
        <Button type="primary" onClick={() => openDeclaration('create', { id: '', title: '', description: '', expression: '', grain: [] })}>
          新建声明（全额口径）
        </Button>
        <Button onClick={openCreate} disabled={l1Rows.length === 0}>新建派生指标</Button>
        <Button onClick={() => { if (usageDays === null) openUsage(30); else openUsage(usageDays) }}>
          使用统计
        </Button>
        <Typography.Text type="secondary">
          全额声明与平台指标同表达力、<strong>即时生效</strong>；派生指标只能裁剪/别名/过滤平台指标。
          改动平台口径用行内「覆盖口径」（草稿需确认）。
        </Typography.Text>
      </Space>

      {isMobile ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <Input
            allowClear
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索指标 id / 标题 / 说明"
            style={{ flex: 1 }}
          />
          <Button onClick={() => setFilterOpen(true)} style={{ height: 44, paddingInline: 16 }}>
            {sourceFilter === 'all' ? '筛选' : SOURCE_OPTIONS.find((o) => o.value === sourceFilter)?.label}
          </Button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center' }}>
          <Input
            allowClear
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索指标 id / 标题 / 说明"
            style={{ width: 300 }}
          />
          <Segmented
            value={sourceFilter}
            onChange={(v) => setSourceFilter(v as typeof sourceFilter)}
            options={SOURCE_OPTIONS}
          />
        </div>
      )}

      {draft !== null && (
        <Card size="small" title={draft.id === '' ? '新建派生指标（L2）' : `编辑 ${draft.id}`}>
          <Space direction="vertical" style={{ width: '100%' }} size="small">
            <Input placeholder="指标 id（如 xiongmao:net_sales）" value={draft.id} maxLength={64}
                   disabled={rows.some((r) => r.id === draft.id && r.source === 'l2')}
                   onChange={(e) => setDraft({ ...draft, id: e.target.value })} />
            <Select style={{ width: '100%' }} placeholder="基于哪个平台指标（L1）" value={draft.baseMetric || undefined}
                    onChange={(v: string) => setDraft({ ...draft, baseMetric: v, dims: [] })}
                    options={l1Rows.map((r) => ({ value: r.id, label: `${r.id}（${r.title}）` }))} />
            <Input placeholder="别名（可选；不填则沿用平台指标的标题）" value={draft.alias} maxLength={128}
                   onChange={(e) => setDraft({ ...draft, alias: e.target.value })} />
            <Space>
              <Switch checked={draft.restrictDims}
                      onChange={(v: boolean) => setDraft({ ...draft, restrictDims: v })} />
              <Typography.Text>裁剪可见维度</Typography.Text>
              <Typography.Text type="secondary">
                （关闭 = 继承平台指标的全部维度：{baseDims.join(' / ') || '—'}）
              </Typography.Text>
            </Space>
            {draft.restrictDims && (
              <Select mode="multiple" style={{ width: '100%' }} placeholder="可见维度（不选 = 只看汇总值）"
                      value={draft.dims}
                      onChange={(v: string[]) => setDraft({ ...draft, dims: v })}
                      options={baseDims.map((d) => ({ value: d, label: d }))} />
            )}

            {draft.filters.map((f, i) => (
              <Space key={i}>
                <Select style={{ width: 180 }} placeholder="维度" value={f.dim || undefined}
                        onChange={(v: string) => setDraft({
                          ...draft,
                          filters: draft.filters.map((x, j) => (j === i ? { ...x, dim: v } : x)),
                        })}
                        options={baseDims.map((d) => ({ value: d, label: d }))} />
                <Select style={{ width: 80 }} value={f.op}
                        onChange={(v: '=' | 'in') => setDraft({
                          ...draft,
                          filters: draft.filters.map((x, j) => (j === i ? { ...x, op: v } : x)),
                        })}
                        options={[{ value: '=', label: '=' }, { value: 'in', label: 'in' }]} />
                <Input style={{ width: 240 }} placeholder="值（多个用英文逗号分隔）" value={f.values}
                       onChange={(e) => setDraft({
                         ...draft,
                         filters: draft.filters.map((x, j) => (j === i ? { ...x, values: e.target.value } : x)),
                       })} />
                <Button danger size="small"
                        onClick={() => setDraft({ ...draft, filters: draft.filters.filter((_, j) => j !== i) })}>
                  删除
                </Button>
              </Space>
            ))}
            <Space>
              <Button size="small"
                      onClick={() => setDraft({ ...draft, filters: [...draft.filters, { dim: '', op: '=', values: '' }] })}>
                添加过滤
              </Button>
              <Button size="small"
                      onClick={() => setDraft({ ...draft, filters: [] })} disabled={draft.filters.length === 0}>
                （清空过滤）
              </Button>
            </Space>

            <Space>
              <Button type="primary" onClick={submit} disabled={!draft.id.trim() || draft.baseMetric === ''}>保存</Button>
              <Button onClick={() => setDraft(null)}>取消</Button>
            </Space>
          </Space>
        </Card>
      )}

      {overrides.length > 0 && (
        <Card size="small" title={`本租户覆盖的平台口径（${overrides.length}）`}>
          <Space direction="vertical" style={{ width: '100%' }} size={6}>
            {overrides.map((o) => (
              <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Tag color={o.certified === 'certified' ? 'green' : 'gold'}>
                  {o.certified === 'certified' ? '已生效' : '草稿（未生效）'}
                </Tag>
                <Typography.Text strong>{o.title}</Typography.Text>
                <Typography.Text type="secondary">{o.id} · v{o.version}</Typography.Text>
                <span style={{ flex: 1 }} />
                {o.certified === 'draft' ? (
                  <Popconfirm title={`确认启用覆盖口径 ${o.id}？确认后本租户的查询改用该口径`}
                              okText="确认启用" cancelText="取消" onConfirm={() => confirmOverride(o.id)}>
                    <Button size="small" type="primary">确认启用</Button>
                  </Popconfirm>
                ) : null}
                <Popconfirm title={`删除覆盖 ${o.id}？（回落到平台口径）`}
                            okText="删除覆盖" cancelText="取消" onConfirm={() => deleteOverride(o.id)}>
                  <Button size="small" danger>删除覆盖</Button>
                </Popconfirm>
              </div>
            ))}
            <Typography.Text type="secondary">
              草稿对查询不可见（L1 继续生效）；确认后仅本租户改用覆盖口径，其他租户不受影响。
            </Typography.Text>
          </Space>
        </Card>
      )}

      {isMobile ? mobileCards : (
      <Table
        rowKey="id"
        dataSource={visibleRows}
        pagination={false}
        scroll={{ x: 1080 }}
        locale={{
          emptyText: rows.length === 0
            ? '还没有指标。平台指标随数据面接入自动出现；本租户可基于平台指标新建派生指标。'
            : '没有匹配的指标，试试清空搜索或切换筛选',
        }}
        columns={[
        { title: 'id', dataIndex: 'id', width: 180, ellipsis: { showTitle: true } },
        { title: '标题', dataIndex: 'title', ellipsis: { showTitle: true } },
        { title: '说明', dataIndex: 'description', ellipsis: { showTitle: true } },
        // 口径（单页双层，2026-11-12）：默认层给**业务说法**（元数据里的「业务描述」优先，退到说明），
        // 专业读者展开「技术细节」才看到表达式 / 维度 / 版本 / 权限码 / 覆盖来源。
        { title: '口径', width: 220, render: (_: unknown, r: MetricRow) => (
            <div style={{ minWidth: 0 }}>
              <Typography.Text ellipsis={{ tooltip: r.bizDescription ?? r.description }}>
                {r.bizDescription ?? (r.description !== '' ? r.description : '未标注')}
              </Typography.Text>
              <TechDetails>
                <div>表达式：{exprOf(r.selectSql) || r.selectSql}</div>
                <div>分组维度：{dimsOf(r).join('、') || '—'}</div>
                <div>所需权限：{r.requiredScope ?? '不限'}　主体列：{r.subjectColumn}</div>
                <div>版本：{r.source === 'l1' ? '平台物化（追溯走 git）' : `v${r.version}`}　最后操作人：{r.updatedBy ?? (r.source === 'l1' ? '平台物化' : '—')}</div>
                {r.overrideOf != null && <div>口径覆盖：本行覆盖平台指标 <code>{r.overrideOf}</code></div>}
                <div style={{ marginTop: 4, opacity: 0.75 }}>原始定义：{r.selectSql}</div>
              </TechDetails>
            </div>
        ) },
        // 来源：L1 = 平台词表（只读，改它要改 dbt 声明）；L2 = 本租户派生（可改可删）
        { title: '来源', dataIndex: 'source', width: 130, render: (v: string, r: MetricRow) =>
            v === 'l1'
              ? <Tag color="blue">平台（只读）</Tag>
              : r.basis === 'declared'
                ? <Tag color="purple">租户声明（全额）</Tag>
                : <Tag color="green">本租户派生</Tag> },
        { title: '所需 scope', dataIndex: 'requiredScope', width: 100, render: (v: string | null) => v ?? '不限' },
        // 主体列**显示出来**（只读）：它是主体钉死的依据，管理员必须能一眼看出这个指标按哪列隔离。
        { title: '主体列', dataIndex: 'subjectColumn', width: 80 },
        // #489 两列：谁最后动的、动过几次。L1 行**不显示空白**——空白会被读成「这里缺数据」，
        // 而真相是「平台口径的变更史在 git 里」（见 README 的边界一节）。
        { title: '最后操作人', dataIndex: 'updatedBy', ellipsis: { showTitle: true }, render: (v: string | null, r: MetricRow) =>
            r.source === 'l1'
              ? <Typography.Text type="secondary">平台物化（追溯走 git）</Typography.Text>
              : (v ?? '—') },
        { title: '版本', dataIndex: 'version', width: 60, render: (v: number, r: MetricRow) =>
            r.source === 'l1' ? <Typography.Text type="secondary">—</Typography.Text> : `v${v}` },
        { title: '操作', width: 260, render: (_: unknown, r: MetricRow) => (
            r.source === 'l1'
              ? (
                <Space>
                  <Typography.Text type="secondary">平台词表经 API 只读</Typography.Text>
                  <Button size="small" type="text" onClick={() => openDeclaration('override', seedOfL1(r))}>
                    覆盖口径
                  </Button>
                  <Button size="small" type="text" onClick={() => openHistory(r.id)}>变更历史</Button>
                </Space>
                )
              : (
                <Space>
                  <Button size="small" type="text" onClick={() => openHistory(r.id)}>变更历史</Button>
                  {r.basis === 'declared'
                    ? <Typography.Text type="secondary">全额声明（编辑请删除后重建）</Typography.Text>
                    : <Button size="small" type="text" onClick={() => openEdit(r)}>编辑</Button>}
                  {/* 元数据编辑只对 L2 开放（L1 平台口径，租户不得注解 ⇒ 后端 404，别放出假按钮） */}
                  {r.source === 'l2' && (
                    <Button size="small" type="text" onClick={() => openMeta(r)}>元数据</Button>
                  )}
                  {/* okText 显式写中文：Popconfirm 的默认 okText 取**locale**（未配 zh_CN 时是 "OK"），
                      而删除是不可逆动作——确认按钮上的字应当自己掌握，不随宿主是否配了 locale 漂。 */}
                  <Popconfirm title={`删除派生指标 ${r.id}？`} okText="确认删除" cancelText="取消"
                              onConfirm={() => remove(r.id)}>
                    <Button type="text" danger size="small">删除</Button>
                  </Popconfirm>
                </Space>
                )) },
      ]} />
      )}
      {isMobile ? mobileSheet : null}
      {isMobile ? mobileFilterSheet : null}

      {/* 变更史：#489。倒序（服务端已排好），删除行标红——它是不可逆的那一类。 */}
      <Drawer title={`变更历史：${historyId ?? ''}`} open={historyId !== null}
              onClose={() => setHistoryId(null)} width={520}>
        <Timeline items={history.map((a) => ({
          color: a.action === 'delete' ? 'red' : a.action === 'create' ? 'green' : a.action === 'certify' ? 'gold' : a.action === 'meta' ? 'purple' : 'blue',
          children: (
            <>
              <div>
                <Tag color={a.action === 'delete' ? 'red' : a.action === 'create' ? 'green' : a.action === 'certify' ? 'gold' : a.action === 'meta' ? 'purple' : 'blue'}>
                  {{ create: '新建', update: '修改', delete: '删除', certify: '可信度', meta: '元数据' }[a.action]}
                </Tag>
                {a.userId} · {a.channel} · {new Date(a.createdAt).toLocaleString('zh-CN')}
              </div>
              <Typography.Text type="secondary">
                {a.after
                  ? `→ ${a.after.description}`
                  : `（被删：${a.before?.description ?? ''}）`}
              </Typography.Text>
            </>
          ),
        }))} />
      </Drawer>

      {/* 使用统计（spec 2026-11-01 §10.4.3 P1）：窗口聚合 + 下线候选（读面，不下线动作） */}
      <Drawer title={`使用统计（窗口 ${usage?.days ?? usageDays ?? 30} 天）`} open={usageDays !== null}
              onClose={() => setUsageDays(null)} width={640}>
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Space>
            <Typography.Text>窗口：</Typography.Text>
            <Select style={{ width: 120 }} value={usageDays ?? 30}
                    onChange={(v: number) => openUsage(v)}
                    options={[{ value: 7, label: '7 天' }, { value: 30, label: '30 天' }, { value: 90, label: '90 天' }]} />
          </Space>
          {usage === null ? (
            <Typography.Text type="secondary">加载中…</Typography.Text>
          ) : (
            <>
              {usage.retireCandidates.length > 0 ? (
                <Card size="small" title={`下线候选（窗口内 0 次使用的自建指标，${usage.retireCandidates.length} 条）`}>
                  <Space direction="vertical" style={{ width: '100%' }} size={4}>
                    {usage.retireCandidates.map((c) => (
                      <div key={c.metricId}>
                        <Tag color="warning">候选</Tag>
                        <Typography.Text>{c.title}</Typography.Text>
                        <Typography.Text type="secondary">　{c.metricId} · 创建者 {c.createdBy ?? '（未知，028 前存量）'}</Typography.Text>
                        {/* 删除入口按 creator 门（#1294）：后端 DELETE 对非 creator 403，别放假按钮 */}
                        {c.createdBy !== null && c.createdBy === usage.self?.userId ? (
                          <Popconfirm title={`删除派生指标 ${c.metricId}？`} okText="确认删除" cancelText="取消"
                                      onConfirm={async () => { await remove(c.metricId); openUsage(usage.days) }}>
                            <Button danger size="small" style={{ marginLeft: 8 }}>删除</Button>
                          </Popconfirm>
                        ) : (
                          <Typography.Text type="secondary" style={{ marginLeft: 8 }}>仅创建者可删</Typography.Text>
                        )}
                      </div>
                    ))}
                    <Typography.Text type="secondary">
                      清单只读：下线动作走创建者的草稿流（删除），出现真实诉求再自动化（spec D7 口径）。
                    </Typography.Text>
                  </Space>
                </Card>
              ) : (
                <Typography.Text type="secondary">没有下线候选（窗口内每条自建指标都有使用）。</Typography.Text>
              )}
              <Table<UsageStat>
                key={`usage-${usage.days}`}
                size="small"
                rowKey="metricId"
                columns={[
                  { title: '指标', dataIndex: 'title', render: (_: unknown, r: UsageStat) => `${r.title}（${r.metricId}）` },
                  { title: '来源', key: 'source', width: 90,
                    render: (_: unknown, r: UsageStat) => r.source === 'l1' ? <Tag>平台</Tag> : <Tag color="blue">自建</Tag> },
                  { title: '查询次数', dataIndex: 'queries', width: 90, sorter: (a: UsageStat, b: UsageStat) => a.queries - b.queries },
                  { title: '去重用户', dataIndex: 'users', width: 90 },
                  { title: '最近使用', key: 'last', width: 170,
                    render: (_: unknown, r: UsageStat) => r.lastUsedAt === null
                      ? <Typography.Text type="secondary">窗口内未使用</Typography.Text>
                      : new Date(r.lastUsedAt).toLocaleString('zh-CN') },
                ]}
                dataSource={usage.stats}
                pagination={{ pageSize: 15, showSizeChanger: false, showTotal: (n: number) => `共 ${n} 条` }}
              />
            </>
          )}
        </Space>
      </Drawer>

      {/* 元数据编辑（§10.4.3 P1）：三个标注字段独立于口径——不经编译点，审计动作词 meta。 */}
      <DeclarationModal
        open={declOpen}
        mode={declMode}
        seed={declSeed}
        onCancel={() => setDeclOpen(false)}
        onSubmit={submitDeclaration}
      />

      <Modal title={`元数据：${metaDraft?.title ?? ''}`} open={metaDraft !== null}
             onCancel={() => setMetaDraft(null)} onOk={() => { void submitMeta() }} okText="保存">
        <Space direction="vertical" style={{ width: '100%' }} size="small">
          <div>
            <Typography.Text type="secondary">业务描述（这数怎么算、该拿它看什么）</Typography.Text>
            <Input.TextArea rows={2} maxLength={2000} value={metaDraft?.biz ?? ''}
                            onChange={(e) => setMetaDraft((d) => d === null ? d : { ...d, biz: e.target.value })} />
          </div>
          <div>
            <Typography.Text type="secondary">单位（元/单/件/人/%…）</Typography.Text>
            <Input maxLength={64} value={metaDraft?.unit ?? ''}
                   onChange={(e) => setMetaDraft((d) => d === null ? d : { ...d, unit: e.target.value })} />
          </div>
          <div>
            <Typography.Text type="secondary">口径说明（边界：含不含优惠/退货、统计窗口…）</Typography.Text>
            <Input.TextArea rows={2} maxLength={2000} value={metaDraft?.note ?? ''}
                            onChange={(e) => setMetaDraft((d) => d === null ? d : { ...d, note: e.target.value })} />
          </div>
          <Typography.Text type="secondary">
            空掉一个框 = 清空该字段；保存不走编译点，数字不变（审计记「元数据」动作）。
          </Typography.Text>
        </Space>
      </Modal>
    </Space>
  )
}
