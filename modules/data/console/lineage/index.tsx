// console/lineage/index.tsx — 数据生产线独立页（2026-11-15 改「字段聚焦」视图）。
//
// 视图本体在 LineageView（体系地图的指标抽屉也用同一份，见 #2338）；
// 本页只负责指标下拉与深链 ?metric=。菜单入口已收敛到体系地图，这里保留为深链/移动端回退。
import { useEffect, useState } from 'react'
import { Card, Select } from 'antd'
import { useSearchParams } from 'react-router-dom'
import { apiGet } from '../lib/api'
import LineageView, { LineageEmpty } from './LineageView'

interface MetricOption { id: string; title: string }

export default function LineagePage() {
  const [params, setParams] = useSearchParams()
  const metricId = params.get('metric')
  const [options, setOptions] = useState<MetricOption[]>([])

  useEffect(() => {
    apiGet('/metrics')
      .then((r) => {
        const list = (r as { metrics?: Array<{ id: string; title: string }> }).metrics ?? []
        setOptions(list.map((m) => ({ id: m.id, title: m.title })))
      })
      .catch(() => setOptions([]))
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Select
        showSearch
        placeholder="选一个指标"
        style={{ minWidth: 300, maxWidth: 420 }}
        value={metricId ?? undefined}
        onChange={(v) => setParams({ metric: String(v) }, { replace: true })}
        options={options.map((o) => ({ value: o.id, label: `${o.title} · ${o.id}` }))}
        filterOption={(input, option) => String(option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
      />

      {metricId === null || metricId === ''
        ? <Card><LineageEmpty description="选一个指标，看它的字段从源接口一路变成业务度量" /></Card>
        : <LineageView metricId={metricId} showTitle />}
    </div>
  )
}
