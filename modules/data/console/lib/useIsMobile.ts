// useIsMobile —— 窄屏判定的单一入口（console 表格页在手机上换成卡片列表）。
//
// 为什么不用 antd 的 Grid.useBreakpoint：本页的移动布局是**结构切换**（表格 → 卡片），
// 不是加个 class；用原生 matchMedia 更直观、也不依赖 Grid 的 SSR 断点表。
import { useEffect, useState } from 'react'

export const MOBILE_QUERY = '(max-width: 767px)'

export function useIsMobile(query: string = MOBILE_QUERY): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false
  ))

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(query)
    const onChange = () => setIsMobile(mq.matches)
    setIsMobile(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])

  return isMobile
}
