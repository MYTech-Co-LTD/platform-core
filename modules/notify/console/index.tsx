// console/index.tsx — 通知 console 入口（六区；照 forms/aftersales 姿势）。
// 导航：宿主左侧菜单按 manifest 子路径直达；本组件按 URL 末段选页（导航必须绝对路径）。
import { useEffect } from 'react'
import { Layout } from 'antd'
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

  // #1953 二期：页内 tabs 已撤，六页改为宿主左侧菜单子项（manifest 声明 6 个子路径）。
  return (
    <Layout style={{ background: 'transparent' }}>
      {active === 'events' && <EventsTab />}
      {active === 'rules' && <RulesTab />}
      {active === 'templates' && <TemplatesTab />}
      {active === 'channels' && <ChannelsTab />}
      {active === 'deliveries' && <DeliveriesTab />}
      {active === 'inbox' && <InboxTab />}
    </Layout>
  )
}
