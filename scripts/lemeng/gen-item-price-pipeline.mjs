// gen-item-price-pipeline.mjs — #481 价格批 L0 管线的**生成器**（管线 JSON 不手编）。
//
// 产出 deploy/duckle/console/pipelines/lemeng.dim.item_price.l0.json（64188）与
// …l0.3120.json（3120）。结构逐字镜像 lemeng.dim.item.l0（w0 身份门 → g0..d1 自证 →
// gv/dv env 形状门 → 批量扇出 → merge → 门店覆盖守卫 → shape → qa.contract → sink）。
//
// 与 dim.item 的两个结构差（都有理由，别"对齐"回去）：
//   ① 扇出基准：item.find 按页扇出（页数稳定）；realprice **无分页** ⇒ 按**门店批**扇出
//      （15 店/批，单批载荷远低于 REST 门实测上限——探针报告 §2②）。
//      ⚠️ 批内门店号是**生成时的字面量**：门店增减 ⇒ 重跑本生成器（FC 维护义务，FLOW.lemeng.md 有行）。
//      过期不会被静默放行：merge 后的**门店覆盖守卫**拿 merged 门店集合对 `${ENV:BRANCH_NUMS}`
//      （运行时唯一事实源）点名，多/少一家都 die——等价 dim.item 哨兵页的角色。
//   ② `last_edit_time` 是**生成时的字面量**（生成日的滚动 2 年窗起点）：网关上限 10310217
//      随"今天"滚动 ⇒ 字面量约 2 年后过期，过期 = 网关大声拒绝（fail-loud，可接受），
//      届时重跑本生成器即可。探针报告 §2③。
//
// 用法（仓根跑；门店号从网关 whoami 逐字取，不手抄）：
//   node scripts/lemeng/gen-item-price-pipeline.mjs \
//     --book 3120 --out deploy/duckle/console/pipelines/lemeng.dim.item_price.l0.3120.json \
//     --branches '[99,1,2,...]'
//
// 产出后必须：duckle MCP validate_pipeline 过 → 才许提交（口径：仓内文件 = 引擎验过的）。
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** @param {string} flag */
function argOf(flag) {
  const i = process.argv.indexOf(flag)
  if (i === -1 || i + 1 >= process.argv.length) {
    console.error(`缺少 ${flag}`)
    process.exit(2)
  }
  return process.argv[i + 1]
}

const book = argOf('--book')
if (!/^[0-9]{1,32}$/.test(book)) {
  console.error('--book 必须是纯数字账套号')
  process.exit(2)
}
let branches
try {
  branches = JSON.parse(argOf('--branches'))
} catch {
  console.error('--branches 必须是 JSON 整数数组（从 whoami branch_nums 逐字取）')
  process.exit(2)
}
if (!Array.isArray(branches) || branches.length === 0 || branches.some((b) => !Number.isInteger(b))) {
  console.error('--branches 必须是非空整数数组')
  process.exit(2)
}
const out = argOf('--out')
const CHUNK = 15
// 生成日的滚动 2 年窗起点（留 0 天余量——网关按"今天"滚，字面量寿命就是 2 年，过期 fail-loud）
const sinceIdx = process.argv.indexOf('--since')
const since = (sinceIdx !== -1 && sinceIdx + 1 < process.argv.length)
  ? process.argv[sinceIdx + 1]
  : new Date(Date.now() - 2 * 365 * 24 * 3600 * 1000).toISOString().slice(0, 10) + ' 00:00:00'

/** @type {(sql: string) => Record<string, string>} 单形状：code.sql 节点属性恒只有 sql */
const codeSql = (sql) => ({ sql })
// shape SQL 引用的 18 个源字段必须**全部申报**（check-data-contract 硬门；不申报 = 空响应时
// 引擎按申报构造关系 ⇒ Binder Error，非空窗照常成功——#432 那类「只有空页炸」的暗雷）。
// 对象列（branch/pos_variant）声明为 `json`（与 item 契约 3 个对象列同款）。
const PRICE_SCHEMA = [
  { name: 'branch_num', type: 'int64' },
  { name: 'branch', type: 'json' },
  { name: 'item_num', type: 'int64' },
  { name: 'item_grade_num', type: 'int64' },
  { name: 'pos_variant', type: 'json' },
  { name: 'last_edit_time', type: 'string' },
  { name: 'branch_item_regular_price', type: 'float64' },
  { name: 'branch_item_level2_price', type: 'float64' },
  { name: 'branch_item_level3_price', type: 'float64' },
  { name: 'branch_item_level4_price', type: 'float64' },
  { name: 'branch_item_max_price', type: 'float64' },
  { name: 'branch_item_min_price', type: 'float64' },
  { name: 'branch_item_regular_real_price', type: 'float64' },
  { name: 'branch_item_level2_real_price', type: 'float64' },
  { name: 'branch_item_level3_real_price', type: 'float64' },
  { name: 'branch_item_level4_real_price', type: 'float64' },
  { name: 'branch_item_max_real_price', type: 'float64' },
  { name: 'branch_item_min_real_price', type: 'float64' },
]
/** 批量数据节点：realprice REST 门，单发全量（无分页）
 * @param {string} id
 * @param {number[]} chunk
 */
function priceNode(id, chunk) {
  return {
    id,
    type: 'source',
    position: { x: 0, y: 0 },
    data: {
      label: id,
      componentId: 'src.rest',
      schema: PRICE_SCHEMA,
      properties: {
        connectionRef: 'lemeng',
        url: 'https://cloud.nhsoft.cn/agi/api/nhsoft.retail.ai.branchitem.realprice.find',
        method: 'POST',
        body: JSON.stringify({ branch_nums: chunk, last_edit_time: since }),
        responsePath: '/result',
        paginationType: 'none',
        retryAttempts: 3,
        retryBackoffMs: 2000,
      },
    },
  }
}

const batchIdExpr = `'dim-' || '\${ENV:SYSTEM_BOOK}' || '-item_price-' || replace(replace('\${datetime}','-',''),'_','T') || 'Z'`
const envBranches = '${ENV:BRANCH_NUMS}'

const shapeSql = `SELECT
  ${batchIdExpr} AS batch_id,
  '\${ENV:SYSTEM_BOOK}' AS system_book,
  CAST('\${date+8h}' AS DATE) AS snapshot,
  CAST(o.branch_num AS INTEGER) AS branch_num,
  json_extract_string(CAST(o.branch AS JSON), '$.branch_code') AS branch_code,
  json_extract_string(CAST(o.branch AS JSON), '$.branch_name') AS branch_name,
  CAST(json_extract_string(CAST(o.branch AS JSON), '$.branch_matrix_price_actived') AS BOOLEAN) AS branch_matrix_price_actived,
  CAST(o.item_num AS BIGINT) AS item_num,
  CAST(o.item_grade_num AS BIGINT) AS item_grade_num,
  json_extract_string(CAST(o.pos_variant AS JSON), '$.item_code') AS item_code,
  json_extract_string(CAST(o.pos_variant AS JSON), '$.item_barcode') AS bar_code,
  json_extract_string(CAST(o.pos_variant AS JSON), '$.item_name') AS item_name,
  json_extract_string(CAST(o.pos_variant AS JSON), '$.spec_num') AS spec_num,
  json_extract_string(CAST(o.pos_variant AS JSON), '$.spec_unit') AS spec_unit,
  CAST(json_extract_string(CAST(o.pos_variant AS JSON), '$.spec_rate') AS DECIMAL(18,8)) AS spec_rate,
  json_extract_string(CAST(o.pos_variant AS JSON), '$.item_unit') AS item_unit,
  json_extract_string(CAST(o.pos_variant AS JSON), '$.item_category') AS item_category,
  json_extract_string(CAST(o.pos_variant AS JSON), '$.item_department') AS item_department,
  CAST(o.last_edit_time AS VARCHAR) AS last_edit_time,
  CAST(o.branch_item_regular_price AS DECIMAL(18,8)) AS regular_price,
  CAST(o.branch_item_level2_price AS DECIMAL(18,8)) AS level2_price,
  CAST(o.branch_item_level3_price AS DECIMAL(18,8)) AS level3_price,
  CAST(o.branch_item_level4_price AS DECIMAL(18,8)) AS level4_price,
  CAST(o.branch_item_max_price AS DECIMAL(18,8)) AS max_price,
  CAST(o.branch_item_min_price AS DECIMAL(18,8)) AS min_price,
  CAST(o.branch_item_regular_real_price AS DECIMAL(18,8)) AS regular_real_price,
  CAST(o.branch_item_level2_real_price AS DECIMAL(18,8)) AS level2_real_price,
  CAST(o.branch_item_level3_real_price AS DECIMAL(18,8)) AS level3_real_price,
  CAST(o.branch_item_level4_real_price AS DECIMAL(18,8)) AS level4_real_price,
  CAST(o.branch_item_max_real_price AS DECIMAL(18,8)) AS max_real_price,
  CAST(o.branch_item_min_real_price AS DECIMAL(18,8)) AS min_real_price
FROM input o`

// 门店覆盖守卫：merged 门店集合 ≠ env 清单 ⇒ 有批字面量过期（多/少一家都是）⇒ die。
// env 形状已由 gv/dv 验过、g3 已证 env ⊆ whoami ⇒ 这里 env 就是运行时的门店全集。
const coverageSql = `SELECT 'store_coverage' AS violation,
  (SELECT count(DISTINCT branch_num) FROM input) AS merged_stores,
  (SELECT count(*) FROM (SELECT unnest('${envBranches}'::BIGINT[]) AS b) t) AS env_stores
FROM (SELECT count(DISTINCT branch_num) AS n FROM input) m
WHERE m.n <> (SELECT count(*) FROM (SELECT unnest('${envBranches}'::BIGINT[]) AS b) t)`

/** @param {string} id @param {string} componentId @param {Record<string, unknown>} properties @param {string} [type] */
const node = (id, componentId, properties, type = 'transform') => ({
  id, type, position: { x: 0, y: 0 },
  data: { label: id, componentId, properties },
})
// w0 的 SSE 探针带**单列申报**（dim.item 同款 `[{name:'x',type:'string'}]`）——漏申报时
// 空解析 ⇒ 「returned 0 records and no schema is declared」直接红（首跑实测）。
const whoamiNode = (properties) => ({
  id: 'w0', type: 'source', position: { x: 0, y: 0 },
  data: { label: 'w0', componentId: 'src.rest', schema: [{ name: 'x', type: 'string' }], properties },
})
/** @param {string} id @param {string} condition @param {string} message */
const die = (id, condition, message) => node(id, 'ctl.die', { condition, message })

const pIds = []
/** @type {unknown[]} */
const pNodes = []
for (let i = 0; i * CHUNK < branches.length; i++) {
  const id = `p${i + 1}`
  pIds.push(id)
  pNodes.push(priceNode(id, branches.slice(i * CHUNK, (i + 1) * CHUNK)))
}

/** @type {any} */
const pipeline = {
  name: book === '64188' ? 'lemeng.dim.item_price.l0' : `lemeng.dim.item_price.l0.${book}`,
  nodes: [
    // ── 身份门（逐字镜像 dim.item w0..d1：whoami SSE → 抠 data: → company/book + 门店清单自证）──
    whoamiNode({
      connectionRef: 'lemeng',
      url: 'https://cloud.nhsoft.cn/agi/mcp',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: '{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "whoami", "arguments": {}}}',
      paginationType: 'none',
      responseFormat: 'xml',
      rawResponseDestination: '/workspace/.duckle-raw/whoami-${datetime}.sse',
      retryAttempts: 3,
      retryBackoffMs: 2000,
    }),
    node('g0', 'code.sql', codeSql("SELECT unnest(regexp_extract_all(content, '(?m)^data: ([^\\r\\n]*)', 1)) AS line FROM read_text('/workspace/.duckle-raw/whoami-${datetime}.sse')")),
    node('g1', 'code.sql', codeSql("SELECT json_extract_string(line, '$.result.content[0].text') AS txt FROM input QUALIFY row_number() OVER () = count(*) OVER ()")),
    node('g2', 'code.sql', codeSql("SELECT json_extract_string(txt, '$.company_id') AS company_id, json_extract_string(txt, '$.branch_nums') AS branch_nums FROM input")),
    die('d0', 'no-rows', 'identity: whoami 响应里没有可解析的身份（网关形状变了？）⇒ 身份未证，拒绝采集与写湖'),
    node('g3', 'code.sql', codeSql(`SELECT 'book' AS violation, company_id AS detail FROM input WHERE company_id IS DISTINCT FROM '\${ENV:SYSTEM_BOOK}' UNION ALL SELECT 'branch' AS violation, CAST(c.branch_num AS VARCHAR) AS detail FROM (SELECT unnest('\${ENV:BRANCH_NUMS}'::BIGINT[]) AS branch_num) c LEFT JOIN (SELECT unnest(CAST(json_extract(branch_nums, '$[*]') AS BIGINT[])) AS branch_num FROM input) w USING (branch_num) WHERE w.branch_num IS NULL`)),
    die('d1', 'has-rows', 'identity: 凭据账套/门店清单自证未过 ⇒ 拒绝采集与写湖'),
    // ── env 形状门（逐字镜像 dim.item gv/dv，batch_id 正则换 item_price）──
    node('gv', 'code.sql', codeSql(`SELECT 'BRANCH_NUMS' AS violation, '\${ENV:BRANCH_NUMS}' AS detail, 'JSON integer array, e.g. [1001,1002]' AS rule WHERE NOT regexp_full_match('\${ENV:BRANCH_NUMS}', '\\[[0-9]+([, ]+[0-9]+)*\\]') UNION ALL SELECT 'SYSTEM_BOOK', '\${ENV:SYSTEM_BOOK}', 'digits only' WHERE NOT regexp_full_match('\${ENV:SYSTEM_BOOK}', '[0-9]{1,32}') UNION ALL SELECT 'SNAPSHOT', '\${date+8h}', 'YYYY-MM-DD' WHERE NOT regexp_full_match('\${date+8h}', '[0-9]{4}-[0-9]{2}-[0-9]{2}') UNION ALL SELECT 'BATCH_ID', ${batchIdExpr} AS v, 'dim-<book>-item_price-YYYYMMDDTHHMMSSZ' WHERE NOT regexp_full_match(${batchIdExpr}, 'dim-[0-9]+-item_price-[0-9]{8}T[0-9]{6}Z')`)),
    die('dv', 'has-rows', 'EXPECTED_VALUE_MISSING_OR_MALFORMED: 期望值缺席或形状非法（{rows} 条违规，明细见上）⇒ 拒绝采集与写湖。处置：检查该管线调度/触发面的 env 注入'),
    ...pNodes,
    node('merge', 'ctl.merge', {}),
    node('coverage', 'code.sql', codeSql(coverageSql)),
    die('cg', 'has-rows', '价格批门店覆盖失配：merged 门店集合 ≠ BRANCH_NUMS 清单（{rows} 行）⇒ 快照相对声明的门店全集是部分的 ⇒ 拒绝写湖。处置：门店增减 ⇒ 重跑 gen-item-price-pipeline.mjs 重生成；某店确无价格数据 ⇒ 把它从该账套 BRANCH_NUMS 摘除（那是采集清单，不是门店全集）'),
    node('shape', 'code.sql', codeSql(shapeSql)),
    node('gate', 'qa.contract', { rules: {
      batch_id: 'not_null', system_book: 'not_null', snapshot: 'not_null',
      branch_num: 'not_null', item_num: 'not_null', item_code: 'not_null',
    } }),
    node('sink', 'snk.minio', {
      bucket: '${ENV:ZOS_BUCKET}',
      key: 'lemeng/item_price/system_book=${ENV:SYSTEM_BOOK}/snapshot=${date+8h}/all.parquet',
      region: '${ENV:ZOS_REGION}',
      urlStyle: 'path',
      useSsl: 'true',
      format: 'parquet',
      mode: 'overwrite',
      compression: 'zstd',
      connectionRef: 'zos',
    }, 'sink'),
  ],
  edges: [
    { id: 'e-w0-g0', source: 'w0', target: 'g0', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } },
    { id: 'e-g0-g1', source: 'g0', target: 'g1', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } },
    { id: 'e-g1-g2', source: 'g1', target: 'g2', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } },
    { id: 'e-g2-d0', source: 'g2', target: 'd0', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } },
    { id: 'e-d0-g3', source: 'd0', target: 'g3', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } },
    { id: 'e-g3-d1', source: 'g3', target: 'd1', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } },
    { id: 'e-d1-gv', source: 'd1', target: 'gv', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } },
    { id: 'e-gv-dv', source: 'gv', target: 'dv', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } },
    // dv→p* 是**控制依赖**（子作业触发，不载运数据——dim.item 同款：handle null + on-subjob-ok）
    ...pIds.map((id) => ({ id: `e-dv-${id}`, source: 'dv', target: id, sourceHandle: null, targetHandle: null, data: { connectionType: 'on-subjob-ok' } })),
    // 扇入 merge 的边要**编号 handle**（main_1..main_N）——全写 'main' 会被引擎判「多入单读」拒
    ...pIds.map((id, i) => ({ id: `e-${id}-merge`, source: id, target: 'merge', sourceHandle: 'main', targetHandle: `main_${i + 1}`, data: { connectionType: 'main' } })),
    { id: 'e-merge-coverage', source: 'merge', target: 'coverage', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } },
    { id: 'e-coverage-cg', source: 'coverage', target: 'cg', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } },
    { id: 'e-cg-shape', source: 'cg', target: 'shape', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } },
    { id: 'e-shape-gate', source: 'shape', target: 'gate', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } },
    { id: 'e-gate-sink', source: 'gate', target: 'sink', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } },
  ],
}

writeFileSync(out, JSON.stringify(pipeline, null, 2) + '\n')
console.log(`written: ${out} (book=${book} stores=${branches.length} batches=${pIds.length} since="${since}")`)

// 自证：读回做一次形状 sanity（节点数 / 扇出数），不造第二个事实源
const check = JSON.parse(readFileSync(out, 'utf8'))
const sources = check.nodes.filter((/** @type {any} */ n) => n.data.componentId === 'src.rest')
console.log(`sanity: nodes=${check.nodes.length} edges=${check.edges.length} src.rest=${sources.length}（1 身份门 + ${sources.length - 1} 批）`)
