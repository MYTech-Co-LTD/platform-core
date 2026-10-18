// console/index.tsx — 通知规则模块 console 入口（issue #889）。
//
// 一个 console 条目 + 页内 tabs（照 modules/forms 姿势）：frontend.console 是扁平数组、
// 协议不支持嵌套 ⇒ 页内分区、URL 深链。⚠️ 不用嵌套 <Routes>；导航必须绝对路径。
//
// v1 范围（§2.6 console 页）：**规则管理区**（列表 + 启停 + 删除 + origin 标记）+ **投递记录**
// （回执审计面）。**v1 无规则表单编辑器**——编辑场景由 AI 创建（/mcp-manage 的 propose_rule）覆盖，
// 人只管看和开关。
// 【后续】收件箱区（待办查权威源 + Novu in-app 未读经后端代理）为 follow-up：待办源跨服务
//   （case-engine，gated on M2.2）与 Novu in-app 代理端点未落地，本页先不建半成品。
import { useCallback, useEffect, useState } from 'react'
import { Button, Layout, Menu, Popconfirm, Space, Switch, Table, Tag, Typography, message } from 'antd'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  ApiError,
  fetchDeliveries,
  fetchRules,
  removeRule,
  setRuleEnabled,
  type DeliveryView,
  type RuleView,
} from './api'

const BASE = '/console/notify'
const TABS = [
  { key: 'rules', label: '规则管理' },
  { key: 'deliveries', label: '投递记录' },
] as const
type TabKey = (typeof TABS)[number]['key']
const TAB_KEYS: readonly string[] = TABS.map((t) => t.key)

const errText = (e: unknown) => (e instanceof ApiError ? `${e.code}${e.detail ? `：${e.detail}` : ''}` : String(e))

function RulesTab() {
  const [rules, setRules] = useState<RuleView[]>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setRules(await fetchRules())
    } catch (e) {
      message.error(`加载规则失败：${errText(e)}`)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const onToggle = async (id: string, enabled: boolean) => {
    try {
      await setRuleEnabled(id, enabled)
      await load()
    } catch (e) {
      message.error(`启停失败：${errText(e)}`)
    }
  }
  const onDelete = async (id: string) => {
    try {
      await removeRule(id)
      await load()
    } catch (e) {
      message.error(`删除失败：${errText(e)}`)
    }
  }

  return (
    <>
      <Typography.Paragraph type="secondary">
        规则 = 事件 × 挂载点 × 模板 × 收件人 × 通道。**常路径零配置默认就通**（声明派生，标「声明派生」）；
        人工/AI 建的规则（标「人工」）覆盖派生规则。v1 无表单编辑器——新增/修改走 AI 创建。
      </Typography.Paragraph>
      <Table<RuleView>
        rowKey="id"
        loading={loading}
        dataSource={rules}
        pagination={false}
        size="small"
        columns={[
          { title: '事件', dataIndex: 'eventType' },
          { title: '挂载点', dataIndex: 'mount' },
          { title: '模板', dataIndex: 'templateId' },
          {
            title: '收件人',
            render: (_, r) => `${r.recipient}${r.recipientArg ? `(${r.recipientArg})` : ''}`,
          },
          { title: '通道', render: (_, r) => r.channels.join(' / ') },
          {
            title: '来源',
            dataIndex: 'origin',
            render: (o: string) => <Tag color={o === 'derived' ? 'blue' : 'green'}>{o === 'derived' ? '声明派生' : '人工'}</Tag>,
          },
          {
            title: '启停',
            render: (_, r) => <Switch checked={r.enabled} onChange={(v) => void onToggle(r.id, v)} />,
          },
          {
            title: '操作',
            render: (_, r) => (
              <Popconfirm title="删除该规则？" onConfirm={() => void onDelete(r.id)}>
                <Button danger size="small" type="link">
                  删除
                </Button>
              </Popconfirm>
            ),
          },
        ]}
      />
    </>
  )
}

function DeliveriesTab() {
  const [rows, setRows] = useState<DeliveryView[]>([])
  const [loading, setLoading] = useState(false)
  const load = useCallback(async () => {
    setLoading(true)
    try {
      setRows(await fetchDeliveries())
    } catch (e) {
      message.error(`加载投递记录失败：${errText(e)}`)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  return (
    <>
      <Typography.Paragraph type="secondary">
        投递回执（审计面）：每条 = 一次「规则 × 收件人」的投递。`unique(event_id, rule_id)` 保证重复
        emit 不双发；失败记错误摘要（fail-open，不阻塞业务）。
      </Typography.Paragraph>
      <Space style={{ marginBottom: 8 }}>
        <Button size="small" onClick={() => void load()}>
          刷新
        </Button>
      </Space>
      <Table<DeliveryView>
        rowKey={(r) => `${r.eventId}:${r.ruleId}:${r.recipient}`}
        loading={loading}
        dataSource={rows}
        pagination={{ pageSize: 20 }}
        size="small"
        columns={[
          { title: '时间', dataIndex: 'createdAt', width: 190 },
          { title: '事件', dataIndex: 'eventType' },
          { title: '规则', dataIndex: 'ruleId' },
          { title: '收件人', dataIndex: 'recipient' },
          { title: '模板', dataIndex: 'template' },
          {
            title: '状态',
            dataIndex: 'status',
            render: (s: string) => <Tag color={s === 'sent' ? 'green' : 'red'}>{s}</Tag>,
          },
          { title: '错误', dataIndex: 'error' },
        ]}
      />
    </>
  )
}

export default function NotifyConsolePage() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const rest = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname
  const segs = rest.split('/').filter(Boolean)
  const active: TabKey = segs.length === 1 && TAB_KEYS.includes(segs[0]) ? (segs[0] as TabKey) : 'rules'

  useEffect(() => {
    if (rest !== '/rules' && rest !== '/deliveries') navigate(`${BASE}/rules`, { replace: true })
  }, [rest, navigate])

  return (
    <Layout style={{ background: 'transparent' }}>
      <Menu
        mode="horizontal"
        selectedKeys={[active]}
        items={TABS.map((t) => ({ key: t.key, label: t.label }))}
        onClick={({ key }) => navigate(`${BASE}/${key}`)}
        style={{ marginBottom: 16 }}
      />
      {active === 'rules' && <RulesTab />}
      {active === 'deliveries' && <DeliveriesTab />}
    </Layout>
  )
}
