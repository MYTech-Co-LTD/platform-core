// useIsMobile —— 窄屏判定的单一入口（移动端壳/页面做结构切换，不是缩放）。
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
