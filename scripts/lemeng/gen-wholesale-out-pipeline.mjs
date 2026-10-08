// gen-wholesale-out-pipeline.mjs — #499/R3 批发（WO）L0 管线的**生成器**（管线 JSON 不手编）。
//
// 产出 deploy/duckle/console/pipelines/lemeng.wholesale.out.l0.3120.json。
// 结构镜像调出单生成器（身份门 w0..d1 → gv/dv → 页扇出 → merge → shape → gate → sink），差异：
//   ① 接口 = nhsoft.whs.ai.wholesaleorder.find；分页 = **limit/offset**（非 page_number）；
//      查询窗 ≤7 天（严于调出单 3 个月）——日批窗口 1 天，余量充足。
//   ② body 日期**必须带时间分量**（纯日期报 parse error，实测）；date_type=制单
//      （⚠️ 枚举坑：文档描述「制单时间」，实际值「制单」——错误值静默 0 行，fail-open）。
//   ③ 嵌套明细 = wholesale_order_details[]（json 列 + UNNEST 展开，同款）。
//   ④ 哨兵 p9：offset 800 非空 = >800 单/日击穿（实测批发单量级更小，余量大）。
//
// 用法（仓根跑）：
//   node scripts/lemeng/gen-wholesale-out-pipeline.mjs --book 3120 \
//     --out deploy/duckle/console/pipelines/lemeng.wholesale.out.l0.3120.json
//
// 产出后必须：duckle MCP validate_pipeline 过 → 才许提交。
import { readFileSync, writeFileSync } from 'node:fs'

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
const out = argOf('--out')
const PAGES = 19         // p1..p18 数据页 + p19 哨兵页（首跑实测批发单 >900 单/日，9 页被打穿）
const PAGE_SIZE = 100

// shape SQL 引用的源字段全部申报（check-data-contract 硬门；漏报 = 空响应 Binder Error，#432 族）
const SRC_SCHEMA = [
  { name: 'wholesale_order_fid', type: 'string' },
  { name: 'client_fid', type: 'string' },
  { name: 'state', type: 'json' },
  { name: 'wholesale_order_date', type: 'string' },
  { name: 'wholesale_order_create_time', type: 'string' },
  { name: 'wholesale_order_audit_time', type: 'string' },
  { name: 'wholesale_order_last_edit_time', type: 'string' },
  { name: 'branch_num', type: 'int64' },
  { name: 'storehouse_num', type: 'int64' },
  { name: 'wholesale_order_details', type: 'json' },
]

/** 数据/哨兵页节点：批发销售单查询，offset = (页号-1)×页容量
 * @param {string} id
 * @param {number} pageNo
 */
function pageNode(id, pageNo) {
  const offset = (pageNo - 1) * PAGE_SIZE
  return {
    id,
    type: 'source',
    position: { x: 0, y: 0 },
    data: {
      label: id,
      componentId: 'src.rest',
      schema: SRC_SCHEMA,
      properties: {
        connectionRef: 'lemeng',
        url: 'https://cloud.nhsoft.cn/agi/api/nhsoft.whs.ai.wholesaleorder.find',
        method: 'POST',
        body: JSON.stringify({
          date_start: '${date-1d} 00:00:00',
          date_end: '${date-1d} 23:59:59',
          date_type: '制单时间',
          limit: PAGE_SIZE,
          offset,
        }),
        responsePath: '/result',
        paginationType: 'none',
        retryAttempts: 3,
        retryBackoffMs: 2000,
      },
    },
  }
}

const batchIdExpr = `'wo-' || '\${ENV:SYSTEM_BOOK}' || '-wholesale_out-' || replace(replace('\${datetime}','-',''),'_','T') || 'Z'`

const SHAPE_SQL = `SELECT
  ${batchIdExpr} AS batch_id,
  '\${ENV:SYSTEM_BOOK}' AS system_book,
  CAST('\${date-1d}' AS DATE) AS bizday,
  CAST(o.wholesale_order_fid AS VARCHAR) AS order_no,
  CAST(o.client_fid AS VARCHAR) AS client_fid,
  CAST(json_extract_string(CAST(o.state AS JSON), '$.state_code') AS INTEGER) AS state_code,
  json_extract_string(CAST(o.state AS JSON), '$.state_name') AS state_name,
  CAST(o.wholesale_order_date AS VARCHAR) AS wholesale_order_date,
  CAST(o.wholesale_order_create_time AS VARCHAR) AS create_time,
  CAST(o.wholesale_order_audit_time AS VARCHAR) AS audit_time,
  CAST(o.wholesale_order_last_edit_time AS VARCHAR) AS last_edit_time,
  CAST(o.branch_num AS INTEGER) AS branch_num,
  CAST(o.storehouse_num AS BIGINT) AS storehouse_num,
  CAST(json_extract_string(u.d, '$.order_detail_num') AS INTEGER) AS order_detail_num,
  CAST(json_extract_string(u.d, '$.item_num') AS BIGINT) AS item_num,
  json_extract_string(u.d, '$.order_detail_item_code') AS item_code,
  json_extract_string(u.d, '$.order_detail_item_name') AS item_name,
  json_extract_string(u.d, '$.order_detail_item_spec') AS item_spec,
  json_extract_string(u.d, '$.order_detail_item_unit') AS item_unit,
  CAST(json_extract_string(u.d, '$.order_detail_qty') AS DECIMAL(14,6)) AS quantity,
  CAST(json_extract_string(u.d, '$.order_detail_price') AS DECIMAL(18,8)) AS price,
  CAST(json_extract_string(u.d, '$.order_detail_money') AS DECIMAL(14,2)) AS money,
  CAST(json_extract_string(u.d, '$.order_detail_cost') AS DECIMAL(18,8)) AS cost,
  json_extract_string(u.d, '$.order_detail_lot_number') AS lot_number,
  CAST(json_extract_string(u.d, '$.order_detail_present_qty') AS DECIMAL(14,6)) AS present_qty,
  json_extract_string(u.d, '$.order_detail_use_unit') AS use_unit,
  CAST(json_extract_string(u.d, '$.order_detail_use_qty') AS DECIMAL(14,6)) AS use_qty,
  CAST(json_extract_string(u.d, '$.order_detail_use_price') AS DECIMAL(18,8)) AS use_price,
  CAST(json_extract_string(u.d, '$.order_detail_use_rate') AS DECIMAL(18,8)) AS use_rate
FROM input o
CROSS JOIN UNNEST(from_json(CAST(o.wholesale_order_details AS JSON), '["JSON"]')) AS u(d)`

/** @param {string} id @param {string} componentId @param {Record<string, unknown>} properties @param {string} [type] */
const node = (id, componentId, properties, type = 'transform') => ({
  id, type, position: { x: 0, y: 0 },
  data: { label: id, componentId, properties },
})
/** @param {string} id @param {string} condition @param {string} message */
/** @param {string} id @param {string} condition @param {string} message */
const die = (id, condition, message) => node(id, 'ctl.die', { condition, message })
/** @type {(sql: string) => Record<string, string>} 单形状：code.sql 节点属性恒只有 sql */
const codeSql = (sql) => ({ sql })

const pIds = []
/** @type {unknown[]} */
const pNodes = []
for (let i = 1; i <= PAGES; i++) {
  const id = `p${i}`
  pIds.push(id)
  pNodes.push(pageNode(id, i))
}

const lastId = pIds[pIds.length - 1]
/** @type {any} */
const pipeline = {
  name: `lemeng.wholesale.out.l0.${book}`,
  nodes: [
    // ── 身份门（逐字镜像 price/transfer-out w0..d1）────────────────────────────────
    {
      id: 'w0', type: 'source', position: { x: 0, y: 0 },
      data: {
        label: 'w0', componentId: 'src.rest',
        schema: [{ name: 'x', type: 'string' }],
        properties: {
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
        },
      },
    },
    node('g0', 'code.sql', codeSql("SELECT unnest(regexp_extract_all(content, '(?m)^data: ([^\\r\\n]*)', 1)) AS line FROM read_text('/workspace/.duckle-raw/whoami-${datetime}.sse')")),
    node('g1', 'code.sql', codeSql("SELECT json_extract_string(line, '$.result.content[0].text') AS txt FROM input QUALIFY row_number() OVER () = count(*) OVER ()")),
    node('g2', 'code.sql', codeSql("SELECT json_extract_string(txt, '$.company_id') AS company_id, json_extract_string(txt, '$.branch_nums') AS branch_nums FROM input")),
    die('d0', 'no-rows', 'identity: whoami 响应里没有可解析的身份（网关形状变了？）⇒ 身份未证，拒绝采集与写湖'),
    node('g3', 'code.sql', codeSql(`SELECT 'book' AS violation, company_id AS detail FROM input WHERE company_id IS DISTINCT FROM '\${ENV:SYSTEM_BOOK}' UNION ALL SELECT 'branch' AS violation, CAST(c.branch_num AS VARCHAR) AS detail FROM (SELECT unnest('\${ENV:BRANCH_NUMS}'::BIGINT[]) AS branch_num) c LEFT JOIN (SELECT unnest(CAST(json_extract(branch_nums, '$[*]') AS BIGINT[])) AS branch_num FROM input) w USING (branch_num) WHERE w.branch_num IS NULL`)),
    die('d1', 'has-rows', 'identity: 凭据账套/门店清单自证未过 ⇒ 拒绝采集与写湖'),
    node('gv', 'code.sql', codeSql(`SELECT 'BRANCH_NUMS' AS violation, '\${ENV:BRANCH_NUMS}' AS detail, 'JSON integer array, e.g. [1001,1002]' AS rule WHERE NOT regexp_full_match('\${ENV:BRANCH_NUMS}', '\\[[0-9]+([, ]+[0-9]+)*\\]') UNION ALL SELECT 'SYSTEM_BOOK', '\${ENV:SYSTEM_BOOK}', 'digits only' WHERE NOT regexp_full_match('\${ENV:SYSTEM_BOOK}', '[0-9]{1,32}') UNION ALL SELECT 'BIZDAY', '\${date-1d}', 'YYYY-MM-DD' WHERE NOT regexp_full_match('\${date-1d}', '[0-9]{4}-[0-9]{2}-[0-9]{2}') UNION ALL SELECT 'BATCH_ID', ${batchIdExpr} AS v, 'wo-<book>-wholesale_out-YYYYMMDDTHHMMSSZ' WHERE NOT regexp_full_match(${batchIdExpr}, 'wo-[0-9]+-wholesale_out-[0-9]{8}T[0-9]{6}Z')`)),
    die('dv', 'has-rows', 'EXPECTED_VALUE_MISSING_OR_MALFORMED: 期望值缺席或形状非法（{rows} 条违规，明细见上）⇒ 拒绝采集与写湖。处置：检查该管线调度/触发面的 env 注入'),
    ...pNodes,
    // 哨兵 die：p19（末页）非空 = 批发单量击穿 1,800 单/日容量 ⇒ 大声红（口径同 dim.item 第 150 页）
    die('sentinel', 'has-rows', "lemeng wholesale_out 容量截断：第 19 页（哨兵页）仍有 {rows} 行（system_book=${ENV:SYSTEM_BOOK}）⇒ 单量已击穿真阈值 1,800 条/日（算式：数据页 18 × page_size 100，哨兵页不计容量）。处置：加数据页节点 → 同步改本算式与哨兵页的页号 → 重生成 → 走 PR"),
    node('merge', 'ctl.merge', {}),
    node('shape', 'code.sql', codeSql(SHAPE_SQL)),
    node('gate', 'qa.contract', { rules: {
      batch_id: 'not_null', system_book: 'not_null', bizday: 'not_null',
      order_no: 'not_null', item_num: 'not_null', item_code: 'not_null', order_detail_num: 'not_null',
    } }),
    node('sink', 'snk.minio', {
      bucket: '${ENV:ZOS_BUCKET}',
      key: 'lemeng/wholesale_out/system_book=${ENV:SYSTEM_BOOK}/bizday=${date-1d}/all.parquet',
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
    ...pIds.map((id) => ({ id: `e-dv-${id}`, source: 'dv', target: id, sourceHandle: null, targetHandle: null, data: { connectionType: 'on-subjob-ok' } })),
    // 末页（哨兵）单独过 die(has-rows) 再进 merge——非空即整条红（容量击穿大声红）；
    // 其余页直连 merge。dim.item 的 p150→guard 同款。
    ...pIds.slice(0, -1).map((id, i) => ({ id: `e-${id}-merge`, source: id, target: 'merge', sourceHandle: 'main', targetHandle: `main_${i + 1}`, data: { connectionType: 'main' } })),
    { id: `e-${lastId}-sentinel`, source: lastId, target: 'sentinel', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } },
    { id: 'e-sentinel-merge', source: 'sentinel', target: 'merge', sourceHandle: 'main', targetHandle: `main_${pIds.length}`, data: { connectionType: 'main' } },
    { id: 'e-merge-shape', source: 'merge', target: 'shape', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } },
    { id: 'e-shape-gate', source: 'shape', target: 'gate', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } },
    { id: 'e-gate-sink', source: 'gate', target: 'sink', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } },
  ],
}

writeFileSync(out, JSON.stringify(pipeline, null, 2) + '\n')
console.log(`written: ${out} (book=${book} pages=${PAGES}，p${PAGES}=哨兵)`)

// 自证：读回形状 sanity
const check = JSON.parse(readFileSync(out, 'utf8'))
const sources = check.nodes.filter((/** @type {any} */ n) => n.data.componentId === 'src.rest')
console.log(`sanity: nodes=${check.nodes.length} edges=${check.edges.length} src.rest=${sources.length}（1 身份门 + ${sources.length - 1} 页）`)
