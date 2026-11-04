// ReportsView.tsx — 移动端「报表」页（产品口径 2026-11-04：业务操作在移动端，配置在 PC）。
//
// 只做观看/进入：
//   · 平台自绘且**已发布** ⇒ 打开独立链接 `/r/:id`（宿主页，同源整页加载）
//   · Metabase 行 ⇒ 取 embed-url 后整页打开
//   · 未发布 ⇒ 预览：打开 `/r/:id?preview=1`（standalone 显式预览模式，走 ACL 保护的
//     `/spec`——owner/受让人可看自己的草稿；无权者由页面显示错误）。发布动作本身仍在 PC。
// 不做共享/发布/回收等配置菜单——那些在 PC 控制台。
import { useEffect, useRef, useState } from 'react'
import { Input, Tag, Toast } from 'antd-mobile'
import { ApiError, apiGet } from './api'

export interface ReportRow {
  id: string
  title: string
  renderer: 'metabase' | 'platform'
  canEdit?: boolean
  owner?: string | null
  ownerActive?: boolean | null
  publishedVersion?: number | null
  hasUnpublishedChanges?: boolean
  requiredScope?: string | null
  requiredDepts?: string[] | null
}

export default function ReportsView({ rows, reload, tab }: {
  rows: ReportRow[]
  reload: () => Promise<void>
  /** center = 报表中心（纯浏览，只看已发布）；manage = 报表管理（自己的，canEdit） */
  tab: 'center' | 'manage'
}) {
  const [search, setSearch] = useState('')
  const [opening, setOpening] = useState<string | null>(null)
  /** App 内阅读：{ id, title, src } —— 全屏 iframe（复用宿主同一套渲染器，不做第二套） */
  const [viewing, setViewing] = useState<{ id: string; title: string; src: string } | null>(null)
  const pushedRef = useRef(false)

  // 安卓返回键/手势：pushState 后返回 = 关闭阅读层（不需要用户找左上角）
  useEffect(() => {
    const onPop = () => { pushedRef.current = false; setViewing(null) }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const openViewer = (id: string, title: string, src: string) => {
    if (!pushedRef.current) {
      window.history.pushState({ report: id }, '')
      pushedRef.current = true
    }
    setViewing({ id, title, src })
  }

  const closeViewer = () => {
    if (pushedRef.current) window.history.back()
    else setViewing(null)
  }

  const q = search.trim().toLowerCase()
  // 报表中心 = 只看已发布（metabase 行恒可看；platform 行要有已发布版本）
  // 报表管理 = 只看自己的可编辑报表（含未发布草稿——预览走 /r/:id?preview=1）
  const pool = tab === 'center'
    ? rows.filter((r) => r.renderer === 'metabase' || (r.publishedVersion !== null && r.publishedVersion !== undefined))
    : rows.filter((r) => r.canEdit === true)
  const visible = pool.filter((r) => q === '' || r.title.toLowerCase().includes(q))

  const open = async (r: ReportRow): Promise<void> => {
    if (r.renderer === 'platform') {
      // 未发布 ⇒ 预览（#1367：standalone 显式 preview 模式；无权时页面自己报错）
      const src = r.publishedVersion === null || r.publishedVersion === undefined
        ? `/r/${encodeURIComponent(r.id)}?preview=1`
        : `/r/${encodeURIComponent(r.id)}`
      openViewer(r.id, r.title, src)
      return
    }
    // Metabase 行：走平台的短期嵌入 URL（前端不碰密钥）
    setOpening(r.id)
    try {
      const b = await apiGet<{ url: string }>(`/api/modules/data/reports/${encodeURIComponent(r.id)}/embed-url`)
      openViewer(r.id, r.title, b.url)
    } catch (e) {
      Toast.show({ content: e instanceof ApiError && e.status === 403 ? '你没有这张报表的权限' : '打开失败，请稍后重试' })
    } finally {
      setOpening(null)
    }
  }

  return (
    <div style={{ paddingBottom: 24 }}>
      <div style={{
        position: 'sticky', top: 0, zIndex: 10, background: '#f5f5f5',
        padding: '8px 12px 6px', borderBottom: '1px solid #eee',
      }}>
        <h3 style={{ margin: '0 0 2px', fontSize: 18 }}>
          {tab === 'center' ? '报表中心' : '报表管理'}
          {rows.length > 0 ? (
            <span style={{ fontSize: 12, color: '#999', fontWeight: 400, marginLeft: 8 }}>
              {q === '' ? `共 ${visible.length} 个` : `匹配 ${visible.length} / ${pool.length}`}
            </span>
          ) : null}
        </h3>
        {/* 与指标页一致：不用 antd-mobile SearchBar（本仓 React 18 + hoisted 19 下渲染异常） */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: '#fff', border: '1px solid #e5e5e5', borderRadius: 8, padding: '6px 10px',
        }}>
          <span style={{ color: '#bbb', fontSize: 14 }}>⌕</span>
          <Input placeholder="搜索报表名称" value={search} onChange={setSearch} style={{ '--font-size': '14px' }} />
        </div>
      </div>

      <div style={{ padding: '10px 12px 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {pool.length === 0 ? (
          <div style={{ color: '#999', textAlign: 'center', padding: 32, lineHeight: 1.8 }}>
            {tab === 'center' ? (
              <>
                暂时没有对你可见的已发布报表
                <br />
                有权限的报表发布后会出现在这里
              </>
            ) : (
              <>
                你还没有可管理的报表
                <br />
                在 PC 端创建后会出现在这里
              </>
            )}
          </div>
        ) : visible.length === 0 ? (
          <div style={{ color: '#999', textAlign: 'center', padding: 32 }}>没有匹配的报表，试试清空搜索。</div>
        ) : visible.map((r) => {
          const published = r.renderer === 'metabase'
            ? true
            : r.publishedVersion !== null && r.publishedVersion !== undefined
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => void open(r)}
              disabled={opening === r.id}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                width: '100%', textAlign: 'left', cursor: 'pointer',
                background: '#fff', borderRadius: 14, border: '1px solid #eee',
                padding: '14px 16px',
              }}
            >
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 16, fontWeight: 600, lineHeight: 1.4 }}>
                  {r.title}
                </span>
                <span style={{ display: 'block', fontSize: 12, color: '#999', marginTop: 6 }}>
                  {r.owner ? `所有者 ${r.owner}` : '无所有者'}
                  {r.ownerActive === false ? '（已停用）' : ''}
                </span>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' }}>
                {r.renderer === 'platform' && (
                  published
                    ? <Tag color="success" fill="outline" style={{ '--background-color': '#fff' }}>
                        {r.hasUnpublishedChanges ? '有更新' : '已发布'}
                      </Tag>
                    : <Tag color="default" fill="outline" style={{ '--background-color': '#fff' }}>未发布</Tag>
                )}
                <span aria-hidden style={{ color: '#ccc', fontSize: 18 }}>›</span>
              </span>
            </button>
          )
        })}
      </div>

      {/* App 内阅读层：全屏 + 顶部返回（iframe 载入宿主独立渲染页，口径与 PC 同一套） */}
      {viewing !== null && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 200, background: '#fff',
          display: 'flex', flexDirection: 'column',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 4, padding: '2px 8px',
            borderBottom: '1px solid #ececec', background: '#fff',
            paddingTop: 'env(safe-area-inset-top, 0px)',
          }}>
            <button
              type="button"
              aria-label="返回"
              onClick={closeViewer}
              style={{
                width: 44, height: 44, border: 'none', background: 'none',
                fontSize: 26, lineHeight: '44px', cursor: 'pointer', color: '#1f1f1f',
              }}
            >‹</button>
            <span style={{
              flex: 1, minWidth: 0, fontSize: 16, fontWeight: 600,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{viewing.title}</span>
            {viewing.src.includes('preview=1') && (
              <span style={{ fontSize: 12, color: '#fa8c16', border: '1px solid #fa8c16', borderRadius: 4, padding: '0 5px', flex: '0 0 auto' }}>预览</span>
            )}
          </div>
          <iframe
            key={viewing.id}
            title={viewing.title}
            src={viewing.src}
            style={{ flex: 1, width: '100%', border: 'none' }}
          />
        </div>
      )}
    </div>
  )
}
