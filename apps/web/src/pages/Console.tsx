// pages/Console.tsx —— /console/*：统一管理台壳（Task 18）。
//
// 「模块不再有自己的管理后台」：模块 console 页在构建期聚合成 console-registry.gen.ts
// （scripts/gen-console-registry.mjs），本壳按 /api/platform/config 的运行时清单出菜单——
// 服务端说该租户启用（config 出现）且 registry 里有（构建期已挂载）且用户持有 scope，三项
// 全过才出菜单/放行路由；任何一环缺失都对用户不可见。
// 会话（Task 13）：挂载并行取 /session + /config；401 由 platformFetch 统一跳 /login?next=/console。
import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, Outlet, useLocation, useNavigate, useOutletContext } from 'react-router-dom'
import { ProLayout } from '@ant-design/pro-components'
import {
  AppstoreOutlined,
  BarChartOutlined,
  BellOutlined,
  CloudOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  ExperimentOutlined,
  FileTextOutlined,
  MoonOutlined,
  SettingOutlined,
  SunOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons'
import {
  App as AntdApp,
  Avatar,
  Button,
  Card,
  ConfigProvider,
  Result,
  Spin,
  Typography,
  theme,
} from 'antd'
import { consoleRegistry } from '../console-registry.gen'
import { buildConsoleMenu, visibleConsoleEntries } from './console-menu'
import {
  ApiError,
  DEFAULT_BRANDING,
  getBranding,
  getPlatformConfig,
  getSession,
  logout,
  type Branding,
  type PlatformConfig,
  type PlatformSession,
} from '../lib/api'

/**
 * manifest frontend.console.icon 透传的是 AntD 图标名字符串；壳侧按名映射成组件。
 * 不 import 全量图标（* as Icons 会把整包打进 bundle）——登记常用集合，未知名不渲染图标。
 */
const CONSOLE_ICONS: Record<string, ReactNode> = {
  AppstoreOutlined: <AppstoreOutlined />,
  BarChartOutlined: <BarChartOutlined />,
  BellOutlined: <BellOutlined />,
  CloudOutlined: <CloudOutlined />,
  DashboardOutlined: <DashboardOutlined />,
  DatabaseOutlined: <DatabaseOutlined />,
  ExperimentOutlined: <ExperimentOutlined />,
  FileTextOutlined: <FileTextOutlined />,
  SettingOutlined: <SettingOutlined />,
  TeamOutlined: <TeamOutlined />,
}

/** 子路由（概览/模块页）经 Outlet context 拿会话、租户配置与品牌（模块页只读 session，加字段向后兼容） */
export interface ConsoleOutletContext {
  session: PlatformSession
  config: PlatformConfig
  branding: Branding
}

/**
 * /console/admin/* 的路由级门禁（M3，spec D9）：无 tenant:admin → 403 Result。
 * 与菜单组同一判定（session.scopes.includes(TENANT_ADMIN_SCOPE)）——菜单挡导航、
 * 这里挡直敲 URL，两处一个语义。
 */
export function AdminGate({ children }: { children: ReactNode }) {
  const { session } = useOutletContext<ConsoleOutletContext>()
  if (!session.scopes.includes('tenant:admin')) {
    return <Result status="403" title="需要租户管理员权限" subTitle="请联系管理员授予 tenant:admin 权限码" />
  }
  return <>{children}</>
}

type Booted =
  | { state: 'loading' }
  | { state: 'ready'; session: PlatformSession; config: PlatformConfig }
  | { state: 'unauthenticated' }
  | { state: 'error'; code: string }

export default function ConsoleShell() {
  const [booted, setBooted] = useState<Booted>({ state: 'loading' })
  const [branding, setBranding] = useState<Branding>(DEFAULT_BRANDING)
  // 暗色偏好持久化在 localStorage（spec §2 D3：主题切换零成本，品牌主色仍走 branding API）。
  // 用 window.localStorage：happy-dom 只在 window 上挂 Storage，裸全局在测试环境是 undefined
  const [dark, setDark] = useState(() => window.localStorage.getItem('console-theme') === 'dark')
  const toggleDark = () =>
    setDark((d) => {
      const next = !d
      window.localStorage.setItem('console-theme', next ? 'dark' : 'light')
      return next
    })

  useEffect(() => {
    let alive = true
    // 会话与租户配置并行取（出菜单的双硬依赖）；品牌软取，失败留默认（参照 Login.tsx）
    Promise.all([getSession(), getPlatformConfig()])
      .then(([session, config]) => {
        if (alive) setBooted({ state: 'ready', session, config })
      })
      .catch((e) => {
        if (!alive) return
        if (e instanceof ApiError && e.code === 'UNAUTHENTICATED') {
          setBooted({ state: 'unauthenticated' })
        } else {
          setBooted({ state: 'error', code: e instanceof ApiError ? e.code : 'NETWORK' })
        }
      })
    getBranding()
      .then((b) => alive && setBranding(b))
      .catch(() => {
        /* 品牌取不到 → 默认品牌兜底，不阻塞控制台 */
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    document.title = `${branding.productName} 控制台`
  }, [branding.productName])

  // loading/unauthenticated 都不渲染（401 场景 platformFetch 已在跳 /login?next=/console）
  if (booted.state === 'loading' || booted.state === 'unauthenticated') return null
  if (booted.state === 'error') {
    return (
      <Result
        status="error"
        title="控制台加载失败"
        subTitle={`错误码 ${booted.code}，请稍后重试`}
        extra={
          <Button type="primary" onClick={() => window.location.reload()}>
            重试
          </Button>
        }
      />
    )
  }

  return (
    <ConfigProvider
      theme={{
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: { colorPrimary: branding.primaryColor },
      }}
    >
      {/* antd <App> 必须在 ConfigProvider **之内**（issue #106）：它渲染 message/notification/
          modal 的持有人，并给 App.useApp() 提供真 API。antd 6.x 的 useApp 是裸 useContext——
          没这层提供者时默认值是 `{message:{},notification:{},modal:{}}`，管理台 14 个
          message.* 调用点全部抛 TypeError（User/Permissions/Subscriptions/存储配置）。
          放这里而不是 main.tsx 根：只覆盖管理台壳，且继承上面这份租户主题配置。 */}
      <AntdApp>
        <ConsoleLayout
          session={booted.session}
          config={booted.config}
          branding={branding}
          dark={dark}
          onToggleDark={toggleDark}
        />
      </AntdApp>
    </ConfigProvider>
  )
}

function ConsoleLayout({
  session,
  config,
  branding,
  dark,
  onToggleDark,
}: {
  session: PlatformSession
  config: PlatformConfig
  branding: Branding
  dark: boolean
  onToggleDark: () => void
}) {
  const location = useLocation()
  const [loggingOut, setLoggingOut] = useState(false)

  // 菜单位置规则（spec §3）在 console-menu.ts：概览 → pinned（case-engine）→ manifest 声明序
  // → 管理组（tenant:admin 门禁，spec D4/D9 M3）
  const menuItems = useMemo(
    () => buildConsoleMenu(visibleConsoleEntries(config, session, consoleRegistry), CONSOLE_ICONS, session),
    [config, session],
  )

  const onLogout = async () => {
    setLoggingOut(true)
    try {
      // Task 13 契约：会话重签轮换 csrf——登出必须现取 /session 拿最新 csrfToken，
      // 不许用挂载时缓存的旧值（旧值会 403）
      const s = await getSession()
      await logout(s.csrfToken)
    } finally {
      // 无论登出成败都回登录页（401/403 由服务端语义兜底，停在原地只会让用户卡死）
      window.location.href = '/login'
    }
  }

  return (
    <ProLayout
      title={branding.productName}
      logo={branding.logo || undefined}
      layout="mix"
      fixSiderbar
      location={{ pathname: location.pathname }}
      route={{ path: '/', routes: menuItems }}
      menuItemRender={(item, dom) => (item.path ? <Link to={item.path}>{dom}</Link> : dom)}
      avatarProps={{
        title: session.user.displayName,
        icon: <Avatar icon={<UserOutlined />} />,
        size: 'small',
        style: { marginLeft: 8 },
      }}
      actionsRender={() => [
        <Button
          key="theme"
          size="small"
          aria-label="切换暗色模式"
          icon={dark ? <SunOutlined /> : <MoonOutlined />}
          onClick={onToggleDark}
        />,
        <Button key="logout" size="small" loading={loggingOut} onClick={() => void onLogout()}>
          退出登录
        </Button>,
      ]}
    >
      <Outlet context={{ session, config, branding } satisfies ConsoleOutletContext} />
    </ProLayout>
  )
}

/** /console 概览页（index 路由）= 工作台（issue #36）：欢迎卡 + 模块入口卡片网格 + 预留数据位 */
export function ConsoleOverview() {
  const { session, config, branding } = useOutletContext<ConsoleOutletContext>()
  const navigate = useNavigate()
  const entries = visibleConsoleEntries(config, session, consoleRegistry)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card styles={{ body: { padding: 24 } }}>
        <Typography.Title level={4} style={{ marginTop: 0 }}>
          你好，{session.user.displayName}
        </Typography.Title>
        <Typography.Text type="secondary">
          租户 {config.tenant.slug} · 组织 {session.org} · {branding.productName}
        </Typography.Text>
      </Card>
      <div>
        <Typography.Title level={5} style={{ marginTop: 0 }}>
          模块
        </Typography.Title>
        {entries.length === 0 ? (
          <Typography.Text type="secondary">当前没有可用的模块</Typography.Text>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
            {entries.map((e) => (
              <Card
                key={e.path}
                hoverable
                style={{ width: 240, borderRadius: 12 }}
                onClick={() => navigate(e.path)}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  {CONSOLE_ICONS[e.icon ?? '']}
                  <Typography.Text strong>{e.title}</Typography.Text>
                </div>
                <Typography.Text type="secondary">{e.moduleName}</Typography.Text>
              </Card>
            ))}
          </div>
        )}
      </div>
      {/* 预留数据位：平台指标卡（接入后在此渲染，见 spec §3 第 1 行） */}
    </div>
  )
}

/** /console/<模块 path> 模块页（通配路由）：registry 命中 + scope 放行 → 懒加载模块 default 导出 */
export function ConsoleModulePage() {
  const { pathname } = useLocation()
  const { session } = useOutletContext<ConsoleOutletContext>()
  // **前缀匹配，不是全等**（售后 M3a）：模块可以「声明 1 个条目 + 页内真子路由」
  // （`/console/aftersales` 之下挂 `tickets`/`rules`/…）。全等匹配会让深链
  // `/console/aftersales/stores` 直接落进下面的 404 分支——菜单点得进去、URL 一贴就白页。
  // 用 `${r.path}/` 收尾而不是裸 startsWith：否则 `/console/aftersalesXyz` 会误命中本条目。
  const entry = consoleRegistry.find(
    (r) => pathname === r.path || pathname.startsWith(`${r.path}/`),
  )
  const Lazy = useMemo(() => (entry ? lazy(entry.load) : null), [entry])

  if (!entry || !Lazy) {
    return <Result status="404" title="页面不存在" subTitle="模块可能未启用或未发布，请联系管理员" />
  }
  if (!session.scopes.includes(entry.scope)) {
    // 直敲 URL 绕过菜单的路由级门禁（与菜单同一判定）
    return <Result status="403" title="无权访问" subTitle={`需要权限 ${entry.scope}`} />
  }
  return (
    <Suspense
      fallback={
        <div style={{ padding: 96, textAlign: 'center' }}>
          <Spin size="large" />
        </div>
      }
    >
      <Lazy />
    </Suspense>
  )
}
