// console/Rounds.tsx — 收集轮次管理页（件③ / issue #2707）。
// 名单轮（按人收）/ 值集轮（按格子收）：列表（key/kind/状态/进度）+ 新建 + 开轮/关轮 + 逐项详情。
// 照 console 表格页 UX 约定（docs/design/console-ui-conventions.md）：Card + Table size="small"、
// 空态给下一步、先刷新再提示、开轮/关轮用 loading 锁重复点击。
import { useEffect, useState } from 'react'
import {
  Alert, Button, Card, Descriptions, Empty, Form, Input, Modal, Progress, Radio, Select,
  Space, Table, Tag, Typography,
} from 'antd'
import { useOutletContext } from 'react-router-dom'
import {
  ApiError, closeRound, createRound, getRound, listRounds, openRound,
} from './api'
import type { DefSummary, RoundDetailView, RoundRow } from './api'
import { apiGet } from './api'

interface ConsoleContext {
  session: { scopes: string[] }
}

const KIND_LABEL: Record<string, string> = { targets: '名单轮', value_grid: '值集轮' }
const STATUS_TAG: Record<string, { color: string; label: string }> = {
  draft: { color: 'default', label: '草稿' },
  open: { color: 'processing', label: '进行中' },
  closed: { color: 'success', label: '已关闭' },
}
const ITEM_TAG: Record<string, { color: string; label: string }> = {
  pending: { color: 'warning', label: '待交' },
  submitted: { color: 'success', label: '已交' },
  waived: { color: 'default', label: '免交' },
}

/** 名单/格子文本域 → 清单（按行拆、去空、去重——与服务端去重语义一致，前端只做预检）。 */
function parseList(text: string): string[] {
  return [...new Set(
    text.split('\n').map((s) => s.trim()).filter((s) => s.length > 0),
  )]
}

export default function Rounds() {
  const { session } = useOutletContext<ConsoleContext>()
  const canManage = session.scopes.includes('forms:manage')

  const [rows, setRows] = useState<RoundRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // 新建弹窗
  const [creating, setCreating] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [kind, setKind] = useState<'targets' | 'value_grid'>('targets')
  const [defs, setDefs] = useState<DefSummary[]>([])
  const [form] = Form.useForm()

  // 逐项详情
  const [detail, setDetail] = useState<RoundDetailView | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  // 行内动作的 loading（一次锁一行）
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = () =>
    listRounds()
      .then(setRows)
      .catch((e: unknown) => setError(e instanceof ApiError ? `${e.code}：${e.detail ?? e.message}` : String(e)))
      .finally(() => setLoading(false))

  useEffect(() => {
    void load()
  }, [])

  const openCreate = async () => {
    setError(null)
    setNotice(null)
    setKind('targets')
    form.resetFields()
    if (defs.length === 0) {
      try {
        const body = await apiGet<{ defs: DefSummary[] }>('/api/modules/forms/defs')
        setDefs(body.defs)
        // 默认选第一张有发布版本的表单（人少打一次下拉）
        const first = body.defs.find((d) => d.headVersion !== null)
        if (first !== undefined) form.setFieldValue('assetId', first.assetId)
      } catch {
        // defs 拉不到也让弹窗开着：提交时服务端会拦（NO_PUBLISHED_HEAD）
      }
    }
    setCreating(true)
  }

  const submitCreate = async (values: { assetId: string; roundKey: string; name: string; listText: string }) => {
    setSubmitting(true)
    setError(null)
    try {
      const list = parseList(values.listText)
      const out = await createRound({
        assetId: values.assetId,
        roundKey: values.roundKey.trim(),
        kind,
        name: values.name.trim(),
        ...(kind === 'targets' ? { targets: list } : { anchors: list }),
      })
      await load() // 先刷新再提示（约定 §5）
      setCreating(false)
      setNotice(`已创建草稿轮 ${out.id}（${KIND_LABEL[kind]} ${values.roundKey}）——核对无误后点「开轮」开始收集`)
    } catch (e) {
      const err = e as ApiError
      setError(err.detail ? `${err.code}：${err.detail}` : err.message)
    } finally {
      setSubmitting(false)
    }
  }

  const doTransition = async (row: RoundRow, action: 'open' | 'close') => {
    setBusyId(row.id)
    setError(null)
    try {
      if (action === 'open') await openRound(row.id)
      else await closeRound(row.id)
      await load() // 先刷新再提示
      setNotice(action === 'open'
        ? `轮次 ${row.roundKey} 已开启，指派通知已发出`
        : `轮次 ${row.roundKey} 已关闭`)
    } catch (e) {
      const err = e as ApiError
      setError(err.detail ? `${err.code}：${err.detail}` : err.message)
    } finally {
      setBusyId(null)
    }
  }

  const showDetail = async (id: string) => {
    setDetailLoading(true)
    setError(null)
    try {
      setDetail(await getRound(id))
    } catch (e) {
      const err = e as ApiError
      setError(err.detail ? `${err.code}：${err.detail}` : err.message)
    } finally {
      setDetailLoading(false)
    }
  }

  const emptyText = canManage
    ? '还没有收集轮次。点「新建轮次」建一个：名单轮按人收，值集轮按格子（如门店）收'
    : '还没有收集轮次。联系管理员在「表单 → 轮次」建一个'

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>收集轮次</Typography.Title>
        {canManage && (
          <Button type="primary" onClick={() => void openCreate()}>新建轮次</Button>
        )}
      </div>

      {error !== null && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={error} />}
      {notice !== null && <Alert type="success" showIcon style={{ marginBottom: 12 }} message={notice} />}

      <Card size="small">
        <Table<RoundRow>
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={rows}
          pagination={false}
          locale={{ emptyText: <Empty description={emptyText} /> }}
          columns={[
            { title: '轮次', dataIndex: 'roundKey', width: 110 },
            { title: '名称', dataIndex: 'name' },
            { title: '表单', dataIndex: 'assetId' },
            {
              title: '类型',
              dataIndex: 'kind',
              width: 90,
              render: (k: string) => <Tag>{KIND_LABEL[k] ?? k}</Tag>,
            },
            {
              title: '状态',
              dataIndex: 'status',
              width: 90,
              render: (s: string) => {
                const t = STATUS_TAG[s] ?? { color: 'default', label: s }
                return <Tag color={t.color}>{t.label}</Tag>
              },
            },
            {
              title: '进度',
              key: 'progress',
              width: 150,
              render: (_, r) => (
                <div>
                  <Progress
                    percent={r.total === 0 ? 0 : Math.round((r.submitted / r.total) * 100)}
                    size="small"
                    status={r.status === 'closed' ? 'normal' : 'active'}
                  />
                  <Typography.Text type="secondary">{r.submitted}/{r.total}</Typography.Text>
                </div>
              ),
            },
            {
              title: '截止',
              dataIndex: 'endsAt',
              width: 110,
              render: (v: string | null) => (v === null ? '—' : v.slice(0, 10)),
            },
            {
              title: '操作',
              key: 'action',
              width: 170,
              render: (_, record) => (
                <Space size={4}>
                  {canManage && record.status === 'draft' && (
                    <Button
                      type="link" size="small"
                      loading={busyId === record.id}
                      onClick={() => void doTransition(record, 'open')}
                    >
                      开轮
                    </Button>
                  )}
                  {canManage && record.status === 'open' && (
                    <Button
                      type="link" size="small"
                      loading={busyId === record.id}
                      onClick={() => void doTransition(record, 'close')}
                    >
                      关轮
                    </Button>
                  )}
                  <Button type="link" size="small" onClick={() => void showDetail(record.id)}>
                    详情
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        title="新建收集轮次"
        open={creating}
        onCancel={() => setCreating(false)}
        confirmLoading={submitting}
        onOk={() => void form.submit()}
        okText="创建"
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={(v) => void submitCreate(v as never)}>
          <Form.Item label="表单" name="assetId" rules={[{ required: true, message: '选一张已发布的表单' }]}>
            <Select
              placeholder="选表单"
              options={defs.filter((d) => d.headVersion !== null).map((d) => ({
                value: d.assetId,
                label: `${d.assetId}（v${d.headVersion}）`,
              }))}
            />
          </Form.Item>
          <Form.Item
            label="轮次标识"
            name="roundKey"
            rules={[
              { required: true, message: '如 2026-11（同表单同标识只能一轮）' },
              { pattern: /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,63}$/, message: '字母/数字开头的 1..64 位（字母数字._:-）' },
            ]}
          >
            <Input placeholder="2026-11" maxLength={64} />
          </Form.Item>
          <Form.Item label="名称" name="name" rules={[{ required: true, message: '给人看的轮次名' }]}>
            <Input placeholder="十一月门店目标" maxLength={128} />
          </Form.Item>
          <Form.Item label="类型">
            <Radio.Group
              value={kind}
              onChange={(e) => setKind(e.target.value as 'targets' | 'value_grid')}
            >
              <Radio.Button value="targets">名单轮</Radio.Button>
              <Radio.Button value="value_grid">值集轮</Radio.Button>
            </Radio.Group>
            <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
              {kind === 'targets' ? '按人收：每个名单上的人各交一笔' : '按格子收：每个格子（如门店）各交一笔'}
            </Typography.Text>
          </Form.Item>
          <Form.Item
            label={kind === 'targets' ? '应交人名单' : '格子清单'}
            name="listText"
            rules={[{ required: true, message: kind === 'targets' ? '每行一个应交人' : '每行一个格子键（如门店号）' }]}
          >
            <Input.TextArea
              rows={6}
              placeholder={kind === 'targets' ? '每行一个应交人，如：\nzhangsan\nlisi' : '每行一个格子键，如：\nS001\nS002'}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={detail === null ? '' : `${detail.round.name} · ${detail.round.roundKey}`}
        open={detail !== null}
        onCancel={() => setDetail(null)}
        footer={null}
        width={640}
      >
        {detail === null ? (
          <Empty description={detailLoading ? '加载中…' : '无详情'} />
        ) : (
          <>
            <Descriptions size="small" column={2} style={{ marginBottom: 12 }}>
              <Descriptions.Item label="表单">{detail.round.assetId}（v{detail.round.version}）</Descriptions.Item>
              <Descriptions.Item label="类型">{KIND_LABEL[detail.round.kind]}</Descriptions.Item>
              <Descriptions.Item label="状态">
                {(STATUS_TAG[detail.round.status] ?? { label: detail.round.status }).label}
              </Descriptions.Item>
              <Descriptions.Item label="进度">
                {detail.progress === null ? '—' : `${detail.progress.submitted}/${detail.progress.total}`}
              </Descriptions.Item>
            </Descriptions>
            {detail.progress !== null && detail.progress.items.length > 0 && (
              <Table
                rowKey="key"
                size="small"
                pagination={false}
                dataSource={detail.progress.items}
                columns={[
                  { title: detail.round.kind === 'targets' ? '应交人' : '格子', dataIndex: 'key' },
                  {
                    title: '状态',
                    dataIndex: 'status',
                    width: 90,
                    render: (s: string) => {
                      const t = ITEM_TAG[s] ?? { color: 'default', label: s }
                      return <Tag color={t.color}>{t.label}</Tag>
                    },
                  },
                  {
                    title: '提交记录',
                    dataIndex: 'submissionId',
                    width: 110,
                    render: (v: string | null) => (v === null ? '—' : `#${v}`),
                  },
                ]}
              />
            )}
          </>
        )}
      </Modal>
    </div>
  )
}
