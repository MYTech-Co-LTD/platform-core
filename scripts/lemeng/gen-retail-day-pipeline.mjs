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
import { basename } from 'node:path'

/** @param {string} flag */
function argOf(flag) {
  const i = process.argv.indexOf(flag)
  return i === -1 || i + 1 >= process.argv.length ? null : process.argv[i + 1]
}

const SRC_REL = 'deploy/duckle/console/pipelines/lemeng.retail_order_line.window.json'
const DEFAULT_OUT = 'deploy/duckle/console/pipelines/lemeng.retail_order_line.day.json'
// `--out` 换名 = 派生高容量变体（#1168）：`*.hp`（high pages）与 `*.day` 同构，只多页。
// 管线名必须等于文件 stem（#531 门禁），故 name 随 out 走。
const PARENT_REL = 'deploy/duckle/console/pipelines/lemeng.retail.day.backfill.json'
const PARENT_HP_REL = 'deploy/duckle/console/pipelines/lemeng.retail.day.backfill.hp.json'

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
        key: 'lemeng/retail_order_line/_DAY_DATA/system_book=${ITER_ITEM_SYSTEM_BOOK}/bizday=${ITER_ITEM_BIZDAY}/all.parquet',
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
  // ── 封版标记（`_DAILY/<book>-<bizday>.parquet`）────────────────────────────────────
  // 读侧靠它决定「这一天的小时文件要不要排除」（architecture.md §5.3）。
  // ⚠️ 必须在**天文件落盘之后**才写：`ordered`（ctl.anchor）→ 本节点是 **trigger** 边，
  //    与收据 `summ` 同一手法。写早了会让读侧去排除一片还不存在/没写完的小时文件。
  // ⚠️ 标记**不能落进 `system_book=*/**/*.parquet` 射程**：这里放表根 `_DAILY/`，
  //    与 `_SCHEMA/` 同一理由（落了就会被当数据文件读进来）。
  {
    id: 'msrc',
    type: 'transform',
    position: { x: 1520, y: 260 },
    data: {
      label: '封版标记行（1 行：本账套 × 本日）',
      componentId: 'code.sql',
      properties: {
        // 不读 input 的行：即便当天 0 行也要写标记（天文件已落盘，只是空）
        sql: "SELECT '${ITER_ITEM_SYSTEM_BOOK}' AS system_book, CAST('${ITER_ITEM_BIZDAY}' AS DATE) AS bizday",
      },
    },
  },
  {
    id: 'msink',
    type: 'sink',
    position: { x: 1760, y: 260 },
    data: {
      label: '封版标记 → _DAILY/',
      componentId: 'snk.minio',
      properties: {
        ...sink.data.properties,
        key: 'lemeng/retail_order_line/_DAILY/${ITER_ITEM_SYSTEM_BOOK}-${ITER_ITEM_BIZDAY}.parquet',
      },
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
// 封版标记：数据边来自 gate，**排序边**来自 ordered（先落盘再写标记），与 summ 同构
wire('gate', 'msrc')
wire('msrc', 'msink')
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
edges.push({
  id: 't_ordered_msrc',
  source: 'ordered',
  target: 'msrc',
  sourceHandle: 'main',
  targetHandle: 'main',
  data: { connectionType: 'trigger' },
})

// `_note` 由生成器自带（原来手写在 day.json 里，重新生成时被冲掉过一次）：
// 记录 96 个 src.rest 关闭 checkpoint 的来龙去脉（#975），改这里 = 同时改 day 与 hp 两个变体。
const NOTE = [
  'lemeng.retail_order_line 的 **L1 子管线（day 形：日批 / 手工回填用）**。',
  '',
  '①【checkpoint 已关闭（2026-10-21，#975）】96 个 src.rest 由 checkpoint=true 改为 false。理由两条：',
  '   ① 成本无界：复用键 = 配置指纹(url/method/body/responsePath) + 父行，body 含日期 ⇒ 条目只增不命中，',
  '      引擎无保留期 ⇒ 两账套 state/ 累积到 11G，已致数据机 96% 满、一次部署构建 ENOSPC；',
  '   ② 该缓存换不到东西：本管线 96 个源节点 urlTemplate 全空、paginationType=none ⇒ 无扇出可分页可续，',
  '      组件说明里的收益（「扇出死在第 90 万行不用重跑前 90 万」）在此不成立。',
  '   同族对照：tick 变体本就是 false，与 window 形的 12 个源节点**除 checkpoint 外逐字段相同**（差异 0）。',
  '   代价：重跑重抓（这正是 #528 想要的语义——裸回填不再重放冻结快照）。依据 issue #975。',
  '',
  '②【保留不动】96 页节点 + guard + merge + flatten + qa.contract gate + sink 分区写进 key（不开 partitionBy）。',
]
writeFileSync(out, JSON.stringify({ name: basename(out, '.json'), nodes, edges, _note: NOTE }, null, 1) + '\n')
console.log(`gen-retail-day-pipeline: 写入 ${out}（${pages} 页 + ${nodes.length - pages} 个结构节点，${edges.length} 条边）`)

// ── hp 变体的回填父管线：唯一差异 = foreach 的 pipelineRef 指向 hp 子管线 ─────────────
// （排班表里没有它——EXEMPT_GLOBAL 登记「容量溢出日手动用」；改回填父管线时重跑本生成器同步。）
if (basename(out, '.json').endsWith('.hp')) {
  const parent = JSON.parse(readFileSync(PARENT_REL, 'utf8'))
  /** @type {number} */
  let refs = 0
  for (const n of parent.nodes) {
    const p = n?.data?.properties
    if (p && typeof p.pipelineRef === 'string' && p.pipelineRef.includes('lemeng.retail_order_line.day.json')) {
      p.pipelineRef = p.pipelineRef.replace('lemeng.retail_order_line.day.json', `${basename(out, '.json')}.json`)
      refs += 1
    }
  }
  if (refs === 0) {
    console.error('回填父管线里找不到 day 子管线引用——父管线形态变过，生成器要跟着改')
    process.exit(2)
  }
  parent.name = basename(PARENT_HP_REL, '.json')
  writeFileSync(PARENT_HP_REL, JSON.stringify(parent, null, 1) + '\n')
  console.log(`gen-retail-day-pipeline: 写入 ${PARENT_HP_REL}（pipelineRef → ${basename(out, '.json')}.json）`)
}
