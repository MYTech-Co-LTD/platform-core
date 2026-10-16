// console/index.tsx — 表单模块 console 入口（issue #718，M1.3a）。
//
// 一个 console 条目 + 页内 tabs（照 aftersales 姿势）：frontend.console 是扁平数组、协议
// 不支持嵌套 ⇒ 页内分区、URL 深链。
// ⚠️ 不用嵌套 <Routes>（浏览器实测坑，见 aftersales 同款注释）：按 pathname 末段直接选页。
// ⚠️ 导航必须绝对路径（相对导航会丢模块段）。
// fill 深链形状 /console/forms/fill/:assetId：末段是 assetId、倒数第二段是 'fill'。
import { useEffect } from 'react'
import { Layout, Menu } from 'antd'
import { useLocation, useNavigate } from 'react-router-dom'
import FormsList from './FormsList'
import FillForm from './FillForm'
import Submissions from './Submissions'

const BASE = '/console/forms'

const TABS = [
  { key: 'forms', label: '表单' },
  { key: 'fill', label: '填报' },
  { key: 'submissions', label: '提交记录' },
] as const

type TabKey = (typeof TABS)[number]['key']
const TAB_KEYS: readonly string[] = TABS.map((t) => t.key)

export default function FormsConsolePage() {
  const navigate = useNavigate()
  const { pathname } = useLocation()

  // 解析 rest（BASE 之后的部分）：'' | '/fill/:assetId' | '/submissions/:assetId' | '/:tab'
  const rest = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname
  const segs = rest.split('/').filter(Boolean)
  let active: TabKey = 'forms'
  let fillAsset: string | undefined
  let subAsset: string | undefined
  if (segs[0] === 'fill' && segs[1] !== undefined) {
    active = 'fill'
    fillAsset = segs[1]
  } else if (segs[0] === 'submissions') {
    active = 'submissions'
    subAsset = segs[1] // 可选：深链直达某资产的提交列表
  } else if (segs.length === 1 && (TAB_KEYS as readonly string[]).includes(segs[0])) {
    active = segs[0] as TabKey
  }

  // 裸条目路径规范化到表单页（URL 与页面内容一致，深链/刷新语义不含混）
  useEffect(() => {
    if (active === 'forms' && rest !== '/forms') navigate(`${BASE}/forms`, { replace: true })
  }, [active, rest, navigate])

  return (
    <Layout style={{ background: 'transparent' }}>
      <Menu
        mode="horizontal"
        selectedKeys={[active]}
        items={TABS.map((t) => ({ key: t.key, label: t.label }))}
        onClick={({ key }) => navigate(`${BASE}/${key}`)}
        style={{ marginBottom: 16 }}
      />
      {active === 'forms' && <FormsList />}
      {active === 'fill' && <FillForm assetId={fillAsset} />}
      {active === 'submissions' && <Submissions assetId={subAsset} onAssetChange={(v) => navigate(v ? `${BASE}/submissions/${v}` : `${BASE}/submissions`)} />}
    </Layout>
  )
}
