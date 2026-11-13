// standalone.tsx — 报表独立页（`/r/:id`）：登录态只读、无 console 壳、**不回退草稿**。
//
// 计划 2026-10-26 Task 13。三条硬约束：
//  ① 数据源默认只有 `GET /reports/:id/published-spec`——未发布 / 已下线 / 跨租户一律 404；
//     独立页**绝不**回退 `/draft`（草稿是管理面，独立链接能看到草稿等于绕过发布闸）。
//  ①b 例外 = **显式** `?preview=1`（#1367）：数据源改走 `GET /reports/:id/spec`（返回
//     `{spec,version}`，无标题 ⇒ 标题「预览」），并显示「预览草稿」标签。该端点本就受
//     `canViewAsset`（owner ∪ ACL ∪ manage）保护 ⇒ 无权者 403，页面显示错误、**不回退**
//     published-spec。带 `?v=N` 时 v 优先（保持「旧链接按那一版判」契约），preview 被忽略。
//  ② 无导航 / 菜单 / 关闭按钮：路由挂在宿主 `/console` 壳之外（`App.tsx` 顶层 `/r/:id`），
//     渲染只走 `ReportView chrome="standalone"`——本期不另造一套渲染器。
//  ③ `?v=N` 原样透传给服务端（钉住历史版本），并交给 ReportView 显示「历史版本 vN」标签。
//     登录回跳的查询串透传不归本页管：由 `platformFetch` 的 `next`（pathname+search+hash）
//     与登录页 `nextTarget` 负责（#1047/#1060）。
//
// 读侧最小形状闸（fail-closed，同 SpecView）：写入侧已过 `parseReportSpec` 白名单，这里只拦
// 「连 panels 都不是数组」这种彻底坏的响应，不让它进渲染循环；响应坏 = 报错，**不**回退草稿。
import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { Alert, Tag } from 'antd'
import { apiGet, messageOf } from './lib/api'
import ReportView from './reports/ReportView'
import type { ReportSpec } from '../domain/report-spec'

interface PublishedSpecBody {
  title: string
  spec: ReportSpec
  version: number
}

export default function StandaloneReport() {
  const { id } = useParams()
  const [searchParams] = useSearchParams()
  const v = searchParams.get('v')
  const preview = v === null && searchParams.get('preview') === '1'
  const [data, setData] = useState<PublishedSpecBody | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (id === undefined || id === '') return
    let alive = true
    // 换报 / 换版本先清场：避免旧报表内容在新请求返回前继续可见（独立链接常被直接改 v= 重开）
    setData(null)
    setError(null)
    if (preview) {
      // #1367 显式预览：走 /spec（canViewAsset 保护）。无标题 ⇒ 标题「预览」。
      apiGet(`/reports/${id}/spec`)
        .then((b) => {
          if (!alive) return
          const body = b as Partial<{ spec: ReportSpec; version: number }> | null
          if (
            body === null || typeof body !== 'object'
            || typeof body.version !== 'number'
            || body.spec === null || typeof body.spec !== 'object' || !Array.isArray(body.spec.panels)
          ) {
            setError('报表规格不合法，请联系平台侧')
            return
          }
          setData({ title: '预览', version: body.version, spec: body.spec })
        })
        .catch((e) => { if (alive) setError(messageOf(e)) })
      return
    }
    const suffix = v === null ? '' : `?v=${encodeURIComponent(v)}`
    apiGet(`/reports/${id}/published-spec${suffix}`)
      .then((b) => {
        if (!alive) return
        const body = b as Partial<PublishedSpecBody> | null
        if (
          body === null || typeof body !== 'object'
          || typeof body.title !== 'string'
          || typeof body.version !== 'number'
          || body.spec === null || typeof body.spec !== 'object' || !Array.isArray(body.spec.panels)
        ) {
          setError('报表规格不合法，请联系平台侧')
          return
        }
        setData(body as PublishedSpecBody)
      })
      .catch((e) => { if (alive) setError(messageOf(e)) })
    return () => { alive = false }
  }, [id, v, preview])

  if (error !== null) return <Alert type="error" showIcon title={error} style={{ margin: 24 }} />
  if (data === null) return <div style={{ padding: 24 }}>加载中…</div>
  // key=id+preview:换报表/换模式重建渲染器内部状态（期间/筛选覆盖/面板结果），不跨报表串味。
  return (
    <>
      {preview && <Tag color="orange" style={{ position: 'fixed', top: 8, right: 8, zIndex: 10 }}>预览草稿</Tag>}
      <ReportView
        key={`${id}:${preview ? 'preview' : ''}`}
      // id 在 effect 里已是 `string`（未定义直接 return），这里只是 TS 收口。
      reportId={id ?? ''}
      title={data.title}
      spec={data.spec}
      chrome="standalone"
        pinnedVersion={v === null ? null : Number(v)}
        {...(preview ? { preview: 'draft' as const } : {})}
      />
    </>
  )
}
