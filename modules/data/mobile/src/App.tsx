// App.tsx — 移动端「所有指标」页（spec 2026-11-01 §10.2 判定表 / §10.4.2 P0）。
//
// **纯只读**（P4 写面收口，2026-11-13）：移动端不再提供任何指标写入口——
// 指标实现由 agent 提案、由人在控制台/变更单采纳；手机只做**读**（卡片列表 + 徽标）。
// 已移除：草稿保存/确认生效（遗留 creator 自助写面）、元数据编辑、认证升降。
// 「我的」标记保留（读侧 createdBy 投影的只读展示），不派生任何动作。
// 徽标：certified（平台认证/草稿）+ 新鲜度（绿 SLA 内 / 黄 偏慢 / 红 滞后 / 灰 未知）。
// 「数据至 M月D日」的口径与后端固定行同源（watermark 是日历日，+8 不吃钟点）。
import { useCallback, useEffect, useState } from 'react'
import { Input, PullToRefresh, Skeleton } from 'antd-mobile'
import ReportsView from './ReportsView'
import SystemMapView from './SystemMapView'
import type { ReportRow } from './ReportsView'
import { C, Chip, EmptyState, Icon, cardStyle, radius } from './ui'
import { apiGet, ApiError } from './api'

interface MetricItem {
  id: string
  title: string
  description: string
  certified?: 'certified' | 'draft'
  /** 元数据三件套（030，§10.4.3）：null = 未标注。 */
  bizDescription?: string | null
  unit?: string | null
  caliberNote?: string | null
  source?: 'l1' | 'l2'
  createdBy?: string | null
  freshness?: { status: 'normal' | 'late' | 'alert'; watermark: string | null }
}

interface MetricsResponse {
  metrics: MetricItem[]
  /** userId = 「我的」只读标记；scopes ∋ data:manage ⇒ 指标管理 tab 可见（不再派生写动作）。 */
  self?: { userId: string; scopes?: string[] }
}

/** `YYYY-MM-DD` → `M月D日`（后端 formatHumanDay 同款人话形态）。 */
function humanDay(iso: string): string {
  const [, m, d] = iso.split('-')
  return `${Number(m)}月${Number(d)}日`
}

const FRESHNESS_LABEL: Record<string, { text: string; color: string }> = {
  normal: { text: '正常', color: C.success },
  late: { text: '偏慢', color: C.warning },
  alert: { text: '滞后', color: C.danger },
}

function FreshnessBadge({ m }: { m: MetricItem }) {
  const f = m.freshness
  if (f === undefined) return <span style={{ fontSize: 12, color: C.mute }}>新鲜度未知</span>
  const label = FRESHNESS_LABEL[f.status] ?? { text: '未知', color: C.mute }
  const till = f.watermark !== null ? ` · 数据至 ${humanDay(f.watermark)}` : ''
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: label.color }}>
      <span style={{ width: 6, height: 6, borderRadius: 3, background: label.color }} aria-hidden />
      {label.text}{till}
    </span>
  )
}

function MetricsView({ data, reload }: { data: MetricsResponse; reload: () => Promise<void> }) {
  // 数据由 App 统一拉取（报表中心需要先算「是否有自己的指标/报表」来定 tab 显隐）。
  // 移动端列表搜索（2026-11-03）：指标多起来后，首屏先给搜索而不是让人一直滑
  const [search, setSearch] = useState('')

  const self = data.self?.userId
  /** 只读标记：本租户自建且 createdBy = 我（不派生任何写入口）。 */
  const isMine = (m: MetricItem): boolean => m.source === 'l2' && m.createdBy !== undefined && m.createdBy !== null && m.createdBy === self

  const metrics = data.metrics ?? []
  const q = search.trim().toLowerCase()
  const visible = metrics.filter((m) => q === ''
    || m.title.toLowerCase().includes(q)
    || (m.description ?? '').toLowerCase().includes(q)
    || (m.bizDescription ?? '').toLowerCase().includes(q))

  return (
    <div style={{ paddingBottom: 24 }}>
      {/* 顶部固定区（移动端首屏最重要的两件事：我在看什么、怎么找）。滚动时保持可见。 */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 10,
        background: 'rgba(243,245,247,0.92)',
        backdropFilter: 'saturate(160%) blur(14px)', WebkitBackdropFilter: 'saturate(160%) blur(14px)',
        padding: '14px 16px 10px', borderBottom: `1px solid ${C.lineSoft}`,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
          <div>
            <h1 style={{
              margin: 0, fontSize: 23, lineHeight: 1.2, fontWeight: 650,
              letterSpacing: '-0.02em', color: C.ink,
            }}>指标</h1>
            <div style={{ fontSize: 12, color: C.mute, marginTop: 5 }}>
              {q === '' ? `共 ${metrics.length} 个` : `匹配 ${visible.length} / ${metrics.length}`}
            </div>
          </div>
        </div>
        {/* 2026-11-12 定案 + P4 收口：指标实现（id/基底/表达式）由 agent 创建，提案与采纳
            走变更单（控制台）。手机只读展示——手填算式/元数据/认证升降都从移动端移除。 */}
        <div style={{ fontSize: 12, color: C.mute, marginTop: 6, lineHeight: 1.6 }}>
          指标由 agent 创建；手机只读，确认与标注在控制台。
        </div>
        {/* ⚠️ 不用 antd-mobile SearchBar：它在本仓（React 18 页面 + hoisted React 19）下
            渲染时报 "Objects are not valid as a React child"（真机正常、单测必炸）。
            已用 Input 组合同款外观，行为一致（2026-11-03）。 */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, marginTop: 12,
          background: C.surface, border: `1px solid ${C.line}`, borderRadius: radius.field,
          padding: '0 12px', height: 40,
        }}>
          <Icon name="search" size={16} color={C.mute} />
          <Input
            placeholder='搜索名称 / 说明'
            value={search}
            onChange={setSearch}
            style={{ '--font-size': '14px', flex: 1 }}
          />
        </div>
      </div>
      <PullToRefresh onRefresh={() => reload()}>
        <div style={{ padding: '16px 16px 0', minHeight: '60vh' }}>
      {metrics.length === 0 ? (
        <EmptyState icon="metrics" title="没有可见的指标" hint="需要管理员开通数据查询权限" />
      ) : visible.length === 0 ? (
        <EmptyState icon="search" title="没有匹配的指标" hint="换个关键词，或清空搜索" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {visible.map((m) => (
            <div key={m.id} style={{ ...cardStyle, padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                <span style={{ fontSize: 16, fontWeight: 600, color: C.ink, lineHeight: 1.4, minWidth: 0 }}>
                  {m.title}
                </span>
                <span style={{ display: 'flex', gap: 5, flex: '0 0 auto' }}>
                  <Chip tone={m.source === 'l1' ? 'accent' : 'neutral'}>{m.source === 'l1' ? '平台口径' : '自建'}</Chip>
                  {isMine(m) ? <Chip tone="warning">我的</Chip> : null}
                </span>
              </div>
              <div style={{
                fontSize: 13, color: C.sub, marginTop: 8, lineHeight: 1.65,
                display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
              }}>{m.description}</div>
              {/* 元数据（§10.4.3，#1292）：业务描述 + 单位给看数人读；未标注 = 灰字「未标注」（不编默认值）。 */}
              <div style={{
                marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.lineSoft}`,
                fontSize: 12, lineHeight: 1.7, color: m.bizDescription ? C.sub : C.mute,
              }}>
                {(m.bizDescription ? `业务描述：${m.bizDescription}` : '业务描述：未标注')
                  + (m.unit ? ` · 单位：${m.unit}` : '')}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
                <FreshnessBadge m={m} />
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {m.certified === 'certified' ? <Chip tone="success">平台认证</Chip> : null}
                  {m.certified === 'draft' ? <Chip tone="warning">未认证</Chip> : null}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
        </div>
      </PullToRefresh>
    </div>
  )
}

/**
 * 报表中心（2026-11-04，#1369；2026-11-12 站内问数退役）：移动数据 App = 「报表 / 管理 / 指标」，全接权限——
 *   · 整个 App 先过 userApp.scope=data:query（没权限的人连卡片都看不到）；
 *   · 报表 tab：服务端按数据范围（页门/部门门/ACL）过滤；管理动作只对 canEdit（owner ∪
 *     data:manage）出现——无管理权限的人只看到所有人已发布且有权限看的报表；
 *   · 指标 tab：**纯只读**（P4 写面收口，2026-11-13）——L1/L2 一视同仁只看卡片，
 *     不再有编辑草稿/确认生效/元数据/认证升降入口；提案与采纳走 agent + 变更单；
 *   · **没有问数 tab**（2026-11-12 定案）：问数只经 MCP 给 openclaw 与三方 agent。
 * 配置菜单不进移动端（产品口径见 memory surface-split-pc-config-mobile-business）。
 */
export default function App({ initialTab = 'center' }: { initialTab?: 'center' | 'reportsManage' | 'metricsManage' } = {}) {
  // ── 统一取数：tab 显隐需要先知道「有没有自己的报表/指标」──────────────────────
  const [reportRows, setReportRows] = useState<ReportRow[] | null>(null)
  const [metricsData, setMetricsData] = useState<MetricsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const [reports, metrics] = await Promise.all([
        apiGet<{ reports: ReportRow[] }>('/api/modules/data/reports'),
        apiGet<MetricsResponse>('/api/modules/data/metrics'),
      ])
      setReportRows(reports.reports)
      setMetricsData(metrics)
      setError(null)
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setError('加载失败，请稍后重试')
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const self = metricsData?.self?.userId
  const isAdmin = (metricsData?.self?.scopes ?? []).includes('data:manage')
  // ── tab 显隐（#1371）：管理 tab 只对有权者存在，不是置灰───────────────────────
  // 报表管理 = data:manage ∪ data:create ∪ 拥有可编辑报表（canEdit 由服务端按 owner/ACL 判）
  // 指标管理 = data:manage ∪ 拥有 L2（createdBy = 自己）
  const reportManage = isAdmin
    || (metricsData?.self?.scopes ?? []).includes('data:create')
    || (reportRows ?? []).some((r) => r.canEdit === true)
  const metricManage = isAdmin
    || (metricsData?.metrics ?? []).some((m) => m.source === 'l2' && m.createdBy !== undefined && m.createdBy !== null && m.createdBy === self)

  const [tab, setTab] = useState<'center' | 'reportsManage' | 'metricsManage' | 'map'>(initialTab)
  // 从报表卡「口径与来源」进来时带指标 id，地图页自动打开该指标详情
  const [mapFocus, setMapFocus] = useState<string | null>(null)
  // 线性图标 + 文字：emoji 在业务后台里像演示稿（2026-11-10 反馈）。
  const tabs = [
    { key: 'center' as const, label: '报表', icon: 'reports' as const },
    ...(reportManage ? [{ key: 'reportsManage' as const, label: '管理', icon: 'file' as const }] : []),
    ...(metricManage ? [{ key: 'metricsManage' as const, label: '指标', icon: 'metrics' as const }] : []),
    // 体系地图对所有有 data:query 的人可见（与桌面同一份数据；旧 HTML 页因此下线）
    { key: 'map' as const, label: '地图', icon: 'source' as const },
  ]
  // 当前 tab 失去权限（数据刷新后）⇒ 回落报表中心
  const active = tabs.some((t) => t.key === tab) ? tab : 'center'

  if (error !== null) return <div style={{ padding: 32, textAlign: 'center', color: '#999' }}>{error}</div>
  if (reportRows === null || metricsData === null) {
    return (
      <div style={{ padding: 12 }}>
        <Skeleton.Title animated />
        <Skeleton.Paragraph lineCount={3} animated />
        <div style={{ height: 12 }} />
        <Skeleton.Title animated />
        <Skeleton.Paragraph lineCount={3} animated />
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100dvh', background: C.bg, paddingBottom: 'calc(62px + env(safe-area-inset-bottom, 0px))' }}>
      {active === 'center' ? (
        <ReportsView rows={reportRows} reload={reload} tab="center" self={self ?? ''} onOpenMap={(id) => { setMapFocus(id ?? null); setTab('map') }} />
      ) : active === 'reportsManage' ? (
        <ReportsView rows={reportRows} reload={reload} tab="manage" self={self ?? ''} onOpenMap={(id) => { setMapFocus(id ?? null); setTab('map') }} />
      ) : active === 'map' ? (
        <SystemMapView focus={mapFocus} />
      ) : (
        <MetricsView data={metricsData} reload={reload} />
      )}
      <nav style={{
        position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 100,
        display: 'flex', background: 'rgba(255,255,255,0.94)',
        backdropFilter: 'saturate(180%) blur(16px)', WebkitBackdropFilter: 'saturate(180%) blur(16px)',
        borderTop: `1px solid ${C.line}`,
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}>
        {tabs.map((t) => {
          const on = active === t.key
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              aria-current={on ? 'page' : undefined}
              style={{
                position: 'relative', flex: 1, height: 58, border: 'none', background: 'none',
                cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center',
                justifyContent: 'center', gap: 3, fontSize: 11, letterSpacing: 0.2,
                fontWeight: on ? 600 : 400, color: on ? C.accent : C.sub,
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              {on && (
                <span aria-hidden style={{
                  position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)',
                  width: 20, height: 2, borderRadius: 1, background: C.accent,
                }} />
              )}
              <Icon name={t.icon} size={21} color={on ? C.accent : C.sub} />
              {t.label}
            </button>
          )
        })}
      </nav>
    </div>
  )
}
