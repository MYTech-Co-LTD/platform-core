// console/lib/useList.ts — 列表页的加载 / 错误 / 重载（各列表页共用）。
//
// 只管这三件事。**分页能力不塞进本 hook**——它按端点能力而定：GET /tickets 与 /products 回
// `total` 可服务端分页，而 /rules /employees /stores 只回 `{items}` ⇒ 单页展示、不摆假页码。
// 谁用谁决定（spec §3.1 的已知边界）。
import { useCallback, useEffect, useState } from 'react'
import { messageOf } from './api'

export interface ListState<T> {
  items: T[]
  loading: boolean
  error: string | null
  reload: () => void
}

/**
 * ⚠️ `load` 必须是 `useCallback` 固定的（否则每次渲染都是新函数 ⇒ 无限重取）。
 * 依赖变化请用返回的 `reload()` 触发，不要靠换 `load` 的身份。
 */
export function useList<T>(load: () => Promise<T[]>): ListState<T> {
  const [items, setItems] = useState<T[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    load()
      .then((rows) => {
        if (alive) setItems(rows)
      })
      .catch((e: unknown) => {
        if (alive) {
          setItems([])
          setError(messageOf(e))
        }
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [load, nonce])

  return { items, loading, error, reload }
}
