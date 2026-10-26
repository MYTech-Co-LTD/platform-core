// gen-inventory-snapshot-variants.mjs — 库存快照管线的**变体生成器**（变体 JSON 不手编）。
//
// 主管线 deploy/duckle/console/pipelines/lemeng.inventory.snapshot.l0.3120.json 是唯一事实源
// （手工维护：窗口 `${date-2d}`、排班日内 5 轮）。本脚本由它机械派生两个变体：
//
//   ① catchup.3120  —— 窗口 `${date-3d}`，排班 00:35 CST 每日一轮。
//      兜底：主轮当天全空（源端未发布）时补前一天，保证任何一天最多晚一天到湖。
//   ② backfill.3120 —— 窗口 `${BIZDAY}`，不排班（EXEMPT_GLOBAL），
//      回填时 POST /api/run 传 params={BIZDAY:'YYYY-MM-DD'}。
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

const MAIN = 'deploy/duckle/console/pipelines/lemeng.inventory.snapshot.l0.3120.json'
const MAIN_NAME = 'lemeng.inventory.snapshot.l0.3120'
// 主管线的窗口 token。改主管线窗口时**必须**同步改这里（下面的断言会拦住漏改）。
const MAIN_WINDOW = '${date-2d}'
const CHECK = process.argv.includes('--check')

/** 变体定义：suffix 决定文件名与管线名；window 是替换后的窗口 token。 */
const VARIANTS = [
  {
    suffix: 'catchup',
    window: '${date-3d}',
    label: '空集 ⇒ 具名状态（兜底也没拿到；T-3 距日结 ≥72h，此时零行 = 源端真缺这一天）',
    message:
      'SOURCE_NOT_PUBLISHED: bizday=${date-3d} 源端零行——**兜底轮次也没拿到**。本管线窗口为 T-3，' +
      '距营业日日结 ≥72h，远超源端实测发布上限 46.6~48.2h（2026-10-26 探针实测）⇒ 此刻零行意味着' +
      '**源端真的缺这一天**（当日未日结/未结转），不是窗口问题。处置：先手工探一次该 bizday 确认；' +
      '确属源端缺失则登记进正典 §1.7 台账，源端补齐后用 lemeng.inventory.snapshot.backfill.3120 补采。',
  },
  {
    suffix: 'backfill',
    window: '${BIZDAY}',
    label: '空集 ⇒ 具名状态（回填日源端无结转记录）',
    message:
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

const mainRaw = readFileSync(MAIN, 'utf8')
/** @type {any} */
const mainPipeline = JSON.parse(mainRaw)

if (mainPipeline.name !== MAIN_NAME) {
  console.error(`主管线顶层 name 应为 ${MAIN_NAME}，实际 ${String(mainPipeline.name)}`)
  process.exit(2)
}
const tokenCount = mainRaw.split(MAIN_WINDOW).length - 1
if (tokenCount < 30) {
  console.error(
    `主管线里 ${MAIN_WINDOW} 只出现 ${tokenCount} 次（期望 ≥30：p1..p31 + gv + shape + sink + die_empty）` +
      '——主管线窗口改过却没同步本脚本的 MAIN_WINDOW？',
  )
  process.exit(2)
}

let drift = false
for (const v of VARIANTS) {
  /** @type {any} */
  const pipeline = replaceToken(structuredClone(mainPipeline), MAIN_WINDOW, v.window)
  pipeline.name = `lemeng.inventory.snapshot.${v.suffix}.3120`
  /** @type {any} */
  const dieEmpty = pipeline.nodes.find((/** @type {any} */ n) => n.id === 'die_empty')
  if (dieEmpty === undefined) {
    console.error('主管线缺 die_empty 节点——派生变体的空集文案无处落位')
    process.exit(2)
  }
  dieEmpty.data.label = v.label
  dieEmpty.data.properties.message = v.message

  const out = join(dirname(MAIN), `lemeng.inventory.snapshot.${v.suffix}.3120.json`)
  const body = JSON.stringify(pipeline, null, 2) + '\n'
  if (CHECK) {
    /** @type {string | null} */
    let onDisk = null
    try {
      onDisk = readFileSync(out, 'utf8')
    } catch {
      console.error(`GEN_DRIFT: ${out} 不存在（跑了生成器没提交？）`)
      drift = true
      continue
    }
    if (onDisk !== body) {
      console.error(`GEN_DRIFT: ${out} 与主管线派生结果不一致（改了主管线没重跑生成器？）`)
      drift = true
    } else {
      console.log(`ok: ${out}`)
    }
  } else {
    writeFileSync(out, body)
    console.log(`written: ${out} (name=${pipeline.name} window=${v.window})`)
  }
}

if (CHECK && drift) {
  console.error('怎么修：node scripts/lemeng/gen-inventory-snapshot-variants.mjs 后一并提交')
  process.exit(1)
}
