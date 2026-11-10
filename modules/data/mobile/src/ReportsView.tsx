// ReportsView.tsx — 报表中心的两张脸（#1369/#1371/#1373）：
//   · tab="center"  报表中心：所有人创建的**已发布**且有权限看的报表，纯浏览（点卡 = 打开）
//   · tab="manage"  报表管理：**只列我创建的**（owner = 自己；含未发布草稿），
//                   点卡 = 管理面板（打开/预览、复制链接、发布/下线）
// 权限口径：
//   · 列表由服务端过滤（canViewAsset：页门/部门门/ACL）——前端不复制判断；
//   · 管理 tab 不能按 canEdit 过滤：对 data:manage 持有者恒真 ⇒ 与中心重复成同一页（#1373）。
//     管理员管**别人**的报表属配置面，回 PC；移动端只管自己的。
//   · 发布/下线用行上的 `version`（GET /reports 回带，写保护契约同 console）；
//     共享/部门门/回收等配置动作不进移动端。
import { useEffect, useRef, useState } from 'react'
import { Dialog, Input, Tag, Toast } from 'antd-mobile'
import { ApiError, apiGet, apiSend } from './api'

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
  /** 登记侧版本（写保护读侧）：发布/下线的 expectedVersion 来源 */
  version?: number
  /**
   * 报表规格里声明过的指标 id（W5 Task 4，服务端从 spec.panels 投影）。
   * 空/缺省 ⇒ 不渲染「口径与来源」链接（不猜一个 metric）。
   */
  metricIds?: string[]
}

/**
 * 体系地图深链（定案 A）：独立追溯页，移动壳只放**链接**，不复制渲染逻辑。
 * 页面自身按 hash 路由（#/metrics/<id> / #/overview），服务端只认 `/api/modules/data/system-map`。
 */
export function systemMapHref(fragment: string): string {
  const path = fragment.startsWith('#/') ? fragment : `#/${fragment.replace(/^#?\/?/, '')}`
  return `/api/modules/data/system-map${path}`
}

/** 报表卡上的「口径与来源」链接组（无指标 id ⇒ 不渲染）。 */
function SourceLinks({ metricIds }: { metricIds?: string[] }) {
  const ids = [...new Set(metricIds ?? [])]
  if (ids.length === 0) return null
  const shown = ids.slice(0, 3)
  const linkStyle = {
    display: 'inline-flex', alignItems: 'center', minHeight: 44,
    fontSize: 13, color: '#1677ff', textDecoration: 'none',
  }
  return (
    <div style={{ borderTop: '1px solid #f5f5f5', marginTop: 10, paddingTop: 4, display: 'flex', flexWrap: 'wrap', gap: 14 }}>
      {shown.map((id) => (
        <a key={id} href={systemMapHref(`#/metrics/${encodeURIComponent(id)}`)} style={linkStyle}>
          口径与来源{shown.length > 1 ? ` · ${id}` : ''}
        </a>
      ))}
      {ids.length > shown.length ? (
        <a href={systemMapHref('#/metrics')} style={linkStyle}>
          全部 {ids.length} 个指标
        </a>
      ) : null}
    </div>
  )
}

interface SheetAction {
  key: string
  label: string
  danger?: boolean
  onClick: () => void
}

export default function ReportsView({ rows, reload, tab, self }: {
  rows: ReportRow[]
  reload: () => Promise<void>
  tab: 'center' | 'manage'
  /** 当前用户 id（= 报表 ACL 的 owner subjectId；管理 tab 按它过滤「我创建的」） */
  self: string
}) {
  const [search, setSearch] = useState('')
  const [opening, setOpening] = useState<string | null>(null)
  /** App 内阅读：{ id, title, src } —— 全屏 iframe（复用宿主同一套渲染器，不做第二套） */
  const [viewing, setViewing] = useState<{ id: string; title: string; src: string } | null>(null)
  /** 管理面板（manage tab 点卡弹出） */
  const [sheetFor, setSheetFor] = useState<ReportRow | null>(null)
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

  const q = search.trim().toLowerCase()
  // 报表中心 = 所有人**已发布**且有权限看的（metabase 行恒可看；platform 行要有已发布版本）
  // 报表管理 = 只列**我创建/我拥有的**（owner = 自己；含未发布草稿——预览走 /r/:id?preview=1）。
  //   ⚠️ 不能按 canEdit 过滤：对 data:manage 持有者恒真 ⇒ 与中心重复成同一个页面（#1373）。
  const pool = tab === 'center'
    ? rows.filter((r) => r.renderer === 'metabase' || (r.publishedVersion !== null && r.publishedVersion !== undefined))
    : rows.filter((r) => r.owner !== null && r.owner === self)
  const visible = pool.filter((r) => q === '' || r.title.toLowerCase().includes(q))

  // ── 管理面板动作（manage tab）：移动端只放**使用级**动作；共享/部门门/回收属配置，在 PC ──
  const sheetActions = (r: ReportRow): SheetAction[] => {
    const published = r.renderer === 'metabase'
      || (r.publishedVersion !== null && r.publishedVersion !== undefined)
    const actions: SheetAction[] = [
      { key: 'open', label: published ? '打开报表' : '预览报表', onClick: () => void open(r) },
    ]
    if (r.renderer === 'platform' && published) {
      actions.push({
        key: 'link',
        label: '复制独立链接',
        onClick: () => {
          const url = `${window.location.origin}/r/${encodeURIComponent(r.id)}`
          if (navigator.clipboard?.writeText) {
            void navigator.clipboard.writeText(url).then(() => Toast.show({ content: '独立链接已复制' }))
          } else {
            Toast.show({ content: url })
          }
        },
      })
      actions.push({
        key: 'unpublish',
        label: '下线',
        danger: true,
        onClick: () => {
          Dialog.confirm({
            title: '下线报表',
            content: '下线后独立链接立即失效（历史版本保留），确定？',
            confirmText: '确认下线', cancelText: '取消',
            onConfirm: async () => {
              try {
                await apiSend('POST', `/api/modules/data/reports/${encodeURIComponent(r.id)}/unpublish`,
                  { expectedVersion: r.version })
                Toast.show({ content: '已下线' })
                void reload()
              } catch { Toast.show({ content: '操作失败，请稍后重试' }) }
            },
          })
        },
      })
    }
    if (r.renderer === 'platform' && !published && r.version !== undefined) {
      actions.push({
        key: 'publish',
        label: '发布',
        onClick: () => {
          Dialog.confirm({
            title: '发布报表',
            content: `发布后所有拿到本模块的人都能看到「${r.title}」，确定？`,
            confirmText: '确认发布', cancelText: '取消',
            onConfirm: async () => {
              try {
                await apiSend('POST', `/api/modules/data/reports/${encodeURIComponent(r.id)}/publish`,
                  { expectedVersion: r.version })
                Toast.show({ content: '已发布' })
                void reload()
              } catch { Toast.show({ content: '操作失败，请稍后重试' }) }
            },
          })
        },
      })
    }
    return actions
  }

  return (
    <div style={{ paddingBottom: 24 }}>
      <div style={{
        position: 'sticky', top: 0, zIndex: 10, background: '#f5f5f5',
        padding: '8px 12px 6px', borderBottom: '1px solid #eee',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <h3 style={{ margin: '0 0 2px', fontSize: 18 }}>
            {tab === 'center' ? '报表中心' : '报表管理'}
            {rows.length > 0 ? (
              <span style={{ fontSize: 12, color: '#999', fontWeight: 400, marginLeft: 8 }}>
                {q === '' ? `共 ${visible.length} 个` : `匹配 ${visible.length} / ${pool.length}`}
              </span>
            ) : null}
          </h3>
          {/* 体系地图只给「报表管理」口径的人看，且只在管理 tab 出现（报表中心纯浏览页不挂管理入口）。 */}
          {tab === 'manage' && (
            <a href={systemMapHref('#/overview')}
               style={{
                 display: 'inline-flex', alignItems: 'center', minHeight: 44, padding: '0 4px',
                 fontSize: 13, color: '#1677ff', textDecoration: 'none', flex: '0 0 auto',
               }}>
              体系地图
            </a>
          )}
        </div>
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
                你还没有自己创建的报表
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
          // 交互按语境分开（#1373）：中心点卡 = 打开阅读；管理点卡 = 管理面板
          if (tab === 'manage') {
            return (
              <div key={r.id} style={{ background: '#fff', borderRadius: 14, border: '1px solid #eee', overflow: 'hidden' }}>
                <button
                  type="button"
                  onClick={() => setSheetFor(r)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                    width: '100%', textAlign: 'left', cursor: 'pointer',
                    background: 'none', border: 'none', padding: '14px 16px',
                  }}
                >
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 16, fontWeight: 600, lineHeight: 1.4 }}>
                      {r.title}
                    </span>
                    <span style={{ display: 'block', fontSize: 12, color: '#999', marginTop: 6 }}>
                      {r.renderer === 'metabase' ? 'Metabase 报表'
                        : published ? (r.hasUnpublishedChanges ? '已发布 · 有未发布改动' : '已发布') : '未发布草稿'}
                    </span>
                  </span>
                  <span aria-hidden style={{ color: '#999', fontSize: 20, flex: '0 0 auto' }}>⋯</span>
                </button>
                <div style={{ padding: '0 16px' }}><SourceLinks metricIds={r.metricIds} /></div>
              </div>
            )
          }
          return (
            <div key={r.id} style={{ background: '#fff', borderRadius: 14, border: '1px solid #eee', overflow: 'hidden' }}>
              <button
                type="button"
                onClick={() => void open(r)}
                disabled={opening === r.id}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                  width: '100%', textAlign: 'left', cursor: 'pointer',
                  background: 'none', border: 'none', padding: '14px 16px',
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
              <div style={{ padding: '0 16px' }}><SourceLinks metricIds={r.metricIds} /></div>
            </div>
          )
        })}
      </div>

      {/* 管理面板（manage tab 点卡弹出） */}
      {sheetFor !== null && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 210, background: 'rgba(0,0,0,0.45)',
          display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
        }} onClick={() => setSheetFor(null)}>
          <div
            style={{ background: '#fff', borderRadius: '14px 14px 0 0', paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ padding: '14px 16px 8px', fontSize: 15, fontWeight: 600, borderBottom: '1px solid #f0f0f0' }}>
              {sheetFor.title}
            </div>
            {sheetActions(sheetFor).map((a) => (
              <button
                key={a.key}
                type="button"
                onClick={() => { setSheetFor(null); a.onClick() }}
                style={{
                  display: 'block', width: '100%', padding: '15px 24px',
                  border: 'none', background: 'none', textAlign: 'left', cursor: 'pointer',
                  fontSize: 16, color: a.danger === true ? '#ff4d4f' : '#1f1f1f',
                }}
              >{a.label}</button>
            ))}
            <button
              type="button"
              onClick={() => setSheetFor(null)}
              style={{
                display: 'block', width: '100%', padding: '15px 24px', marginTop: 8,
                border: 'none', borderTop: '1px solid #f0f0f0', background: '#fafafa',
                textAlign: 'center', cursor: 'pointer', fontSize: 16, color: '#666',
              }}
            >取消</button>
          </div>
        </div>
      )}

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
