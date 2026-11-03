// MobileHome（/m）— 移动端业务入口页（spec 2026-11-01 §5.1 P2）。
//
// 只做一件事：按**当前登录人**的权限列出业务应用卡片。
// 数据来自 `GET /api/platform/me/apps`（按 scope 过滤；匿名 401 ⇒ 跳登录并回跳 /m）。
// **不在这里复制权限判断**：过滤在服务端（`platform-permission` 红线：不造第二套权限）。
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Skeleton } from 'antd'
import { platformFetch } from '@platform/sdk/web'
import s from './MobileHome.module.css'

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
      <div className={s.loginBox}>
        <p>请先登录后再打开业务工作台。</p>
        <Link className={s.loginBtn} to="/login?next=/m">去登录</Link>
      </div>
    )
  }

  return (
    <div className={s.page}>
      <h3 className={s.title}>业务工作台</h3>
      <p className={s.subtitle}>按你的权限列出可用的业务应用</p>
      {apps === null ? (
        // 骨架屏：结构先出现，感知更快（与移动指标页同一口径）
        <div className={s.grid}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={s.card}>
              <Skeleton.Avatar active size={40} shape="square" />
              <Skeleton.Input active size="small" style={{ width: '70%' }} />
            </div>
          ))}
        </div>
      ) : apps.length === 0 ? (
        <p className={s.empty}>
          暂无可用的业务应用
          <br />
          需要管理员为你开通对应权限后才会出现在这里
        </p>
      ) : (
        <div className={s.grid}>
          {apps.map((a) => (
            // 用 <a> 而不是 SPA 内路由跳转：目标是模块自己的移动端站点（/app/<id>），
            // 与 console 是两套前端产物，交给浏览器整页加载最可靠。
            <a key={a.moduleId} className={s.card} href={a.mount}>
              {/* icon 目前是 manifest 的图标名（非 URL）⇒ 用标题首字做占位标识，稳定且不引资产 */}
              <span className={s.avatar} aria-hidden>{a.title.slice(0, 1)}</span>
              <span className={s.name}>{a.title}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
