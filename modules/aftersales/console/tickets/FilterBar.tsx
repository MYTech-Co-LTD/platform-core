// FilterBar.tsx — 状态 / 等级 / 品牌胶囊（2026-11-26 / #2884，#2892/#2924 通用化）。
//
// 层级：状态 → 搜索/时间 → 等级 → 品牌（最末级）。选项/名称/计数全部来自
// `GET /tickets/counts`（data 稳定视图 ∪ 工单历史快照）。
// `showFilter=false` 时整行不渲染；2–4 个用胶囊，5+ 用 Select；未分类/未分级是一等选项。
import type { ReactNode } from 'react'
import { Select } from 'antd'
import type { BrandOption, TicketCounts, TicketStatus } from '../../api-types'

/** 与 routes/ticket-query.ts 的保留值一致。 */
const UNCLASSIFIED = '__unclassified__'
const UNLEVELED = '__unleveled__'
const PILL_LIMIT = 4

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
  level: string
  brand: string
  counts: TicketCounts | null
  onStatus: (v: '' | TicketStatus) => void
  onLevel: (v: string) => void
  onBrand: (v: string) => void
}) {
  const s = props.counts?.status
  const levelFacet = props.counts?.level
  const brand = props.counts?.brand
  const levelOptions: BrandOption[] = levelFacet?.options ?? []
  const options: BrandOption[] = brand?.options ?? []
  const pickStatus = (v: TicketStatus): void => props.onStatus(props.status === v ? '' : v)
  const pickLevel = (v: string): void => props.onLevel(props.level === v ? '' : v)
  const pickBrand = (v: string): void => props.onBrand(props.brand === v ? '' : v)

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

      {levelFacet?.showFilter ? (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {levelOptions.length > PILL_LIMIT ? (
            <Select
              aria-label="门店等级筛选"
              allowClear
              placeholder="全部门店等级"
              style={{ width: 180 }}
              value={props.level || undefined}
              onChange={(v?: string) => props.onLevel(v ?? '')}
              options={[
                ...levelOptions.map((o) => ({ value: o.code, label: `${o.name} ${o.count}` })),
                ...(levelFacet.unleveled > 0
                  ? [{ value: UNLEVELED, label: `未分级 ${levelFacet.unleveled}` }]
                  : []),
              ]}
            />
          ) : (
            <>
              {levelOptions.map((o) => (
                <Pill key={o.code} active={props.level === o.code} onClick={() => pickLevel(o.code)}>
                  {o.name} {o.count}
                </Pill>
              ))}
              {levelFacet.unleveled > 0 ? (
                <Pill active={props.level === UNLEVELED} onClick={() => pickLevel(UNLEVELED)}>
                  未分级 {levelFacet.unleveled}
                </Pill>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {brand?.showFilter ? (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {options.length > PILL_LIMIT ? (
            <Select
              aria-label="品牌筛选"
              allowClear
              placeholder="全部品牌"
              style={{ width: 180 }}
              value={props.brand || undefined}
              onChange={(v?: string) => props.onBrand(v ?? '')}
              options={[
                ...options.map((o) => ({ value: o.code, label: `${o.name} ${o.count}` })),
                ...(brand.unclassified > 0
                  ? [{ value: UNCLASSIFIED, label: `未分类 ${brand.unclassified}` }]
                  : []),
              ]}
            />
          ) : (
            <>
              {options.map((o) => (
                <Pill key={o.code} active={props.brand === o.code} onClick={() => pickBrand(o.code)}>
                  {o.name} {o.count}
                </Pill>
              ))}
              {brand.unclassified > 0 ? (
                <Pill active={props.brand === UNCLASSIFIED} onClick={() => pickBrand(UNCLASSIFIED)}>
                  未分类 {brand.unclassified}
                </Pill>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
