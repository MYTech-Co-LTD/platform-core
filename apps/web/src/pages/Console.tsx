// pages/Console.tsx —— /console/*：统一管理台壳（Task 18）。
//
// 「模块不再有自己的管理后台」：模块 console 页在构建期聚合成 console-registry.gen.ts
// （scripts/gen-console-registry.mjs），本壳按 /api/platform/config 的运行时清单出菜单——
// 服务端说该租户启用（config 出现）且 registry 里有（构建期已挂载）且用户持有 scope，三项
// 全过才出菜单/放行路由；任何一环缺失都对用户不可见。
// 会话（Task 13）：挂载并行取 /session + /config；401 由 platformFetch 统一跳 /login?next=/console。
import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, Outlet, useLocation, useOutletContext } from 'react-router-dom'
import { ProLayout } from '@ant-design/pro-components'
import type { MenuDataItem } from '@ant-design/pro-components'
import {
  AppstoreOutlined,
  BarChartOutlined,
  BellOutlined,
  CloudOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  ExperimentOutlined,
  FileTextOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { Avatar, Button, Card, ConfigProvider, Result, Spin, Tag, Typography } from 'antd'
import { consoleRegistry } from '../console-registry.gen'
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

/** 子路由（概览/模块页）经 Outlet context 拿会话与租户配置 */
export interface ConsoleOutletContext {
  session: PlatformSession
  config: PlatformConfig
}

type Booted =
  | { state: 'loading' }
  | { state: 'ready'; session: PlatformSession; config: PlatformConfig }
  | { state: 'unauthenticated' }
  | { state: 'error'; code: string }

export default function ConsoleShell() {
  const [booted, setBooted] = useState<Booted>({ state: 'loading' })
  const [branding, setBranding] = useState<Branding>(DEFAULT_BRANDING)

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
    <ConfigProvider theme={{ token: { colorPrimary: branding.primaryColor } }}>
      <ConsoleLayout session={booted.session} config={booted.config} branding={branding} />
    </ConfigProvider>
  )
}

function ConsoleLayout({
  session,
  config,
  branding,
}: {
  session: PlatformSession
  config: PlatformConfig
  branding: Branding
}) {
  const location = useLocation()
  const [loggingOut, setLoggingOut] = useState(false)

  // 菜单 = 系统项「概览」+ 启用模块的 console 页（config ∩ registry ∩ 用户 scope）
  const menuItems = useMemo<MenuDataItem[]>(() => {
    const items: MenuDataItem[] = [{ path: '/console', name: '概览' }]
    const seen = new Set<string>()
    for (const m of config.modules) {
      for (const c of m.console) {
        if (seen.has(c.path)) continue // 同 path 只出一次（首个声明者胜）
        seen.add(c.path)
        const reg = consoleRegistry.find((r) => r.path === c.path)
        if (!reg) continue // config 有但构建期没挂载（新模块未发布）→ 不出菜单
        if (!session.scopes.includes(c.scope)) continue // 权限门禁：scope 不在会话里
        items.push({
          path: reg.path,
          name: c.title,
          icon: CONSOLE_ICONS[c.icon ?? reg.icon ?? ''],
        })
      }
    }
    return items
  }, [config, session])

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
      layout="side"
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
        <Button key="logout" size="small" loading={loggingOut} onClick={() => void onLogout()}>
          退出登录
        </Button>,
      ]}
    >
      <Outlet context={{ session, config } satisfies ConsoleOutletContext} />
    </ProLayout>
  )
}

/** /console 概览页（index 路由）：租户 / 用户 / 权限三张卡 */
export function ConsoleOverview() {
  const { session, config } = useOutletContext<ConsoleOutletContext>()
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'stretch' }}>
      <Card title="租户" style={{ minWidth: 280 }}>
        <Typography.Paragraph style={{ marginBottom: 4 }}>
          <Typography.Text type="secondary">租户标识 </Typography.Text>
          <Typography.Text>{config.tenant.slug}</Typography.Text>
        </Typography.Paragraph>
        <Typography.Paragraph style={{ marginBottom: 4 }}>
          <Typography.Text type="secondary">组织 </Typography.Text>
          <Typography.Text>{config.tenant.org}</Typography.Text>
        </Typography.Paragraph>
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          <Typography.Text type="secondary">启用模块 </Typography.Text>
          <Typography.Text>{config.modules.map((m) => m.name).join('、') || '—'}</Typography.Text>
        </Typography.Paragraph>
      </Card>
      <Card title="当前用户" style={{ minWidth: 280 }}>
        <Typography.Paragraph style={{ marginBottom: 4 }}>
          <Typography.Text>{session.user.displayName}</Typography.Text>
        </Typography.Paragraph>
        <Typography.Paragraph style={{ marginBottom: 4 }}>
          <Typography.Text type="secondary">账号 </Typography.Text>
          <Typography.Text>{session.user.id}</Typography.Text>
        </Typography.Paragraph>
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          <Typography.Text type="secondary">组织 </Typography.Text>
          <Typography.Text>{session.org}</Typography.Text>
        </Typography.Paragraph>
      </Card>
      <Card title="权限" style={{ minWidth: 280 }}>
        {session.scopes.length === 0 ? (
          <Typography.Text type="secondary">未持有任何权限</Typography.Text>
        ) : (
          session.scopes.map((s) => (
            <Tag key={s} style={{ marginBottom: 8 }}>
              {s}
            </Tag>
          ))
        )}
      </Card>
    </div>
  )
}

/** /console/<模块 path> 模块页（通配路由）：registry 命中 + scope 放行 → 懒加载模块 default 导出 */
export function ConsoleModulePage() {
  const { pathname } = useLocation()
  const { session } = useOutletContext<ConsoleOutletContext>()
  const entry = consoleRegistry.find((r) => r.path === pathname)
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
