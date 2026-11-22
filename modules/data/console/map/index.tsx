// console/map/index.tsx — 「数据地图」容器（2026-11-22，#2685）。
//
// 为什么合并：体系地图 / 管线地图 / 字段血缘 / 运行观测 是**同一套数据体系的四个视角**，
// 拆成四个顶级菜单让导航膨胀、也让人不知道从哪进。本页把四个视角收进一个入口，
// 顶部用切换器（Segmented）选视角，URL 带 `?view=` 可分享。
//
// 与 #1953「不要把功能页塞回页内 tab」的关系（**本次是修订，不是回潮**）：
//   · 那条决策的对象是**不同职能**的功能页（指标 / 报表 / 数据范围…）——它们彼此无关，
//     放菜单各自直达是对的；
//   · 本页收的是**同族视角**（都在回答「这套数据体系长什么样 / 通不通 / 怎么算 / 跑得怎么样」），
//     同族放一个入口、族内切换，正是菜单层级的正常用法。
//   · 四个旧路径 `/console/data/{system-map,pipelines,lineage,observability}` **保留**（menu:false），
//     老链接与深链不受影响。
import { Segmented, Typography } from 'antd'
import { useSearchParams } from 'react-router-dom'
import FlowPage from '../flow'
import SystemMapPage from '../system-map'
import LineagePage from '../lineage'
import ObservabilityPage from '../observability'

type ViewKey = 'flow' | 'structure' | 'lineage' | 'runtime'

const VIEWS: Array<{ key: ViewKey; label: string; hint: string; render: () => React.JSX.Element }> = [
  {
    key: 'flow',
    label: '流程',
    hint: '一张图看完整链路：源接口 → 采集管线 → 湖资产 → staging → marts → 指标 → 消费面。点节点看成员。',
    render: () => <FlowPage />,
  },
  {
    key: 'structure',
    label: '结构',
    hint: '业务对象、指标与字段之间的关系——先看「有什么」。点指标节点看口径、运行态与字段链路。',
    render: () => <SystemMapPage />,
  },
  {
    key: 'lineage',
    label: '血缘',
    hint: '选一个指标，看它从源接口到成品的每一跳：来源路径、staging 转换、聚合公式、指标口径。',
    render: () => <LineagePage />,
  },
  {
    key: 'runtime',
    label: '运行',
    hint: '现在跑得怎么样：调度档位、体检清单、湖卫生、物化水位、对账差异。30 秒自动刷新。',
    render: () => <ObservabilityPage />,
  },
]

export default function DataMapPage() {
  const [params, setParams] = useSearchParams()
  const raw = params.get('view') ?? 'flow'
  const active: ViewKey = (VIEWS.some((v) => v.key === raw) ? raw : 'flow') as ViewKey
  const view = VIEWS.find((v) => v.key === active) ?? VIEWS[0]

  return (
    <div>
      <Segmented
        value={active}
        onChange={(v) => {
          const next = new URLSearchParams(params)
          next.set('view', String(v))
          setParams(next, { replace: true })
        }}
        options={VIEWS.map((v) => ({ label: v.label, value: v.key }))}
        style={{ marginBottom: 8 }}
      />
      <Typography.Paragraph type="secondary" style={{ fontSize: 12.5, margin: '0 0 14px' }}>
        {view.hint}
      </Typography.Paragraph>
      {view.render()}
    </div>
  )
}
