// console/metrics/index.tsx — 指标管理：词表（L1 平台 + L2 本租户）的只读浏览面。
//
// ── P4 人面收口（2026-11-13）──────────────────────────────────────────────────
// 所有**写**入口（编辑 / 元数据 / 删除指标 / 覆盖口径 / 新建声明）已从页面删除：
// 指标变更一律由 agent 经企微/MCP 提案，人在「待核对」页采纳（两步决策流）。
// 本页只剩读面 + 决策确认面：只读表格与详情抽屉、变更历史、使用统计、
// 覆盖清单的「确认启用 / 删除覆盖」——后者是采纳后的确认步，不是实现面。
import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Card, Drawer, Dropdown, Input, Popconfirm, Segmented, Select, Space, Table, Tag, Timeline, Typography, message } from 'antd'
import { apiGet, apiSend, messageOf } from '../lib/api'
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
  /** W8：测度档——declared = 租户全额声明（变更走 agent 提案，页面只读）。 */
  basis?: 'l1_tree' | 'column_agg' | 'declared'
  /** W8：非空 = 本行是对该 L1 id 的口径覆盖（草稿或已确认）。 */
  overrideOf?: string | null
  /** P1 Task 8a（047 列）：归属面——部门桶 / 概念 / 差异说明，只进口径展开层（默认层零新增词）。
   *  ownerDept/variantNote 由变更单写入（L1 恒 null）；entity L1 由物化带、L2 由变更单带。
   *  可选（与 overrideOf? 同一条理由）：历史响应缺键 = 未声明。 */
  ownerDept?: string | null
  entity?: string | null
  variantNote?: string | null
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
  // #489：变更历史抽屉。historyId=null 即关闭（不用额外一个 open 布尔量，避免两处状态打架）
  const [historyId, setHistoryId] = useState<string | null>(null)
  const [history, setHistory] = useState<AuditRow[]>([])
  // 使用统计抽屉（spec 2026-11-01 §10.4.3 P1）；null = 关（与 history 同款单状态惯例）
  const [usageDays, setUsageDays] = useState<number | null>(null)
  const [usage, setUsage] = useState<{
    days: number; stats: UsageStat[]; retireCandidates: RetireCandidate[]; self?: { userId: string }
  } | null>(null)
  // W8：覆盖清单（草稿不可见，单独拉）；「确认启用 / 删除覆盖」是两步决策流的确认步，保留
  const [overrides, setOverrides] = useState<OverrideRow[]>([])
  const [messageApi, ctx] = message.useMessage()
  // C 方案（2026-11-12 返工）：表格保持可扫，**详情进抽屉**——常驻右栏在「快速扫一遍」的用法下只是占地方。
  const [detailFor, setDetailFor] = useState<MetricRow | null>(null)
  // 候选指标的发现入口（#1953 四期）：候选不是「指标的子类」，而是**上游管道**——
  // 用户不会每天主动去翻管理面列表，所以在指标页顶部把「有待处理的」推到眼前。
  // 不做前端 scope 判断：该端点门是 data:manage，无码者拿 403 就静默不显示（入口姿态，
  // 真闸在 API）。这样也免了 useNavigate/useOutletContext —— 本页单测不套 Router。
  const [pendingCandidates, setPendingCandidates] = useState<number | null>(null)
  useEffect(() => {
    let alive = true
    apiGet('/metrics/candidates?limit=200&status=pending')
      .then((b) => { if (alive) setPendingCandidates(((b as { candidates?: unknown[] }).candidates ?? []).length) })
      .catch(() => { if (alive) setPendingCandidates(null) })
    return () => { alive = false }
  }, [])

  const load = () => Promise.all([apiGet('/metrics/all'), apiGet('/metrics/overrides')])
    .then(([all, ov]) => {
      setRows((all as { metrics: MetricRow[] }).metrics)
      setOverrides((ov as { overrides?: OverrideRow[] }).overrides ?? [])
    })
    .catch((e) => messageApi.error(messageOf(e)))
  useEffect(() => { void load() }, [])

  const l1Rows = useMemo(() => rows.filter((r) => r.source === 'l1'), [rows])
  const l2Rows = useMemo(() => rows.filter((r) => r.source === 'l2'), [rows])

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

  /** 从 L1 行的 select_sql 里反解表达式（详情抽屉展示用）。 */
  const exprOf = (sql: string): string => {
    const m = /^select\s+([\s\S]+?)\s+as\s+value/i.exec(sql.trim())
    return m?.[1]?.trim() ?? ''
  }
  async function confirmOverride(id: string) {
    try { await apiSend(`/metrics/${id}/override/confirm`, 'POST'); await load() }
    catch (e) { messageApi.error(messageOf(e)) }
  }
  async function deleteOverride(id: string) {
    try { await apiSend(`/metrics/${id}/override`, 'DELETE'); await load() }
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
    ? '还没有指标。平台指标随数据面接入自动出现；新指标在企微里对机器人说一声，或经 MCP 提交。'
    : '没有匹配的指标，试试清空搜索或切换筛选'

  // 移动端「更多」面板（P4）：写入口已删，只剩只读的变更历史
  interface SheetAction { key: string; label: string; onClick: () => void }
  const sheetActions = (r: MetricRow): SheetAction[] => [
    { key: 'history', label: '变更历史', onClick: () => openHistory(r.id) },
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
            fontSize: 16, color: '#1f1f1f',
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
      {pendingCandidates !== null && pendingCandidates > 0 && (
        <Alert
          type="info"
          showIcon
          message={`${pendingCandidates}${pendingCandidates >= 200 ? '+' : ''} 个候选指标待采用`}
          action={<Button size="small" href="/console/data/candidates">去查看</Button>}
        />
      )}
      {/* 关键数字条（2026-11-13 布局优化）：先给「有多少」，再给明细。
          数字等宽、标签小而灰——DeepSeek 风格的「数据优先」落点。 */}
      <div style={{ display: 'flex', gap: 40, alignItems: 'flex-end', padding: '4px 2px 8px' }}>
        {[
          { k: '平台指标', v: l1Rows.length, d: '随数据面接入自动更新' },
          { k: '本租户派生', v: l2Rows.length, d: '由 agent 提案创建' },
          { k: '待采用候选', v: pendingCandidates, d: pendingCandidates === null ? '—' : '采用后成为正式指标' },
        ].map((x) => (
          <div key={x.k} style={{ minWidth: 110 }}>
            <div style={{ fontSize: 12, color: '#9AA0A6' }}>{x.k}</div>
            <div style={{
              fontSize: 28, fontWeight: 600, lineHeight: 1.2, letterSpacing: '-0.02em',
              fontVariantNumeric: 'tabular-nums', color: '#1B1C1E',
            }}>{x.v === null ? '—' : x.v >= 200 ? '200+' : x.v}</div>
            <div style={{ fontSize: 12, color: '#6B7280', marginTop: 2 }}>{x.d}</div>
          </div>
        ))}
      </div>

      {/* 常驻教程删掉了（#2058）：指标从哪来属于「第一次看见空列表」时才需要的信息，
          放在空态里；有数据时不该占一整行文字。 */}
      <div>
        <Button onClick={() => { if (usageDays === null) openUsage(30); else openUsage(usageDays) }}>
          使用统计
        </Button>
        <Typography.Text type="secondary">
          指标变更一律由 agent 提案（企微/MCP），在这里的『待核对』页采纳。
        </Typography.Text>
      </div>

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
        locale={{ emptyText }}
        columns={[
        // 列**收窄到 5 列**（#2050 返工）：说明/口径全文/权限/主体列/版本这些「读一次」的信息
        // 进详情抽屉，表格只留「扫一遍」要用的。每行也不再堆操作链接——主操作 + ⋯ 菜单。
        { title: '指标', dataIndex: 'title', render: (_: unknown, r: MetricRow) => (
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 500 }}>{r.title}</div>
              <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, color: '#8c8c8c', marginTop: 2 }}>{r.id}</div>
            </div>
        ) },
        { title: '口径', dataIndex: 'description', ellipsis: { showTitle: true }, render: (_: unknown, r: MetricRow) =>
            r.bizDescription ?? (r.description !== '' ? r.description : '未标注') },
        // 来源：L1 = 平台词表（只读，改它要改 dbt 声明）；L2 = 本租户派生（变更走 agent 提案）
        // 来源：与成员页同一套「圆点 + 文字」——色块会把整列染花，数据行只该有一个视觉锚点
        { title: '来源', dataIndex: 'source', width: 130, render: (v: string, r: MetricRow) => {
            const label = v === 'l1' ? '平台（只读）' : r.basis === 'declared' ? '租户声明（全额）' : '本租户派生'
            const color = v === 'l1' ? '#C9CDD4' : r.basis === 'declared' ? '#4D6BFE' : '#0FA958'
            return (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#1B1C1E' }}>
                <i style={{ width: 6, height: 6, borderRadius: '50%', background: color, display: 'inline-block' }} />
                {label}
              </span>
            )
        } },
        { title: '更新', key: 'updated', width: 180, render: (_: unknown, r: MetricRow) =>
            r.source === 'l1'
              ? <Typography.Text type="secondary">平台物化</Typography.Text>
              : <Typography.Text type="secondary">{r.updatedBy ?? '—'} · v{r.version}</Typography.Text> },
        { title: '操作', width: 150, render: (_: unknown, r: MetricRow) => (
            <Space size={4}>
              <Button size="small" type="link" onClick={() => setDetailFor(r)}>详情</Button>
              <Dropdown
                trigger={['click']}
                menu={{
                  // P4：写入口已删——两层的「⋯」都只剩只读的变更历史
                  items: [{ key: 'history', label: '变更历史' }],
                  onClick: ({ key }) => {
                    if (key === 'history') openHistory(r.id)
                  },
                }}
              >
                <Button size="small" type="text" aria-label="更多操作">⋯</Button>
              </Dropdown>
            </Space>
        ) },
      ]} />
      )}
      {isMobile ? mobileSheet : null}
      {isMobile ? mobileFilterSheet : null}

      {/* 详情抽屉（#2050 返工）：口径全文 / 技术细节 / 属性 / 全部操作。
          表格只负责扫，读一次的东西都收在这里。 */}
      <Drawer
        title={detailFor ? detailFor.title : ''}
        open={detailFor !== null}
        onClose={() => setDetailFor(null)}
        width={520}
      >
        {detailFor !== null && (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, color: '#8c8c8c' }}>
              {detailFor.id}
            </div>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>口径</Typography.Text>
              <div style={{ marginTop: 4 }}>{detailFor.bizDescription ?? (detailFor.description !== '' ? detailFor.description : '未标注')}</div>
              <TechDetails>
                <div>表达式：{exprOf(detailFor.selectSql) || (detailFor.selectSql ?? '—')}</div>
                <div>分组维度：{dimsOf(detailFor).join('、') || '—'}</div>
                <div>所需权限：{detailFor.requiredScope ?? '不限'}　主体列：{detailFor.subjectColumn}</div>
                <div>版本：{detailFor.source === 'l1' ? '平台物化（追溯走 git）' : `v${detailFor.version}`}　最后操作人：{detailFor.updatedBy ?? (detailFor.source === 'l1' ? '平台物化' : '—')}</div>
                {/* 归属面（P1 Task 8a，047 列）：只进展开层（默认层零新增词）；缺席 = 未声明 → —，不编默认值 */}
                <div>归属部门：{detailFor.ownerDept ?? '—'}</div>
                <div>概念：{detailFor.entity ?? '—'}</div>
                <div>差异说明：{detailFor.variantNote ?? '—'}</div>
                {detailFor.overrideOf != null && <div>口径覆盖：本行覆盖平台指标 <code>{detailFor.overrideOf}</code></div>}
                <div style={{ marginTop: 4, opacity: 0.75 }}>原始定义：{detailFor.selectSql ?? '—'}</div>
              </TechDetails>
            </div>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>属性</Typography.Text>
              <div style={{ marginTop: 4, lineHeight: 2 }}>
                来源：{detailFor.source === 'l1' ? '平台口径（只读，改它要改 dbt 声明）' : detailFor.basis === 'declared' ? '租户声明（全额）' : '本租户派生（变更由 agent 提案）'}<br />
                所需权限：{detailFor.requiredScope ?? '不限'}　主体列：{detailFor.subjectColumn}<br />
                版本：{detailFor.source === 'l1' ? '平台物化' : `v${detailFor.version}`}
              </div>
            </div>
            <Space wrap>
              {/* P4：写入口已删——抽屉里只剩只读动作 */}
              <Button onClick={() => { openHistory(detailFor.id); setDetailFor(null) }}>变更历史</Button>
            </Space>
          </Space>
        )}
      </Drawer>

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
                      </div>
                    ))}
                    <Typography.Text type="secondary">
                      清单只读：下线由 agent 提案、在「待核对」页采纳（P4 人面收口）。
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
    </Space>
  )
}
