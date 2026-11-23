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

// ── 映射生成（gen-store-map 的纯核）────────────────────────────────────────────
// 链路（2026-11-23 实测验证：拆逗号后 206/206 命中）：employee.store_info → store_info._id
//   → store_info.store_name → dim_branch.name → dim_branch.code。

export interface StoreSourceRow { sourceId: string; name: string; storeCode?: string }
export interface DimRow { code: string; name: string; sourceBook?: string }

/** 需人工核对的原因（与业务核对表的档位一一对应） */
export type StoreReviewReason =
  | 'name_missing'          // 编码命中、名称不命中（店名演进）——扫一眼确认
  | 'name_ambiguous'        // 编码命中、名称归一后多候选（跨账套同名）——指定账套
  | 'code_and_name_disagree'// 编码与名称指向不同门店——必须裁决（源侧数据自相矛盾）
  | 'code_missing'          // 编码未命中、名称唯一命中——确认是否采用该编码
  | 'both_missing'          // 编码与名称都未命中——必须指定

export interface StoreDimHint { code: string; name: string; sourceBook?: string }

export interface StoreMatchResult {
  /** 编码 + 名称（归一）指向**同一条**平台门店 —— 100% 对上，可直接进映射 CSV */
  matched: Array<{ sourceId: string; name: string; code: string }>
  /** 其余全部进清单（带原因与平台侧线索），由业务核对后人工裁决 */
  review: Array<{
    sourceId: string
    name: string
    storeCode: string
    reason: StoreReviewReason
    /** 平台按编码找到的门店（若唯一） */
    dimByCode?: StoreDimHint
    /** 平台按名称（归一）找到的候选（最多 4 条） */
    dimByName?: StoreDimHint[]
  }>
}

/** 名称归一：NFKC + 去空白 + 去品牌前缀（品品甜/熊喵）——只用于**辅助匹配**，不用于裁决 */
function normalizeName(s: string): string {
  let x = s.normalize('NFKC').replace(/\s+/g, '')
  for (const p of ['品品甜', '熊喵']) if (x.startsWith(p)) x = x.slice(p.length)
  return x
}

/**
 * 匹配源门店与 dim_branch（2026-11-23 判据：**编码 + 名称必须指向同一条平台门店**才算对上）。
 * 编码优先（实测 296/299 同源），名称归一作辅助证据；任何不一致/缺失都进 review，**绝不猜**。
 * @param stores 源门店（store_info：sourceId=_id、name=store_name、storeCode=store_code）
 * @param dims dim_branch 的 (code, name[, source_book])
 */
export function matchStores(stores: StoreSourceRow[], dims: DimRow[]): StoreMatchResult {
  const byCode = new Map<string, StoreDimHint[]>()
  const byName = new Map<string, StoreDimHint[]>()
  for (const d of dims) {
    const code = d.code.trim()
    if (code === '') continue
    const hint: StoreDimHint = { code, name: d.name.trim(), ...(d.sourceBook ? { sourceBook: d.sourceBook } : {}) }
    const cl = byCode.get(code) ?? []
    cl.push(hint)
    byCode.set(code, cl)
    const key = normalizeName(d.name)
    if (key !== '') {
      const nl = byName.get(key) ?? []
      nl.push(hint)
      byName.set(key, nl)
    }
  }
  const matched: StoreMatchResult['matched'] = []
  const review: StoreMatchResult['review'] = []
  for (const s of stores) {
    const name = s.name.trim()
    const storeCode = (s.storeCode ?? '').trim()
    const codeHits = storeCode !== '' ? (byCode.get(storeCode) ?? []) : []
    const nameHits = byName.get(normalizeName(name)) ?? []
    const codeHit = codeHits.length === 1 ? codeHits[0] : undefined
    const nameHit = nameHits.length === 1 ? nameHits[0] : undefined
    // 100% 对上：同一条 dim 行
    if (codeHit !== undefined && nameHit !== undefined && nameHit.code === codeHit.code) {
      matched.push({ sourceId: s.sourceId, name, code: codeHit.code })
      continue
    }
    let reason: StoreReviewReason
    if (codeHit === undefined) reason = nameHit === undefined && nameHits.length === 0 ? 'both_missing' : 'code_missing'
    else if (nameHits.length === 0) reason = 'name_missing'
    else if (nameHits.length > 1) reason = 'name_ambiguous'
    else reason = 'code_and_name_disagree'
    review.push({
      sourceId: s.sourceId, name, storeCode, reason,
      ...(codeHit !== undefined ? { dimByCode: codeHit } : {}),
      ...(nameHits.length > 0 ? { dimByName: nameHits.slice(0, 4) } : {}),
    })
  }
  return { matched, review }
}

/** 把匹配结果渲染成 `--store-map` 可吃的 CSV（只含 matched；歧义/未匹配必须人工处理后再补）。 */
export function buildStoreMapCsv(result: StoreMatchResult): string {
  const lines = ['# 由 gen-store-map 生成：store_info._id,dim_branch.code', ...result.matched.map((m) => `${m.sourceId},${m.code}`)]
  return lines.join('\n') + '\n'
}
