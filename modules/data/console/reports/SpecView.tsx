// SpecView.tsx — console 内嵌的**薄壳**：按 id 拉规格 → `<ReportView chrome="console"/>`。
//
// 2026-10-26 Task 6 起渲染主体（期间控件 / KPI / 文本 / 服务端分组 / 信任信号 / 图表）
// 全部搬到 `./ReportView.tsx`——本文件只保留「加载 + 失败面 + 壳参数」三件事，
// 调用方（`./index.tsx` 的 platform 行「打开」）**签名与行为不变**：
//
//  · 无 period 的旧规格：ReportView 走 RangePicker + 面板 args 的既有路径（逐字节不变）；
//  · 有 period 的新规格：期间控件接管 bizday 窗口；
//  · 响应形状仍是 platform 路径的 `{spec, version}`（**刻意**与 Metabase 路径不同）；
//  · 读侧最小形状闸（fail-closed）：规格在写入侧已过白名单（parseReportSpec），这里只拦
//    「连 panels 都不是数组」这种彻底坏的响应，不让它进渲染循环。
import { useEffect, useState } from 'react'
import { Alert, Spin } from 'antd'
import { apiGet, messageOf } from '../lib/api'
import type { ReportSpec } from '../../domain/report-spec'
import ReportView from './ReportView'

export default function SpecView({ reportId, title, onClose }: { reportId: string; title: string; onClose: () => void }) {
  const [spec, setSpec] = useState<ReportSpec | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    apiGet(`/reports/${reportId}/spec`)
      .then((b) => {
        if (!alive) return
        const loaded = (b as { spec?: ReportSpec }).spec
        if (loaded === undefined || loaded === null || typeof loaded !== 'object' || !Array.isArray(loaded.panels)) {
          setFailed('报表规格不合法，请联系平台侧')
          return
        }
        setSpec(loaded)
      })
      .catch((e) => { if (alive) setFailed(messageOf(e)) })
    return () => { alive = false }
  }, [reportId])

  if (failed !== null) return <Alert type="error" showIcon message={failed} />
  if (spec === null) return <Spin />
  // key=reportId：切报表时重建内部状态（期间/筛选覆盖/面板结果），不跨报表串味。
  return <ReportView key={reportId} title={title} spec={spec} chrome="console" onClose={onClose} />
}
