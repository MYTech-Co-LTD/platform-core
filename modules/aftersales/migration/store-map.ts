// store-map.ts — 无忌门店 id → dim_branch.code 的翻译层（纯函数，迁移配置的一部分）。
//
// 为什么需要它（2026-11-23 冷启动裁决）：
//   `importEmployee` 的门店引用原样落「aftersales.store 本地 id」（或空），而运行时要的是
//   `data.dim_branch.code`（乐檬门店编码）——两套编码、无映射表。不做翻译，导入后员工门店归属
//   是错编码（比空更危险：看起来有值、实际对不上）。
//
// 形态：CSV，每行 `无忌门店id,dim_branch.code`。支持：
//   · 表头（只认显式白名单 wuji_store_id/store_id/dim_code/code 等，不按「像不像 id」猜）
//   · `#` 开头注释行、空行
//   · 重复的无忌 id：后者覆盖、计入 duplicates（重跑可复现，不静默二选一）
//   · 非法行（列数 ≠ 2 / 空白）：计入 errors 并**整体失败**——映射是迁移配置，不允许半信半疑
//
// 映射文件本身不进仓（含客户门店编码清单）：与运行数据同纪律——作为迁移配置随部署环境投递，
// 不落仓、不进日志（日志只打印条数与未命中计数）。

const HEADER_COLS = new Set(['wuji_store_id', 'store_id', '无忌门店id', 'dim_code', 'code', 'dim_branch_code'])

export interface StoreMapParseResult {
  map: Map<string, string>
  duplicates: number
  errors: string[]
}

/**
 * 解析映射 CSV。错误非空 ⇒ 调用方必须拒绝执行导入（fail-closed：错的映射比没有映射更贵）。
 * @param csv @returns 解析结果（errors 为空才可用）
 */
export function parseStoreMap(csv: string): StoreMapParseResult {
  const map = new Map<string, string>()
  const errors: string[] = []
  let duplicates = 0
  const lines = csv.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim()
    if (raw === '' || raw.startsWith('#')) continue
    const cols = raw.split(',').map((s) => s.trim())
    // 表头：只认**显式白名单**（别按「像不像 id」猜——门店 id 可以是任意字符串）。
    // 认不出就按数据行处理；真带别的表头，非法列会走下面的 errors（fail-closed，不会静默吞）。
    if (i === 0 && HEADER_COLS.has(cols[0].toLowerCase()) && HEADER_COLS.has(cols[1]?.toLowerCase() ?? '')) continue
    if (cols.length !== 2 || cols[0] === '' || cols[1] === '') {
      errors.push(`第 ${i + 1} 行不是两列非空的 \`无忌门店id,dim_code\`：${raw.slice(0, 60)}`)
      continue
    }
    if (map.has(cols[0])) duplicates++
    map.set(cols[0], cols[1])
  }
  return { map, duplicates, errors }
}
