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
import { Dialog, Input, Toast } from 'antd-mobile'
import { ApiError, apiGet, apiSend } from './api'
import { C, Chip, EmptyState, Icon, cardStyle, pressable, radius } from './ui'

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
 * 体系地图：2026-11-15 起是**应用内页面**（`SystemMapView`，直读 `/system-map/graph`），
 * 不再链到服务端单文件 HTML。入口通过 `onOpenMap` 交给壳切 tab——
 * 旧链接是 `<a href>`，会整页跳走；改成按钮后返回时不用靠 history.back()。
 */
export type OpenMap = (metricId?: string) => void

/** 报表卡上的「口径与来源」入口组（无指标 id ⇒ 不渲染）。 */
function SourceLinks({ metricIds, onOpenMap }: { metricIds?: string[]; onOpenMap?: OpenMap }) {
  const ids = [...new Set(metricIds ?? [])]
  if (ids.length === 0) return null
  const shown = ids.slice(0, 3)
  const linkStyle = {
    display: 'inline-flex', alignItems: 'center', gap: 5, minHeight: 38,
    fontSize: 12, color: C.accentDeep, textDecoration: 'none',
  }
  return (
    <div style={{ borderTop: `1px solid ${C.lineSoft}`, paddingTop: 2, display: 'flex', flexWrap: 'wrap', gap: 14 }}>
      {shown.map((id) => (
        <button key={id} type="button" onClick={() => onOpenMap?.(id)}
                style={{ ...linkStyle, border: 'none', background: 'none', cursor: 'pointer', padding: 0 }}>
          <Icon name="source" size={13} />
          口径与来源{shown.length > 1 ? ` · ${id}` : ''}
        </button>
      ))}
      {ids.length > shown.length ? (
        <button type="button" onClick={() => onOpenMap?.()}
                style={{ ...linkStyle, border: 'none', background: 'none', cursor: 'pointer', padding: 0 }}>
          全部 {ids.length} 个指标
        </button>
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

export default function ReportsView({ rows, reload, tab, self, onOpenMap }: {
  rows: ReportRow[]
  reload: () => Promise<void>
  tab: 'center' | 'manage'
  /** 当前用户 id（= 报表 ACL 的 owner subjectId；管理 tab 按它过滤「我创建的」） */
  self: string
  /** 打开应用内体系地图（可带指标 id 直达详情） */
  onOpenMap?: OpenMap
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
        position: 'sticky', top: 0, zIndex: 10,
        background: 'rgba(243,245,247,0.92)',
        backdropFilter: 'saturate(160%) blur(14px)', WebkitBackdropFilter: 'saturate(160%) blur(14px)',
        padding: '14px 16px 10px', borderBottom: `1px solid ${C.lineSoft}`,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ minWidth: 0 }}>
            <h1 style={{
              margin: 0, fontSize: 23, lineHeight: 1.2, fontWeight: 650,
              letterSpacing: '-0.02em', color: C.ink,
            }}>
              {tab === 'center' ? '报表中心' : '报表管理'}
            </h1>
            <div style={{ fontSize: 12, color: C.mute, marginTop: 5 }}>
              {q === '' ? `共 ${visible.length} 个报表` : `匹配 ${visible.length} / ${pool.length}`}
            </div>
          </div>
          {/* 体系地图只给「报表管理」口径的人看，且只在管理 tab 出现（报表中心纯浏览页不挂管理入口）。 */}
          {tab === 'manage' && (
            <button type="button" onClick={() => onOpenMap?.()}
               style={{
                 display: 'inline-flex', alignItems: 'center', gap: 5, minHeight: 34,
                 padding: '0 11px', marginTop: 2, borderRadius: radius.chip,
                 background: C.accentSoft, color: C.accentDeep,
                 fontSize: 12, fontWeight: 500, textDecoration: 'none', flex: '0 0 auto',
                 border: 'none', cursor: 'pointer',
               }}>
              <Icon name="source" size={14} />
              体系地图
            </button>
          )}
        </div>
        {/* 与指标页一致：不用 antd-mobile SearchBar（本仓 React 18 + hoisted 19 下渲染异常） */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, marginTop: 12,
          background: C.surface, border: `1px solid ${C.line}`, borderRadius: radius.field,
          padding: '0 12px', height: 40,
        }}>
          <Icon name="search" size={16} color={C.mute} />
          <Input placeholder="搜索报表名称" value={search} onChange={setSearch}
                 style={{ '--font-size': '14px', flex: 1 }} />
        </div>
      </div>

      <div style={{ padding: '16px 16px 0', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {pool.length === 0 ? (
          <EmptyState
            icon="reports"
            title={tab === 'center' ? '暂时没有可见的报表' : '你还没有创建报表'}
            hint={tab === 'center' ? '有权限的报表发布后会出现在这里' : '在 PC 端创建后会出现在这里'}
          />
        ) : visible.length === 0 ? (
          <EmptyState icon="search" title="没有匹配的报表" hint="换个关键词，或清空搜索" />
        ) : visible.map((r) => {
          const published = r.renderer === 'metabase'
            ? true
            : r.publishedVersion !== null && r.publishedVersion !== undefined
          const tone = r.renderer === 'metabase'
            ? 'accent' as const
            : published
              ? (r.hasUnpublishedChanges ? 'warning' as const : 'success' as const)
              : 'neutral' as const
          const status = r.renderer === 'metabase'
            ? 'Metabase'
            : published
              ? (r.hasUnpublishedChanges ? '有更新' : '已发布')
              : '草稿'
          const owner = r.owner ? `所有者 ${r.owner}` : '无所有者'
          // 交互按语境分开（#1373）：中心点卡 = 打开阅读；管理点卡 = 管理面板
          return (
            <div key={r.id} style={{ ...cardStyle, overflow: 'hidden' }}>
              <button
                className="m-card-btn"
                type="button"
                onClick={tab === 'manage' ? () => setSheetFor(r) : () => void open(r)}
                disabled={opening === r.id}
                style={{
                  ...pressable,
                  display: 'flex', alignItems: 'center', gap: 12, width: '100%',
                  textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer',
                  padding: '15px 16px', opacity: opening === r.id ? 0.55 : 1,
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{
                    display: 'block', fontSize: 16, fontWeight: 600, lineHeight: 1.45, color: C.ink,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{r.title}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 7, minWidth: 0 }}>
                    <Chip tone={tone}>{status}</Chip>
                    <span style={{
                      fontSize: 12, color: C.mute, overflow: 'hidden',
                      textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {owner}{r.ownerActive === false ? '（已停用）' : ''}
                    </span>
                  </span>
                </span>
                {tab === 'manage'
                  ? <span aria-hidden style={{ color: C.mute, fontSize: 20, flex: '0 0 auto', lineHeight: 1 }}>⋯</span>
                  : <Icon name="chevron" size={18} color={C.mute} />}
              </button>
              <div style={{ padding: '0 16px' }}><SourceLinks metricIds={r.metricIds} onOpenMap={onOpenMap} /></div>
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
            <div style={{ padding: '10px 16px 14px', borderBottom: `1px solid ${C.lineSoft}` }}>
              <div style={{
                width: 36, height: 4, borderRadius: 2, background: C.line,
                margin: '0 auto 12px',
              }} aria-hidden />
              <div style={{ fontSize: 15, fontWeight: 600, color: C.ink }}>{sheetFor.title}</div>
            </div>
            {sheetActions(sheetFor).map((a) => (
              <button
                key={a.key}
                type="button"
                onClick={() => { setSheetFor(null); a.onClick() }}
                style={{
                  display: 'block', width: '100%', padding: '16px 24px',
                  border: 'none', background: 'none', textAlign: 'left', cursor: 'pointer',
                  fontSize: 16, color: a.danger === true ? C.danger : C.ink,
                }}
              >{a.label}</button>
            ))}
            <button
              type="button"
              onClick={() => setSheetFor(null)}
              style={{
                display: 'block', width: '100%', padding: '16px 24px', marginTop: 6,
                border: 'none', borderTop: `1px solid ${C.lineSoft}`, background: C.surface,
                textAlign: 'center', cursor: 'pointer', fontSize: 15, color: C.sub,
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
            borderBottom: `1px solid ${C.line}`, background: C.surface,
            paddingTop: 'env(safe-area-inset-top, 0px)',
          }}>
            <button
              type="button"
              aria-label="返回"
              onClick={closeViewer}
              style={{
                width: 44, height: 44, border: 'none', background: 'none',
                cursor: 'pointer', color: C.ink, display: 'flex',
                alignItems: 'center', justifyContent: 'center',
              }}
            >
              <span style={{ display: 'flex', transform: 'rotate(180deg)' }}>
                <Icon name="chevron" size={20} />
              </span>
            </button>
            <span style={{
              flex: 1, minWidth: 0, fontSize: 15, fontWeight: 600, color: C.ink,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{viewing.title}</span>
            {viewing.src.includes('preview=1') && <Chip tone="warning">预览</Chip>}
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
