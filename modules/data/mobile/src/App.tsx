// App.tsx — 移动端「所有指标」页（spec 2026-11-01 §10.2 判定表 / §10.4.2 P0）。
//
// 判定（与后端同一张表，页面只做**呈现**，授权在后端）：
//   · L1：只读卡片（来源=平台口径），管理入口不出现
//   · L2 且 createdBy = 我：可编辑（草稿 → 确认走唯一编译点）
//   · L2 非我创建：只读
// 徽标：certified（平台认证/草稿）+ 新鲜度（绿 SLA 内 / 黄 偏慢 / 红 滞后 / 灰 未知）。
// 「数据至 M月D日」的口径与后端固定行同源（watermark 是日历日，+8 不吃钟点）。
import { useCallback, useEffect, useState } from 'react'
import { Button, Input, Popup, SpinLoading, TextArea, Tag, Toast } from 'antd-mobile'
import { apiGet, apiSend, ApiError } from './api'

interface MetricItem {
  id: string
  title: string
  description: string
  certified?: 'certified' | 'draft'
  /** 元数据三件套（030，§10.4.3）：null = 未标注。 */
  bizDescription?: string | null
  unit?: string | null
  caliberNote?: string | null
  source?: 'l1' | 'l2'
  createdBy?: string | null
  freshness?: { status: 'normal' | 'late' | 'alert'; watermark: string | null }
}

interface MetricsResponse {
  metrics: MetricItem[]
  /** scopes ∋ data:manage ⇒ 认证升降动作可见（唯一事实源：requester 的既有投影，不引第二套身份面）。 */
  self?: { userId: string; scopes?: string[] }
}

/** `YYYY-MM-DD` → `M月D日`（后端 formatHumanDay 同款人话形态）。 */
function humanDay(iso: string): string {
  const [, m, d] = iso.split('-')
  return `${Number(m)}月${Number(d)}日`
}

const FRESHNESS_LABEL: Record<string, { text: string; color: string }> = {
  normal: { text: '正常', color: '#00b578' },
  late: { text: '偏慢', color: '#ff8f1f' },
  alert: { text: '滞后', color: '#fa3150' },
}

function FreshnessBadge({ m }: { m: MetricItem }) {
  const f = m.freshness
  if (f === undefined) return <span style={{ fontSize: 12, color: '#999' }}>新鲜度未知</span>
  const label = FRESHNESS_LABEL[f.status] ?? { text: '未知', color: '#999' }
  const till = f.watermark !== null ? `· 数据至 ${humanDay(f.watermark)}` : ''
  return <span style={{ fontSize: 12, color: label.color }}>● {label.text} {till}</span>
}

/** 算式条的一个「项」（#1298）：两枚小按钮切「指标 / 数字」，移动端零层级。 */
function ExprTermRow({ term, onChange, bases }: {
  term: ExprTerm
  onChange: (t: ExprTerm) => void
  bases: MetricItem[]
}) {
  const toRef = () => onChange(term.kind === 'ref' ? term : { kind: 'ref', id: bases[0]?.id ?? '' })
  const toNum = () => onChange(term.kind === 'num' ? term : { kind: 'num', value: 1 })
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <Button size='mini' fill={term.kind === 'ref' ? 'solid' : 'none'} color='primary' onClick={toRef}>指标</Button>
      <Button size='mini' fill={term.kind === 'num' ? 'solid' : 'none'} color='primary' onClick={toNum}>数字</Button>
      {term.kind === 'ref' ? (
        <select value={term.id} onChange={(e) => onChange({ kind: 'ref', id: e.target.value })}
                style={{ flex: 1, padding: 8, borderRadius: 8, border: '1px solid #ddd', fontSize: 14, background: '#fff' }}>
          {bases.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
        </select>
      ) : (
        <Input type='number' style={{ flex: 1 }} placeholder='数字'
               value={Number.isFinite(term.value) || term.value === 0 ? String(term.value) : ''}
               onChange={(v) => onChange({ kind: 'num', value: v.trim() === '' ? Number.NaN : Number(v) })} />
      )}
    </div>
  )
}

/** 算式条整体（两操作数 + 一个运算符；复合公式走 API——边界写在注释与 UI 说明里）。 */
function ExprFormulaBar({ left, op, right, setLeft, setOp, setRight, bases }: {
  left: ExprTerm; op: ExprOp; right: ExprTerm
  setLeft: (t: ExprTerm) => void; setOp: (o: ExprOp) => void; setRight: (t: ExprTerm) => void
  bases: MetricItem[]
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <ExprTermRow term={left} onChange={setLeft} bases={bases} />
      <div style={{ display: 'flex', gap: 8 }}>
        {(Object.keys(OP_LABEL) as ExprOp[]).map((o) => (
          <Button key={o} size='mini' fill={op === o ? 'solid' : 'outline'} color='primary' onClick={() => setOp(o)}>
            {OP_LABEL[o]}
          </Button>
        ))}
      </div>
      <ExprTermRow term={right} onChange={setRight} bases={bases} />
      <div style={{ fontSize: 12, color: '#999' }}>两操作数算式；三项以上复合公式请走 API（移动端 V1 不做嵌套/括号）。</div>
    </div>
  )
}

// ── 表达式指标（expr，spec 2026-11-01 §10.4 遗留项；#1298）─────────────────────
// V1 = **两操作数算式条**（用户拍板「适配移动端、别搞太复杂」）：不做嵌套树 UI——
// 优先级/括号一进 UI 复杂度立刻失控；复合多步公式保留 API 通路（POST /metrics 的 expr 档）。
// 编译器词表（semantic-compiler ExprNode）：ref | num | {add,sub,mul,div,left,right}。
export type ExprTerm = { kind: 'ref'; id: string } | { kind: 'num'; value: number }
export type ExprOp = 'add' | 'sub' | 'mul' | 'div'
export interface ExprNodeBox { kind: ExprOp; left: ExprTerm; right: ExprTerm }

/** 两操作数 → ExprNode（恰好一层；与编译器词表逐字同形）。 */
export function composeExpr(left: ExprTerm, op: ExprOp, right: ExprTerm): ExprNodeBox {
  return { kind: op, left, right }
}

/** 项是否可提交：ref 要有 id、num 要是有限数（空串/NaN 不发请求）。 */
export function validTerm(t: ExprTerm): boolean {
  return t.kind === 'ref' ? t.id !== '' : Number.isFinite(t.value)
}

const OP_LABEL: Record<ExprOp, string> = { add: '+', sub: '−', mul: '×', div: '÷' }

export default function App() {
  const [data, setData] = useState<MetricsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 编辑中的 L2 id（null = 编辑器关着） */
  const [editing, setEditing] = useState<MetricItem | null>(null)
  /** 元数据编辑中的 L2 id（#1284 的 PUT /metrics/:id/meta；null = 关） */
  const [metaEditing, setMetaEditing] = useState<MetricItem | null>(null)
  /** 新建表达式指标弹窗（#1298；POST /metrics 需 data:manage，入口按 isAdmin 显隐） */
  const [creatingExpr, setCreatingExpr] = useState(false)

  const reload = useCallback(async () => {
    try {
      setData(await apiGet<MetricsResponse>('/api/modules/data/metrics'))
      setError(null)
    } catch (e) {
      // 401 = api.ts 已经在跳静默授权；其余错误才值得显示
      if (!(e instanceof ApiError && e.status === 401)) {
        setError('加载失败，请稍后重试')
      }
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const self = data?.self?.userId
  const isMine = (m: MetricItem): boolean => m.source === 'l2' && m.createdBy !== undefined && m.createdBy !== null && m.createdBy === self
  /** 管理员动作门（spec §10.4 D7）：认证升降是 data:manage 的事——L1 恒 certified（读侧推导）不给按钮。 */
  const isAdmin = (data?.self?.scopes ?? []).includes('data:manage')

  /** 认证升降（PUT /metrics/:id/certified；reversible 动作，直接点不弹确认）。 */
  const toggleCertified = async (m: MetricItem): Promise<void> => {
    const next = m.certified === 'certified' ? 'draft' : 'certified'
    try {
      await apiSend('PUT', `/api/modules/data/metrics/${encodeURIComponent(m.id)}/certified`, { certified: next })
      Toast.show({ content: next === 'certified' ? '已标记为平台认证' : '已撤回认证标记' })
      void reload()
    } catch (e) {
      if (e instanceof ApiError) Toast.show({ content: e.status === 403 ? '没有数据指标管理权限' : `操作失败（${e.status}）` })
      else Toast.show({ content: '网络异常，请重试' })
    }
  }

  if (error !== null) return <div style={{ padding: 32, textAlign: 'center', color: '#999' }}>{error}</div>
  if (data === null) return <div style={{ padding: 48, textAlign: 'center' }}><SpinLoading /></div>

  const metrics = data.metrics ?? []
  const bases = metrics.filter((m) => m.source === 'l1')

  return (
    <div style={{ padding: 12, paddingBottom: 32 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: '4px 0 12px', fontSize: 18 }}>指标</h3>
        {isAdmin ? (
          <Button size='small' color='primary' fill='outline' onClick={() => setCreatingExpr(true)}>新建表达式指标</Button>
        ) : null}
      </div>
      {metrics.length === 0 ? (
        <div style={{ color: '#999', textAlign: 'center', padding: 32 }}>没有可见的指标（需要管理员开通数据问数权限）。</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {metrics.map((m) => (
            <div key={m.id} style={{ background: '#fff', borderRadius: 12, padding: 14, border: '1px solid #f0f0f0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 16, fontWeight: 600 }}>{m.title}</span>
                <span>
                  {m.source === 'l1'
                    ? <Tag color='primary' fill='outline' style={{ '--background-color': '#fff' }}>平台口径</Tag>
                    : <Tag color='default' fill='outline' style={{ '--background-color': '#fff' }}>自建</Tag>}
                  {isMine(m) ? <Tag color='warning' fill='outline' style={{ '--background-color': '#fff', marginLeft: 4 }}>我的</Tag> : null}
                </span>
              </div>
              <div style={{ fontSize: 12, color: '#666', margin: '6px 0', whiteSpace: 'pre-wrap' }}>{m.description}</div>
              {/* 元数据（§10.4.3，#1292）：业务描述 + 单位给看数人读；未标注 = 灰字「未标注」（不编默认值）。 */}
              <div style={{ fontSize: 12, margin: '4px 0', color: m.bizDescription ? '#444' : '#aaa' }}>
                {(m.bizDescription ? `业务描述：${m.bizDescription}` : '业务描述：未标注')
                  + (m.unit ? ` · 单位：${m.unit}` : '')}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <FreshnessBadge m={m} />
                <span>
                  {m.certified === 'certified' ? <Tag color='success' fill='outline' style={{ '--background-color': '#fff' }}>平台认证</Tag> : null}
                  {m.certified === 'draft' ? <Tag color='warning' fill='outline' style={{ '--background-color': '#fff' }}>未认证</Tag> : null}
                  {isAdmin && m.source === 'l2' ? (
                    <Button size='mini' fill='none' style={{ padding: 0, marginLeft: 6 }}
                            onClick={() => void toggleCertified(m)}>
                      {m.certified === 'certified' ? '撤回认证' : '标记认证'}
                    </Button>
                  ) : null}
                </span>
              </div>
              {/* 管理入口只出现在自己的 L2 上（判定表：L1 只读、非我创建只读） */}
              {isMine(m) ? (
                <div style={{ marginTop: 8, display: 'flex', gap: 14 }}>
                  <Button size='small' color='primary' fill='none' style={{ padding: 0 }}
                          onClick={() => setEditing(m)}>
                    编辑草稿
                  </Button>
                  <Button size='small' fill='none' style={{ padding: 0 }}
                          onClick={() => setMetaEditing(m)}>
                    元数据
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
      <DraftSheet metric={editing} bases={bases} onClose={() => setEditing(null)} onDone={() => { setEditing(null); void reload() }} />
      <MetaSheet metric={metaEditing} onClose={() => setMetaEditing(null)} onDone={() => { setMetaEditing(null); void reload() }} />
      <CreateExprSheet open={creatingExpr} bases={bases} onClose={() => setCreatingExpr(false)}
                       onDone={() => { setCreatingExpr(false); void reload() }} />
    </div>
  )
}

/**
 * 草稿编辑器：「裁剪（refine，当年唯一档）/ 表达式（expr，两操作数算式条，#1298）」两种声明形态。
 * 「保存草稿」只写 draft_spec（数字不变）；「确认生效」走唯一编译点（数字对全租户变更）。
 * 错误契约照 routes/metrics.ts：NOT_EDITABLE / INVALID_DRAFT / DRAFT_CHANGED_RETRY。
 */
function DraftSheet({ metric, bases, onClose, onDone }: {
  metric: MetricItem | null
  bases: MetricItem[]
  onClose: () => void
  onDone: () => void
}) {
  const [alias, setAlias] = useState('')
  const [baseId, setBaseId] = useState('')
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'refine' | 'expr'>('refine')
  const [op, setOp] = useState<ExprOp>('add')
  const [left, setLeft] = useState<ExprTerm>({ kind: 'ref', id: '' })
  const [right, setRight] = useState<ExprTerm>({ kind: 'num', value: 1 })

  useEffect(() => {
    if (metric !== null) {
      setAlias(metric.title); setBaseId(bases[0]?.id ?? '')
      setMode('refine'); setOp('add')
      setLeft({ kind: 'ref', id: bases[0]?.id ?? '' })
      setRight({ kind: 'num', value: 1 })
    }
  }, [metric, bases])

  const fail = (e: unknown): void => {
    if (e instanceof ApiError) {
      const code = typeof e.body.error === 'string' ? e.body.error : ''
      const msg: Record<string, string> = {
        NOT_EDITABLE: '只有创建者本人可以管理这条指标',
        INVALID_DRAFT: '草稿声明不合法，请检查后重试',
        DRAFT_CHANGED_RETRY: '草稿刚被其他窗口更新，请重试',
        METRIC_SOURCE_NOT_ADOPTED: '基底指标的数据源本租户未接入',
        L1_BASE_NOT_FOUND: '基底指标不存在或不可见',
        L2_BASE_MASKED: '基底带值级掩码，不能派生',
      }
      Toast.show({ content: msg[code] ?? `操作失败（${e.status}）` })
      return
    }
    Toast.show({ content: '网络异常，请重试' })
  }

  if (metric === null) return null

  const exprReady = validTerm(left) && validTerm(right)
  const saveDraft = async (): Promise<void> => {
    setBusy(true)
    try {
      const draftSpec = mode === 'expr'
        ? { op: { kind: 'expr', expr: composeExpr(left, op, right) }, ...(alias.trim() !== '' ? { alias: alias.trim() } : {}) }
        : { baseMetric: baseId, op: { kind: 'refine' }, alias }
      await apiSend('PUT', `/api/modules/data/metrics/${encodeURIComponent(metric.id)}/draft`, { draftSpec })
      Toast.show({ content: '草稿已保存（未生效）' })
    } catch (e) { fail(e) } finally { setBusy(false) }
  }

  const confirm = async (): Promise<void> => {
    setBusy(true)
    try {
      await apiSend('POST', `/api/modules/data/metrics/${encodeURIComponent(metric.id)}/confirm-draft`, {})
      Toast.show({ content: '已确认生效，看数人会收到变更通知' })
      onDone()
    } catch (e) { fail(e) } finally { setBusy(false) }
  }

  return (
    <Popup visible bodyStyle={{ borderTopLeftRadius: 12, borderTopRightRadius: 12, padding: 16, minHeight: 260 }}
           onClose={onClose}>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>编辑草稿：{metric.title}</div>
      <div style={{ fontSize: 13, color: '#666', marginBottom: 12 }}>
        草稿保存后数字不变；点「确认生效」才对全租户变更（会通知看数人）。
      </div>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 13, color: '#999', marginBottom: 4 }}>指标名</div>
        <Input placeholder='显示名' value={alias} onChange={setAlias} clearable />
      </div>
      <div style={{ marginBottom: 10, display: 'flex', gap: 8 }}>
        <Button size='small' fill={mode === 'refine' ? 'solid' : 'outline'} color='primary'
                onClick={() => setMode('refine')}>裁剪</Button>
        <Button size='small' fill={mode === 'expr' ? 'solid' : 'outline'} color='primary'
                onClick={() => setMode('expr')}>表达式</Button>
      </div>
      {mode === 'refine' ? (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, color: '#999', marginBottom: 4 }}>基底指标（平台口径）</div>
          <select value={baseId} onChange={(e) => setBaseId(e.target.value)}
                  style={{ width: '100%', padding: 8, borderRadius: 8, border: '1px solid #ddd', fontSize: 14, background: '#fff' }}>
            {bases.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
          </select>
        </div>
      ) : (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, color: '#999', marginBottom: 4 }}>算式（两操作数）</div>
          <ExprFormulaBar left={left} op={op} right={right}
                          setLeft={setLeft} setOp={setOp} setRight={setRight} bases={bases} />
        </div>
      )}
      <div style={{ display: 'flex', gap: 10 }}>
        <Button block color='default' disabled={busy || (mode === 'expr' && !exprReady)} onClick={() => void saveDraft()}>保存草稿</Button>
        <Button block color='primary' disabled={busy || (mode === 'refine' ? baseId === '' : !exprReady)} loading={busy} onClick={() => void confirm()}>确认生效</Button>
      </div>
    </Popup>
  )
}

/**
 * 元数据编辑弹窗（spec §10.4.3，#1292）：creator 在移动端标注自己的 L2。
 * 写路径复用 #1284 的 PUT /metrics/:id/meta（写闸 manage ∪ creator 在域层）；空串 = 清空，
 * 与后端 clean 口径一致。只对自己创建的 L2 开放（入口在 isMine 分支内）。
 */
function MetaSheet({ metric, onClose, onDone }: {
  metric: MetricItem | null
  onClose: () => void
  onDone: () => void
}) {
  const [biz, setBiz] = useState('')
  const [unit, setUnit] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (metric !== null) { setBiz(metric.bizDescription ?? ''); setUnit(metric.unit ?? ''); setNote(metric.caliberNote ?? '') }
  }, [metric])

  const fail = (e: unknown): void => {
    if (e instanceof ApiError) {
      const code = typeof e.body.error === 'string' ? e.body.error : ''
      Toast.show({ content: code === 'NOT_METRIC_CREATOR' ? '只有创建者本人或管理员可以标注' : `操作失败（${e.status}）` })
      return
    }
    Toast.show({ content: '网络异常，请重试' })
  }

  if (metric === null) return null

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await apiSend('PUT', `/api/modules/data/metrics/${encodeURIComponent(metric.id)}/meta`,
        { bizDescription: biz.trim(), unit: unit.trim(), caliberNote: note.trim() })
      Toast.show({ content: '元数据已保存（数字不变）' })
      onDone()
    } catch (e) { fail(e) } finally { setBusy(false) }
  }

  return (
    <Popup visible bodyStyle={{ borderTopLeftRadius: 12, borderTopRightRadius: 12, padding: 16, minHeight: 240 }}
           onClose={onClose}>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>元数据：{metric.title}</div>
      <div style={{ fontSize: 13, color: '#666', marginBottom: 12 }}>标注不改口径，数字不变（空掉一个框 = 清空该字段）。</div>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 13, color: '#999', marginBottom: 4 }}>业务描述（这数怎么算、该拿它看什么）</div>
        <TextArea rows={2} maxLength={2000} value={biz} onChange={(v) => setBiz(v ?? '')} placeholder='给看数人读的话' />
      </div>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 13, color: '#999', marginBottom: 4 }}>单位（元/单/件/%…）</div>
        <Input maxLength={64} value={unit} onChange={setUnit} clearable />
      </div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: '#999', marginBottom: 4 }}>口径说明（边界：含不含优惠/退货、统计窗口…）</div>
        <TextArea rows={2} maxLength={2000} value={note} onChange={(v) => setNote(v ?? '')} placeholder='读数前的边界提示' />
      </div>
      <Button block color='primary' disabled={busy} loading={busy} onClick={() => void save()}>保存元数据</Button>
    </Popup>
  )
}

/**
 * 新建表达式指标（#1298）：id + 别名 + 两操作数算式 → POST /metrics（expr 声明）。
 * 门在宿主（data:manage，manifest 申报）；入口仅在 isAdmin 时渲染——别给普通人放假按钮。
 * 复合多步公式走 API（移动端 V1 边界，见 ExprFormulaBar 注）。
 */
function CreateExprSheet({ open, bases, onClose, onDone }: {
  open: boolean
  bases: MetricItem[]
  onClose: () => void
  onDone: () => void
}) {
  const [id, setId] = useState('')
  const [alias, setAlias] = useState('')
  const [op, setOp] = useState<ExprOp>('add')
  const [left, setLeft] = useState<ExprTerm>({ kind: 'ref', id: '' })
  const [right, setRight] = useState<ExprTerm>({ kind: 'num', value: 1 })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setId(''); setAlias(''); setOp('add')
      setLeft({ kind: 'ref', id: bases[0]?.id ?? '' })
      setRight({ kind: 'num', value: 1 })
    }
  }, [open, bases])

  if (!open) return null

  const ready = id.trim() !== '' && validTerm(left) && validTerm(right)

  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      await apiSend('POST', '/api/modules/data/metrics', {
        id: id.trim(),
        op: { kind: 'expr', expr: composeExpr(left, op, right) },
        ...(alias.trim() !== '' ? { alias: alias.trim() } : {}),
      })
      Toast.show({ content: '表达式指标已创建' })
      onDone()
    } catch (e) {
      if (e instanceof ApiError) {
        const code = typeof e.body.error === 'string' ? e.body.error : ''
        const msg: Record<string, string> = {
          INVALID_BODY: '声明不合法（id 1–64 字符；数字须为有限数）',
          ID_RESERVED_BY_L1: '这个 id 属于平台口径，换一个',
          L1_BASE_NOT_FOUND: '引用的指标不存在或不可见',
          METRIC_SOURCE_NOT_ADOPTED: '引用的指标数据源本租户未接入',
          L2_BASE_MASKED: '被引用的指标带值级掩码，不能派生',
        }
        Toast.show({ content: msg[code] ?? `创建失败（${e.status}）` })
      } else {
        Toast.show({ content: '网络异常，请重试' })
      }
    } finally { setBusy(false) }
  }

  return (
    <Popup visible bodyStyle={{ borderTopLeftRadius: 12, borderTopRightRadius: 12, padding: 16, minHeight: 300 }}
           onClose={onClose}>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>新建表达式指标</div>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 13, color: '#999', marginBottom: 4 }}>指标 id（英数/冒号，如 xiongmao:gross_margin）</div>
        <Input placeholder='指标 id' value={id} maxLength={64} onChange={setId} clearable />
      </div>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 13, color: '#999', marginBottom: 4 }}>别名（可选）</div>
        <Input placeholder='显示名' value={alias} onChange={setAlias} clearable />
      </div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: '#999', marginBottom: 4 }}>算式（两操作数）</div>
        <ExprFormulaBar left={left} op={op} right={right}
                        setLeft={setLeft} setOp={setOp} setRight={setRight} bases={bases} />
      </div>
      <Button block color='primary' disabled={busy || !ready} loading={busy} onClick={() => void submit()}>
        创建
      </Button>
    </Popup>
  )
}
