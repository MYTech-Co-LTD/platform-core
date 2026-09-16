/**
 * 售后工单相关工具函数
 */

import dayjs from 'dayjs'

/**
 * 格式化时间显示（只显示日期）
 * @param timestamp 时间戳或日期字符串
 * @returns 格式化后的日期字符串
 */
export function formatTimeDisplay(timestamp: number | string): string {
  if (!timestamp) return '-'
  
  // 如果是字符串，先判断是否是日期时间格式
  if (typeof timestamp === 'string') {
    // 如果已经是日期格式（包含日期分隔符），直接格式化
    if (timestamp.includes('-') || timestamp.includes('/')) {
      return dayjs(timestamp).format('YYYY-MM-DD')
    }
    // 否则尝试解析为时间戳
    const parsed = parseInt(timestamp, 10)
    if (!isNaN(parsed)) {
      return dayjs(parsed).format('YYYY-MM-DD')
    }
    return '-'
  }
  
  // 如果是数字，作为时间戳处理
  if (typeof timestamp === 'number') {
    // 判断是秒级还是毫秒级时间戳（毫秒级通常大于 10000000000）
    const isMilliseconds = timestamp > 10000000000
    return dayjs(isMilliseconds ? timestamp : timestamp * 1000).format('YYYY-MM-DD')
  }
  
  return '-'
}

/**
 * 将时间转换为时间戳（毫秒）
 * @param time 时间值（可能是数字或字符串）
 * @returns 毫秒时间戳
 */
export function toTimestamp(time: number | string): number {
  if (typeof time === 'number') {
    return time
  }
  return dayjs(time).valueOf()
}
