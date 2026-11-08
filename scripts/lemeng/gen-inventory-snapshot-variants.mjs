// gen-inventory-snapshot-variants.mjs — 库存快照管线的**变体生成器**（变体 JSON 不手编）。
//
// 主管线（每个账套一份，**由 manifest 生成**，见 deploy/duckle/manifests/
// lemeng.inventory.snapshot.l0*.json）是唯一事实源：窗口 `${date-2d}`、排班日内 5 轮。
//   3120：30 页 × 200；64188：92 页 × 200（页数不同 ⇒ 各自一份 manifest，不能合并成 accounts[]）。
// 本脚本由它机械派生两个变体（每账套各一套，共 4 个文件）：
//
//   ① catchup.<book>  —— 窗口 `${date-3d}`，排班 00:35 CST 每日一轮。
//      兜底：主轮当天全空（源端未发布）时补前一天，保证任何一天最多晚一天到湖。
//   ② backfill.<book> —— 窗口 `${BIZDAY}`，不排班（EXEMPT_GLOBAL），
//      回填时 POST /api/run 传 params={BIZDAY:'YYYY-MM-DD'}。
//      （64188 的 backfill 曾由 gen-backfill-variants.mjs 派生；2026-11-08 起归本脚本，
//       避免两个生成器同时拥有同一个文件。）
//
// 为什么变体不手编：三个文件只差「窗口 token + 管线名 + 空集文案」。主管线加页/改契约时，
// 跑一次本脚本三个文件同步；手编必然漂移（#931/#939 那两轮改动就是这么把窗口推错的）。
// CI 用 `--check` 钉住「生成物 == committed」。
//
// 用法（仓根跑）：
//   node scripts/lemeng/gen-inventory-snapshot-variants.mjs           # 生成/覆盖两个变体
//   node scripts/lemeng/gen-inventory-snapshot-variants.mjs --check   # 只比对，漂移 exit 1
//
// 产出后必须：duckle MCP validate_pipeline 过 → 才许提交（口径：仓内文件 = 引擎验过的）。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const DIR = 'deploy/duckle/console/pipelines'
// 两个账套各一份主管线（页数不同：3120 30 页 / 64188 92 页 ⇒ 不能共用一个 manifest）。
const BOOKS = ['3120', '64188']
// 主管线的窗口 token。改主管线窗口时**必须**同步改这里（下面的断言会拦住漏改）。
const MAIN_WINDOW = '${date-2d}'
const CHECK = process.argv.includes('--check')

/**
 * 宽页回填变体（只给 3120）：2025 年那段的库存快照**单日 6–8 万行**（2026-11-08 直探源 API 实测：
 * 2025-08-14 第 350 页仍有 157 行 ⇒ 69,957 行/天），主管线的 30 页 × 200 装不下——装到 6,000 就
 * 触发截断哨兵。宽变体把页数扩到 360（容量 72,000），只用于历史补采。
 * 64188 不需要：它的历史完整（2024-11-01 起 736 天，逐日行数与源端对得上）。
 * @type {{ book: string, pages: number, pageSize: number } | null}
 */
const WIDE = { book: '3120', pages: 360, pageSize: 200 }

/**
 * 变体定义：suffix 决定文件名与管线名；window 是替换后的窗口 token。
 * message 是函数——空集文案里要带**本账套**的兜底/回填管线名，写死 3120 会误导 64188 的值班人。
 * @type {{ suffix: string, window: string, label: string, message: (book: string) => string }[]}
 */
const VARIANTS = [
  {
    suffix: 'catchup',
    window: '${date-3d}',
    label: '空集 ⇒ 具名状态（兜底也没拿到；T-3 距日结 ≥72h，此时零行 = 源端真缺这一天）',
    message: (book) =>
      'SOURCE_NOT_PUBLISHED: bizday=${date-3d} 源端零行——**兜底轮次也没拿到**。本管线窗口为 T-3，' +
      '距营业日日结 ≥72h，远超源端实测发布上限 46.6~48.2h（2026-10-26 探针实测）⇒ 此刻零行意味着' +
      '**源端真的缺这一天**（当日未日结/未结转），不是窗口问题。处置：先手工探一次该 bizday 确认；' +
      `确属源端缺失则登记进正典 §1.7 台账，源端补齐后用 lemeng.inventory.snapshot.backfill.${book} 补采。`,
  },
  {
    suffix: 'backfill',
    window: '${BIZDAY}',
    label: '空集 ⇒ 具名状态（回填日源端无结转记录）',
    message: () =>
      'SOURCE_NOT_PUBLISHED: bizday=${BIZDAY} 源端零行——该营业日没有匹配的结转记录。' +
      '本管线是**回填通道**：必须经 POST /api/run 显式传 params={BIZDAY:"YYYY-MM-DD"} 驱动。' +
      '参数形状正确仍为零 ⇒ 源端这一天确实没结转：登记进正典 §1.7 台账后跳过，别反复重试。',
  },
]

/** @param {unknown} v @param {string} from @param {string} to @returns {unknown} */
function replaceToken(v, from, to) {
  if (typeof v === 'string') return v.split(from).join(to)
  if (Array.isArray(v)) return v.map((x) => replaceToken(x, from, to))
  if (v !== null && typeof v === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const [k, x] of Object.entries(v)) out[k] = replaceToken(x, from, to)
    return out
  }
  return v
}

let drift = false

/**
 * 落盘/比对一份生成物（CHECK 只比不写）。
 * @param {string} out @param {any} pipeline @param {string} tag
 */
function emit(out, pipeline, tag) {
  const body = JSON.stringify(pipeline, null, 2) + '\n'
  if (CHECK) {
    /** @type {string | null} */
    let onDisk = null
    try {
      onDisk = readFileSync(out, 'utf8')
    } catch {
      console.error(`GEN_DRIFT: ${out} 不存在（跑了生成器没提交？）`)
      drift = true
      return
    }
    if (onDisk !== body) {
      console.error(`GEN_DRIFT: ${out} 与主管线派生结果不一致（改了主管线没重跑生成器？）`)
      drift = true
    } else {
      console.log(`ok: ${out}`)
    }
  } else {
    writeFileSync(out, body)
    console.log(`written: ${out} (name=${pipeline.name} ${tag})`)
  }
}

/**
 * 把静态页节点从 N 页扩到 `pages` 页：克隆末页模板，逐页改写 `page_number`，接到 merge 的 main_i；
 * 同时把截断哨兵的阈值与文案改成新容量（否则 360 页的管线还按 30 页判截断）。
 * @param {any} pipeline @param {number} pages @param {number} pageSize
 */
function expandPages(pipeline, pages, pageSize) {
  const pageIds = pipeline.nodes
    .map((/** @type {any} */ n) => /^p(\d+)$/.exec(String(n.id)))
    .filter((/** @type {RegExpExecArray | null} */ m) => m !== null)
    .map((/** @type {RegExpExecArray} */ m) => Number(m[1]))
  const have = Math.max(...pageIds)
  if (have >= pages) return
  /** @type {any} */
  const template = pipeline.nodes.find((/** @type {any} */ n) => n.id === `p${have}`)
  for (let i = have + 1; i <= pages; i += 1) {
    /** @type {any} */
    const node = structuredClone(template)
    node.id = `p${i}`
    node.data.label = `page ${i}`
    node.data.properties.body = String(node.data.properties.body).replace(
      /"page_number"\s*:\s*\d+/,
      `"page_number":${i}`,
    )
    pipeline.nodes.push(node)
    pipeline.edges.push({
      id: `e-p${i}-m`,
      source: `p${i}`,
      target: 'merge',
      sourceHandle: 'main',
      targetHandle: `main_${i}`,
      data: { connectionType: 'main' },
    })
  }
  const threshold = pages * pageSize
  /** @type {any} */
  const guard = pipeline.nodes.find((/** @type {any} */ n) => n.id === 'q')
  if (guard !== undefined) {
    guard.data.properties.sql = String(guard.data.properties.sql).replace(/=\s*\d+/, `= ${threshold}`)
  }
  /** @type {any} */
  const die = pipeline.nodes.find((/** @type {any} */ n) => n.id === 'dg')
  if (die !== undefined) {
    die.data.properties.message = String(die.data.properties.message).replace(
      /（\d+×\d+=\d+）/,
      `（${pages}×${pageSize}=${threshold}）`,
    )
  }
}

for (const book of BOOKS) {
  const MAIN_NAME = `lemeng.inventory.snapshot.l0.${book}`
  const mainPath = join(DIR, `${MAIN_NAME}.json`)
  const mainRaw = readFileSync(mainPath, 'utf8')
  /** @type {any} */
  const mainPipeline = JSON.parse(mainRaw)

  if (mainPipeline.name !== MAIN_NAME) {
    console.error(`${mainPath} 顶层 name 应为 ${MAIN_NAME}，实际 ${String(mainPipeline.name)}`)
    process.exit(2)
  }
  const tokenCount = mainRaw.split(MAIN_WINDOW).length - 1
  if (tokenCount < 30) {
    console.error(
      `${mainPath} 里 ${MAIN_WINDOW} 只出现 ${tokenCount} 次（期望 ≥30：p1..pN + gv + shape + sink + die_empty）` +
        '——主管线窗口改过却没同步本脚本的 MAIN_WINDOW？',
    )
    process.exit(2)
  }

  for (const v of VARIANTS) {
    /** @type {any} */
    const pipeline = replaceToken(structuredClone(mainPipeline), MAIN_WINDOW, v.window)
    pipeline.name = `lemeng.inventory.snapshot.${v.suffix}.${book}`
    /** @type {any} */
    const dieEmpty = pipeline.nodes.find((/** @type {any} */ n) => n.id === 'die_empty')
    if (dieEmpty === undefined) {
      console.error(`${mainPath} 缺 die_empty 节点——派生变体的空集文案无处落位`)
      process.exit(2)
    }
    dieEmpty.data.label = v.label
    dieEmpty.data.properties.message = v.message(book)

    const out = join(dirname(mainPath), `lemeng.inventory.snapshot.${v.suffix}.${book}.json`)
    emit(out, pipeline, `${v.suffix}.${book}`)

    // 宽页回填变体：只给 WIDE.book，且从**回填变体**再扩页（窗口/空集文案都一样，只多页）。
    if (v.suffix === 'backfill' && WIDE !== null && book === WIDE.book) {
      /** @type {any} */
      const wide = structuredClone(pipeline)
      expandPages(wide, WIDE.pages, WIDE.pageSize)
      wide.name = `lemeng.inventory.snapshot.backfill.wide.${book}`
      const wideOut = join(dirname(mainPath), `lemeng.inventory.snapshot.backfill.wide.${book}.json`)
      emit(wideOut, wide, `backfill.wide.${book}（${WIDE.pages} 页）`)
    }
  }
}

if (CHECK && drift) {
  console.error('怎么修：node scripts/lemeng/gen-inventory-snapshot-variants.mjs 后一并提交')
  process.exit(1)
}
