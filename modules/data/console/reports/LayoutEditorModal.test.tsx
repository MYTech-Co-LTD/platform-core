// LayoutEditorModal.test.tsx — 24 栅格版式编辑器（issue #2295）。
//
// 验的是**交互契约**，不是视觉：换位/改宽/保存回传/多页隔离。
// 触屏/键盘路径（↑ ↓ ‹ › 按钮）与鼠标路径（拖动、拖边）都要有用例——
// 只测按钮会漏掉「拖到别处」的 bug，只测拖动则会漏掉「触屏用户没入口」。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LayoutEditorModal, type LayoutEditorPanel } from './LayoutEditorModal'

const panels: LayoutEditorPanel[] = [
  { key: '1|line|甲', title: '甲', chart: 'line', span: 12, page: 1 },
  { key: '1|line|乙', title: '乙', chart: 'line', span: 12, page: 1 },
  { key: '1|table|丙', title: '丙', chart: 'table', span: 24, page: 1 },
]
const items = panels.map((p) => ({ key: p.key, span: p.span }))

const cardOrder = (): string[] =>
  Array.from(document.querySelectorAll('[data-testid^="layout-card-"]'))
    .map((el) => el.getAttribute('data-testid')!.replace('layout-card-', ''))

function setup(over: Partial<ComponentProps<typeof LayoutEditorModal>> = {}) {
  const onSave = vi.fn()
  render(
    <LayoutEditorModal
      open panels={panels} initialItems={items}
      onCancel={() => {}} onSave={onSave}
      {...over}
    />,
  )
  return { onSave }
}

afterEach(() => { cleanup() })

describe('LayoutEditorModal', () => {
  it('打开即按初始版式渲染；按钮改宽只动该面板', () => {
    setup()
    expect(cardOrder()).toEqual(['1|line|甲', '1|line|乙', '1|table|丙'])
    // 第一张卡的「变宽」
    const widen = screen.getAllByRole('button', { name: '变宽' })[0]
    fireEvent.click(widen)
    expect(screen.getByTestId('layout-card-1|line|甲')).toHaveTextContent('宽 13/24')
    expect(screen.getByTestId('layout-card-1|line|乙')).toHaveTextContent('宽 12/24')
  })

  it('宽度夹在 1..24（连点不会越界）', () => {
    setup({ initialItems: [{ key: '1|line|甲', span: 24 }] })
    const narrow = screen.getAllByRole('button', { name: '变宽' })[0]
    fireEvent.click(narrow)
    expect(screen.getByTestId('layout-card-1|line|甲')).toHaveTextContent('宽 24/24')
  })

  it('后移/前移改变次序（键盘/触屏路径）', () => {
    setup()
    fireEvent.click(screen.getAllByRole('button', { name: '后移' })[0])
    expect(cardOrder()).toEqual(['1|line|乙', '1|line|甲', '1|table|丙'])
    fireEvent.click(screen.getAllByRole('button', { name: '前移' })[1])
    expect(cardOrder()).toEqual(['1|line|甲', '1|line|乙', '1|table|丙'])
  })

  it('拖动换位（HTML5 DnD 路径）', () => {
    setup()
    const from = screen.getByTestId('layout-card-1|table|丙')
    const to = screen.getByTestId('layout-card-1|line|甲')
    fireEvent.dragStart(from)
    fireEvent.dragOver(to)
    fireEvent.drop(to)
    expect(cardOrder()).toEqual(['1|table|丙', '1|line|甲', '1|line|乙'])
  })

  it('保存回传当前条目（顺序 + 宽度）', () => {
    const { onSave } = setup()
    fireEvent.click(screen.getAllByRole('button', { name: '变窄' })[2])   // 丙 24 → 23
    fireEvent.click(screen.getAllByRole('button', { name: '后移' })[0])   // 甲 后移
    fireEvent.click(screen.getByRole('button', { name: /保\s*存/ }))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0][0]).toEqual([
      { key: '1|line|乙', span: 12 },
      { key: '1|line|甲', span: 12 },
      { key: '1|table|丙', span: 23 },
    ])
  })

  it('错误信息原位显示（保存失败不由组件吞掉）', () => {
    setup({ error: '报表已更新，请重新打开「编辑版式」' })
    expect(screen.getByText('报表已更新，请重新打开「编辑版式」')).toBeInTheDocument()
  })

  it('多页：只显示当前页；换页后仍是同一份条目集合', () => {
    const multi: LayoutEditorPanel[] = [
      ...panels,
      { key: '2|kpi|丁', title: '丁', chart: 'kpi', span: 12, page: 2 },
    ]
    setup({
      panels: multi,
      pageTitles: ['概览', '明细'],
      initialItems: multi.map((p) => ({ key: p.key, span: p.span })),
    })
    expect(cardOrder()).toEqual(['1|line|甲', '1|line|乙', '1|table|丙'])
    fireEvent.click(screen.getByText('明细'))
    expect(cardOrder()).toEqual(['2|kpi|丁'])
  })
})
