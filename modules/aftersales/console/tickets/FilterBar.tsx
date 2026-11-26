// FilterBar.tsx — 状态 / 品牌胶囊（带计数）。2026-11-26 / #2884，spec §3.2。
//
// 交互：点未选中的 ⇒ 选中并查询；点已选中的 ⇒ 回到「全部/取消」。这是胶囊与单选组的关键差别——
// 用户要能「点回去」，否则选错了只能刷新页面。
import type { ReactNode } from 'react'
import type { Brand, TicketCounts, TicketStatus } from '../../api-types'
import { BRAND_LABEL } from './lib/labels'

function Pill(props: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={props.active}
      onClick={props.onClick}
      style={{
        borderRadius: 999,
        border: `1px solid ${props.active ? '#4D6BFE' : '#EBEDF0'}`,
        background: props.active ? '#4D6BFE' : '#FFFFFF',
        color: props.active ? '#FFFFFF' : '#1B1C1E',
        padding: '4px 12px',
        fontSize: 13,
        lineHeight: '20px',
        cursor: 'pointer',
      }}
    >
      {props.children}
    </button>
  )
}

export function FilterBar(props: {
  status: '' | TicketStatus
  brand: '' | Brand
  counts: TicketCounts | null
  onStatus: (v: '' | TicketStatus) => void
  onBrand: (v: '' | Brand) => void
}) {
  const s = props.counts?.status
  const b = props.counts?.brand
  const pickStatus = (v: TicketStatus): void => props.onStatus(props.status === v ? '' : v)
  const pickBrand = (v: Exclude<Brand, ''>): void => props.onBrand(props.brand === v ? '' : v)

  return (
    <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <Pill active={props.status === ''} onClick={() => props.onStatus('')}>全部 {s?.all ?? 0}</Pill>
        <Pill active={props.status === 'pending'} onClick={() => pickStatus('pending')}>
          待处理 {s?.pending ?? 0}
        </Pill>
        <Pill active={props.status === 'completed'} onClick={() => pickStatus('completed')}>
          已处理 {s?.completed ?? 0}
        </Pill>
        <Pill active={props.status === 'cancelled'} onClick={() => pickStatus('cancelled')}>
          已驳回 {s?.cancelled ?? 0}
        </Pill>
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {(['xiongmao', 'pptd'] as const).map((v) => (
          <Pill key={v} active={props.brand === v} onClick={() => pickBrand(v)}>
            {BRAND_LABEL[v]} {v === 'xiongmao' ? (b?.xiongmao ?? 0) : (b?.pptd ?? 0)}
          </Pill>
        ))}
      </div>
    </div>
  )
}
