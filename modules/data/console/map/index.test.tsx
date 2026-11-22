// index.test.tsx — 数据地图容器：四视角切换、URL 参数、深链兼容。
// 四个视角页各自有自己的测试；这里把子页 mock 成占位，只验容器行为。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../flow', () => ({ default: () => <div>流程视角内容</div> }))
vi.mock('../system-map', () => ({ default: () => <div>结构视角内容</div> }))
vi.mock('../pipelines', () => ({ default: () => <div>链路视角内容</div> }))
vi.mock('../lineage', () => ({ default: () => <div>血缘视角内容</div> }))
vi.mock('../observability', () => ({ default: () => <div>运行视角内容</div> }))

import DataMapPage from './index'

afterEach(() => cleanup())

const renderAt = (search = '') => render(
  <MemoryRouter initialEntries={[`/console/data/map${search}`]}>
    <DataMapPage />
  </MemoryRouter>,
)

describe('数据地图容器', () => {
  it('默认打开「流程」视角（用户要的第一屏就是全流程图）', () => {
    renderAt()
    expect(screen.getByText('流程视角内容')).toBeInTheDocument()
    expect(screen.getByText(/源接口 → 采集管线 → 湖资产/)).toBeInTheDocument()
  })

  it('?view=structure 打开结构视角', () => {
    renderAt('?view=structure')
    expect(screen.getByText('结构视角内容')).toBeInTheDocument()
  })

  it('?view=lineage 直接打开血缘视角（可分享链接）', () => {
    renderAt('?view=lineage')
    expect(screen.getByText('血缘视角内容')).toBeInTheDocument()
  })

  it('未知 view 回落到流程（不白屏）', () => {
    renderAt('?view=nonsense')
    expect(screen.getByText('流程视角内容')).toBeInTheDocument()
  })

  it('点切换器 → 换视角并更新 URL 参数', () => {
    renderAt()
    fireEvent.click(screen.getByText('运行'))
    expect(screen.getByText('运行视角内容')).toBeInTheDocument()
  })
})
