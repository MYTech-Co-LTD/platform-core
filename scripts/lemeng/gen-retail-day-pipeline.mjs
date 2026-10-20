// gen-retail-day-pipeline.mjs — 零售明细「整天重采」子管线的**生成器**（管线 JSON 不手编）。
//
// 产出 deploy/duckle/console/pipelines/lemeng.retail_order_line.day.json
//
// 用法（仓根跑）：
//   node scripts/lemeng/gen-retail-day-pipeline.mjs [--pages 96] [--out <path>]
//
// ── 与 lemeng.retail_order_line.window 的关系 ─────────────────────────────────────────
// **逐字沿用**它的取数节点形态：同一 url / connectionRef / responsePath / data.schema /
// checkpoint / paginationType，同一 flatten 投影，同一 qa.contract 规则。只改三处，
// 每处都有实测或门禁理由（见 docs/architecture.md §5.3 与
// docs/superpowers/specs/2026-10-20-retail-daily-partition-design.md）：
//
//   ① **窗口**：`time_from 00:00:00` ~ `time_to 23:59:59`（整天），不是单小时。
//   ② **页数**：默认 96。步 0 实测：3120 / 2026-10-17 整天 8,850 行 = 45 页；
//      历史峰值（2026-10-18）单账套约 13.2k 行 = 66 页 ⇒ 96 页留 1.45× 余量。
//   ③ **sink key**：去掉 `/hour=${ITER_ITEM_HOUR}`，落 `…/bizday=<Y>/all.parquet`（天文件）。
//
// ⚠️ **为什么读 `.window.json` 而不是在这里复制一份投影**：契约列集的唯一事实源是
//    `contracts/lemeng.retail_order_line.json`，管线投影由 `gen-data-projection.mjs` 按它重写。
//    本生成器若自带一份投影 = 造出**第二份手写列清单**（#458/#461 治的就是这个病）。
//    读 `.window.json` 则投影**永远同源**：那边被生成器重写，这边跟着走。
//
// ⚠️ **页数上限即容量哨兵**：第 N 页**同时**喂 `merge` 与 `guard`（`ctl.die` + `condition: has-rows`）
//    ——最后一页仍有数据 = 可能被网关截断 ⇒ **响亮失败**，而不是静默少数据。
//    为什么哨兵不是可选项：网关**越界页返回 `code:0` + 空数组，不带错**（step-0 实测），
//    信封里也**没有 `total`** ⇒ 除了「见到不满一页」没有第二个判据。
//
// ⚠️ **每条入 `ctl.merge` 的边必须用 `targetHandle: main_1..main_N`**（逐路一个）。
//    全部挂 `main` 会被验证器判「N 路进一个端口、只读一路」，**其余静默丢弃**
//    （2026-10-20 实测：50 路挂 `main` ⇒ 该报错；现有 12 路管线逐路 main_N ⇒ 正常）。
//    这也是 `check-data-contract.mjs` 规则 ④ 唯一认的汇流点——用别的汇流件会让
//    「申报面」检查**静默逃检**。
//
// 产出后必须：`duckle validate` 过 → 才许提交（口径：仓内文件 = 引擎验过的）。
import { readFileSync, writeFileSync } from 'node:fs'

/** @param {string} flag */
function argOf(flag) {
  const i = process.argv.indexOf(flag)
  return i === -1 || i + 1 >= process.argv.length ? null : process.argv[i + 1]
}

const SRC_REL = 'deploy/duckle/console/pipelines/lemeng.retail_order_line.window.json'
const DEFAULT_OUT = 'deploy/duckle/console/pipelines/lemeng.retail_order_line.day.json'

const pages = Number(argOf('--pages') ?? 96)
if (!Number.isInteger(pages) || pages < 2) {
  console.error('--pages 必须是 ≥2 的整数（最后一页被哨兵占用）')
  process.exit(2)
}
const out = argOf('--out') ?? DEFAULT_OUT

const src = JSON.parse(readFileSync(SRC_REL, 'utf8'))
/** @param {string} id */
const nodeOf = (id) => src.nodes.find((/** @type {any} */ n) => n.id === id)
const p1 = nodeOf('p1')
const flatten = nodeOf('flatten')
const gate = nodeOf('gate')
const sink = nodeOf('sink')
const summ = nodeOf('summ')
const guard = nodeOf('guard')
for (const [id, n] of Object.entries({ p1, flatten, gate, sink, summ, guard })) {
  if (!n) {
    console.error(`${SRC_REL} 里找不到节点 ${id}——上游被改过，生成器要跟着改`)
    process.exit(2)
  }
}

// ① 整天窗口：把窗口占位符换成整天字面量（页数 ② 在下面逐路填）
/** @type {string} */
const pageBody = String(p1.data.properties.body)
  .replaceAll('"${ITER_ITEM_HOUR_FROM}"', '"00:00:00"')
  .replaceAll('"${ITER_ITEM_HOUR_TO}"', '"23:59:59"')
if (pageBody.includes('ITER_ITEM_HOUR')) {
  console.error('body 里仍残留 ITER_ITEM_HOUR 占位符——.window.json 的 body 形态变过，生成器要跟着改')
  process.exit(2)
}

/** @type {any[]} */
const nodes = []
/** @type {any[]} */
const edges = []

for (let i = 1; i <= pages; i += 1) {
  nodes.push({
    id: `p${i}`,
    type: 'source',
    position: { x: 0, y: (i - 1) * 40 },
    data: {
      label: `page ${i}`,
      componentId: 'src.rest',
      // schema 逐字沿用 .window.json：空响应时引擎**按申报构造关系**，缺一个字段就空页 Binder Error
      schema: p1.data.schema,
      properties: { ...p1.data.properties, body: pageBody.replace('"page_number": 1', `"page_number": ${i}`) },
    },
  })
  edges.push({
    id: `e_p${i}`,
    source: `p${i}`,
    target: 'merge',
    sourceHandle: 'main',
    targetHandle: `main_${i}`,
    data: { connectionType: 'main' },
  })
}
// 哨兵：最后一页**同时**喂 merge 与 guard（与 .window.json 同形）
edges.push({
  id: `e_p${pages}_guard`,
  source: `p${pages}`,
  target: 'guard',
  sourceHandle: 'main',
  targetHandle: 'main',
  data: { connectionType: 'main' },
})

const shift = (nodes.length + 1) * 40
nodes.push(
  {
    id: 'merge',
    type: 'transform',
    position: { x: 320, y: 0 },
    data: { label: `merge pages 1-${pages}`, componentId: 'ctl.merge', properties: {} },
  },
  {
    id: 'guard',
    type: 'control',
    position: { x: 320, y: shift },
    data: {
      label: 'last-page guard (capacity truncation)',
      componentId: 'ctl.die',
      properties: {
        condition: guard.data.properties.condition,
        message:
          `lemeng retail_order_line **整天重采**容量截断：第 ${pages} 页仍有 {rows} 行` +
          `（system_book=\${ITER_ITEM_SYSTEM_BOOK} bizday=\${ITER_ITEM_BIZDAY} 00:00:00~23:59:59）` +
          `——这一天超过 ${pages} 页上限，提高 --pages 重跑本生成器`,
      },
    },
  },
  { id: 'flatten', type: 'transform', position: { x: 560, y: 0 }, data: { ...flatten.data } },
  { id: 'gate', type: 'transform', position: { x: 800, y: 0 }, data: { ...gate.data } },
  {
    id: 'sink',
    type: 'sink',
    position: { x: 1040, y: 0 },
    data: {
      ...sink.data,
      properties: {
        ...sink.data.properties,
        // ③ 天文件：去掉 /hour=…/，hour 落回文件体（契约列里有它，见 §5.3）
        key: 'lemeng/retail_order_line/system_book=${ITER_ITEM_SYSTEM_BOOK}/bizday=${ITER_ITEM_BIZDAY}/all.parquet',
      },
    },
  },
  { id: 'ordered', type: 'control', position: { x: 1280, y: 0 }, data: { ...nodeOf('ordered').data } },
  {
    id: 'summ',
    type: 'transform',
    position: { x: 1520, y: 0 },
    data: {
      ...summ.data,
      properties: {
        // 保列形与 .window.json 的收据一致（父管线读它判缺口），hour 位填 '-'（整天重采无小时）
        sql: String(summ.data.properties.sql).replaceAll("'${ITER_ITEM_HOUR}' AS hour,", "'-' AS hour,"),
      },
    },
  },
  {
    id: 'receipt',
    type: 'sink',
    position: { x: 1760, y: 0 },
    data: {
      ...nodeOf('receipt').data,
      properties: { path: '/workspace/logs/retail-windows/${ITER_ITEM_BIZDAY}.csv', mode: 'overwrite' },
    },
  },
)

const wire = (/** @type {string} */ source, /** @type {string} */ target) =>
  edges.push({
    id: `e_${source}_${target}`,
    source,
    target,
    sourceHandle: 'main',
    targetHandle: 'main',
    data: { connectionType: 'main' },
  })
wire('merge', 'flatten')
wire('flatten', 'gate')
wire('gate', 'sink')
wire('gate', 'summ')
wire('sink', 'ordered')
wire('summ', 'receipt')
// ⚠️ `ordered → summ` 是**排序边、不是数据边**：必须 `connectionType: "trigger"`。
//    写成 `"main"` 会被验证器判「2 路进一个端口、只读一路」（2026-10-20 实测拦下）。
//    `ctl.anchor` 的语义是「上游 sink 先落盘，再放行下游」——它是触发关系，不搬数据。
edges.push({
  id: 't_ordered_summ',
  source: 'ordered',
  target: 'summ',
  sourceHandle: 'main',
  targetHandle: 'main',
  data: { connectionType: 'trigger' },
})

writeFileSync(out, JSON.stringify({ name: 'lemeng.retail_order_line.day', nodes, edges }, null, 1) + '\n')
console.log(`gen-retail-day-pipeline: 写入 ${out}（${pages} 页 + ${nodes.length - pages} 个结构节点，${edges.length} 条边）`)
