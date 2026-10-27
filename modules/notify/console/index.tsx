// console/index.tsx — 通知 console 入口（六区；照 forms/aftersales 姿势）。
// frontend.console 是扁平数组、协议不支持嵌套 ⇒ 页内 tabs + URL 深链；导航必须绝对路径。
import { useEffect } from 'react'
import { Empty, Layout, Menu } from 'antd'
import { useLocation, useNavigate } from 'react-router-dom'
import EventsTab from './events'
import RulesTab from './rules'
import TemplatesTab from './templates'
import ChannelsTab from './channels'
import DeliveriesTab from './deliveries'
import InboxTab from './inbox'

const BASE = '/console/notify'

const TABS = [
  { key: 'events', label: '事件目录' },
  { key: 'rules', label: '规则' },
  { key: 'templates', label: '模板' },
  { key: 'channels', label: '通道' },
  { key: 'deliveries', label: '投递' },
  { key: 'inbox', label: '收件箱' },
] as const

type TabKey = (typeof TABS)[number]['key']
const TAB_KEYS: readonly string[] = TABS.map((t) => t.key)

export default function NotifyConsolePage() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const rest = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname
  const segs = rest.split('/').filter(Boolean)
  const active: TabKey = segs.length === 1 && TAB_KEYS.includes(segs[0]!)
    ? (segs[0] as TabKey)
    : 'events'

  useEffect(() => {
    if (rest !== `/${active}`) navigate(`${BASE}/${active}`, { replace: true })
  }, [rest, active, navigate])

  return (
    <Layout style={{ background: 'transparent' }}>
      <Menu
        mode="horizontal"
        selectedKeys={[active]}
        items={TABS.map((t) => ({ key: t.key, label: t.label }))}
        onClick={({ key }) => navigate(`${BASE}/${key}`)}
        style={{ marginBottom: 16 }}
      />
      {active === 'events' && <EventsTab />}
      {active === 'rules' && <RulesTab />}
      {active === 'templates' && <TemplatesTab />}
      {active === 'channels' && <ChannelsTab />}
      {active === 'deliveries' && <DeliveriesTab />}
      {active === 'inbox' && <InboxTab />}
    </Layout>
  )
}
