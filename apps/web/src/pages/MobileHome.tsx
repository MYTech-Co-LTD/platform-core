// MobileHome（/m）— 移动端业务入口页（spec 2026-11-01 §5.1 P2）。
//
// 只做一件事：按**当前登录人**的权限列出业务应用卡片。
// 数据来自 `GET /api/platform/me/apps`（按 scope 过滤；匿名 401 ⇒ 跳登录并回跳 /m）。
// **不在这里复制权限判断**：过滤在服务端（`platform-permission` 红线：不造第二套权限）。
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { platformFetch } from '@platform/sdk/web'

interface AppEntry {
  moduleId: string
  mount: string
  title: string
  icon: string | null
  scope: string | null
}

export default function MobileHome() {
  const [apps, setApps] = useState<AppEntry[] | null>(null)
  const [needLogin, setNeedLogin] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      const r = await platformFetch('/api/platform/me/apps')
      if (!alive) return
      if (r.status === 401) { setNeedLogin(true); return }
      const b = (await r.json().catch(() => ({ apps: [] }))) as { apps?: AppEntry[] }
      setApps(b.apps ?? [])
    })()
    return () => { alive = false }
  }, [])

  if (needLogin) {
    return (
      <div style={{ padding: 24, textAlign: 'center' }}>
        <p>请先登录后再打开业务工作台。</p>
        <Link to="/login?next=/m">去登录</Link>
      </div>
    )
  }

  return (
    <div style={{ padding: 16 }}>
      <h3 style={{ margin: '8px 0 16px' }}>业务工作台</h3>
      {apps === null ? (
        <p style={{ color: '#888' }}>正在加载…</p>
      ) : apps.length === 0 ? (
        <p style={{ color: '#888' }}>暂无可用的业务应用（需要管理员为你开通对应权限）。</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
          {apps.map((a) => (
            // 用 <a> 而不是 SPA 内路由跳转：目标是模块自己的移动端站点（/app/<id>），
            // 与 console 是两套前端产物，交给浏览器整页加载最可靠。
            <a key={a.moduleId} href={a.mount}
               style={{
                 display: 'block', padding: 16, border: '1px solid #eee', borderRadius: 12,
                 textAlign: 'center', color: 'inherit', textDecoration: 'none',
               }}>
              <div style={{ fontSize: 16 }}>{a.title}</div>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
