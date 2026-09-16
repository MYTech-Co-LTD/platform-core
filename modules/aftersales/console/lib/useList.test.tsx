// lib/useList.test.tsx — 列表 hook：加载态 → 数据；失败 → 错误文案；reload 重取
import '@testing-library/jest-dom/vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import { useList } from './useList'

describe('useList', () => {
  it('成功：loading 从 true 落到 false，items 就位', async () => {
    const load = vi.fn().mockResolvedValue([{ id: 1 }])
    const { result } = renderHook(() => useList(load))
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.items).toEqual([{ id: 1 }])
    expect(result.current.error).toBeNull()
  })

  it('失败：items 清空 + error 是可展示文案（不是裸错误对象）', async () => {
    const load = vi.fn().mockRejectedValue(new ApiError(403, 'FORBIDDEN'))
    const { result } = renderHook(() => useList(load))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.items).toEqual([])
    expect(result.current.error).toBe('没有权限执行该操作')
  })

  it('reload 重新调用 load', async () => {
    const load = vi.fn().mockResolvedValue([])
    const { result } = renderHook(() => useList(load))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(load).toHaveBeenCalledTimes(1)
    act(() => result.current.reload())
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
  })
})
