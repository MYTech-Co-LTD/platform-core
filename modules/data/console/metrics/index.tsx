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
import { Button, Card, Input, Popconfirm, Select, Space, Switch, Table, Tag, Typography, message } from 'antd'
import { apiGet, apiSend, messageOf } from '../lib/api'

interface MetricRow {
  id: string
  title: string
  description: string
  requiredScope: string | null
  subjectColumn: string
  groupBy: string
  source: 'l1' | 'l2'
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
  const [draft, setDraft] = useState<Draft | null>(null)
  const [messageApi, ctx] = message.useMessage()

  const load = () => apiGet('/metrics/all')
    .then((b) => setRows((b as { metrics: MetricRow[] }).metrics))
    .catch((e) => messageApi.error(messageOf(e)))
  useEffect(() => { void load() }, [])

  const l1Rows = useMemo(() => rows.filter((r) => r.source === 'l1'), [rows])
  const base = useMemo(() => rows.find((r) => r.id === draft?.baseMetric), [rows, draft?.baseMetric])
  const baseDims = useMemo(() => dimsOf(base), [base])

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

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {ctx}
      <Space>
        <Button type="primary" onClick={openCreate} disabled={l1Rows.length === 0}>新建派生指标</Button>
        <Typography.Text type="secondary">
          派生指标只能**裁剪/别名/过滤**平台已声明的指标；口径本体改不了（要改口径请改 dbt 声明）。
        </Typography.Text>
      </Space>

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

      <Table rowKey="id" dataSource={rows} pagination={false} columns={[
        { title: 'id', dataIndex: 'id' },
        { title: '标题', dataIndex: 'title' },
        { title: '说明', dataIndex: 'description' },
        // 来源：L1 = 平台词表（只读，改它要改 dbt 声明）；L2 = 本租户派生（可改可删）
        { title: '来源', dataIndex: 'source', render: (v: string) =>
            v === 'l1' ? <Tag color="blue">平台（只读）</Tag> : <Tag color="green">本租户派生</Tag> },
        { title: '所需 scope', dataIndex: 'requiredScope', render: (v: string | null) => v ?? '不限' },
        // 主体列**显示出来**（只读）：它是主体钉死的依据，管理员必须能一眼看出这个指标按哪列隔离。
        { title: '主体列', dataIndex: 'subjectColumn' },
        { title: '操作', render: (_: unknown, r: MetricRow) => (
            r.source === 'l1'
              ? <Typography.Text type="secondary">平台词表经 API 只读</Typography.Text>
              : (
                <Space>
                  <Button size="small" onClick={() => openEdit(r)}>编辑</Button>
                  {/* okText 显式写中文：Popconfirm 的默认 okText 取**locale**（未配 zh_CN 时是 "OK"），
                      而删除是不可逆动作——确认按钮上的字应当自己掌握，不随宿主是否配了 locale 漂。 */}
                  <Popconfirm title={`删除派生指标 ${r.id}？`} okText="确认删除" cancelText="取消"
                              onConfirm={() => remove(r.id)}>
                    <Button danger size="small">删除</Button>
                  </Popconfirm>
                </Space>
                )) },
      ]} />
    </Space>
  )
}
