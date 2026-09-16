// stores/index.test.tsx — 门店页（只读）：★ 无 total ⇒ 不出现分页控件
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import StoresPage from './index'

const m = vi.mocked(platformFetch)
const json = (b: unknown) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  m.mockReset()
  m.mockImplementation(async () =>
    json({ items: [{ id: 1, name: '一号店', regionId: 3, address: '某路 1 号', phone: '010-1' }] }),
  )
})
afterEach(cleanup)

describe('门店页（只读）', () => {
  it('渲染门店', async () => {
    render(<StoresPage />)
    await waitFor(() => expect(screen.getByText('一号店')).toBeInTheDocument())
    expect(screen.getByText('某路 1 号')).toBeInTheDocument()
  })

  it('★ 无 total ⇒ 不出现分页控件（不摆假页码）', async () => {
    render(<StoresPage />)
    await waitFor(() => expect(screen.getByText('一号店')).toBeInTheDocument())
    expect(document.querySelector('.ant-pagination')).toBeNull()
  })
})
