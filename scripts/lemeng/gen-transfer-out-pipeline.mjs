// gen-transfer-out-pipeline.mjs — #499/R2 配送调出单 L0 管线的**生成器**（管线 JSON 不手编）。
//
// 产出 deploy/duckle/console/pipelines/lemeng.transfer.out.l0.3120.json。
// 结构镜像价格批生成器（身份门 w0..d1 → gv/dv env 门 → 扇出 → merge → shape → gate → sink），
// 三处不同（都有理由，别"对齐"回去）：
//   ① 扇出 = **静态页**（page_number 1..9：p1..p8 数据页 + p9 **哨兵页**——哨兵非空 = 容量击穿
//      大声红；口径同 dim.item 第 150 页。接口无 total，只能页空即止）。页容量 100，
//      数据页 8 页 = 800 单/日上限，实测 472 单/3 天（≈15 倍余量）。
//   ② 查询窗 = **昨日单日**（`${date-1d}`。⚠️ 组合段 `${date-1d+8h}` 在替换层不生效（0.7.4 本地实测
//      原样保留）——尽管引擎 parse_offset 源码支持组合；替换 regex 只认单段。语义：UTC-1d，
//      调度钉在 15:35 UTC（北京 23:35）⇒ UTC 昨日 == 北京昨日；别把调度挪过 16:00 UTC。）
//      ⇒ 窗口日字面量**不过期**（每天由引擎现算，无价格批 last_edit_time 的 2 年过期问题）。
//      分区 bizday = 同一窗口日：每分区写一次不重写。
//   ③ merge 后**无 coverage 守卫**：窗口单日内「某店 0 单」合法（不是全量快照，无覆盖断言可言）；
//      哨兵（本管线 p9）就是唯一的容量防线。
// flatten：接口返回单头嵌套 items[] ⇒ shape 节点 `CROSS JOIN UNNEST(from_json(o.items))` 展开
//   成行粒度（销售明细子管线 lemeng.retail_order_line.window 的 flatten 同款，已证机制）。
//
// 用法（仓根跑）：
//   node scripts/lemeng/gen-transfer-out-pipeline.mjs --book 3120 \
//     --out deploy/duckle/console/pipelines/lemeng.transfer.out.l0.3120.json
//
// 产出后必须：duckle MCP validate_pipeline 过 → 才许提交（口径：仓内文件 = 引擎验过的）。
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

// shape SQL 引用的源字段全部申报（check-data-contract 硬门；漏报 = 空响应 Binder Error，#432 族）
const SRC_SCHEMA = [
  { name: 'order_no', type: 'string' },
  { name: 'order_type', type: 'string' },
  { name: 'state_code', type: 'int64' },
  { name: 'business_date', type: 'string' },
  { name: 'create_time', type: 'string' },
  { name: 'audit_time', type: 'string' },
  { name: 'branch_num', type: 'int64' },
  { name: 'branch_code', type: 'string' },
  { name: 'branch_name', type: 'string' },
  { name: 'out_branch_num', type: 'int64' },
  { name: 'out_branch_name', type: 'string' },
  { name: 'total_money', type: 'float64' },
  { name: 'items', type: 'json' },
]

/** 数据/哨兵页节点：调出单查询，静态页号；窗口 = 昨日单日（引擎现算，不过期）
 * @param {string} id
 * @param {number} pageNo
 */
function pageNode(id, pageNo) {
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
        url: 'https://cloud.nhsoft.cn/agi/api/nhsoft.ama.ai.transfer.out.order.find',
        method: 'POST',
        body: JSON.stringify({
          start_date: '${date-1d}',
          end_date: '${date-1d}',
          page_number: pageNo,
          page_size: 100,
        }),
        responsePath: '/result',
        paginationType: 'none',
        retryAttempts: 3,
        retryBackoffMs: 2000,
      },
    },
  }
}

const batchIdExpr = `'to-' || '\${ENV:SYSTEM_BOOK}' || '-transfer_out-' || replace(replace('\${datetime}','-',''),'_','T') || 'Z'`
const envBranches = '${ENV:BRANCH_NUMS}'

const SHAPE_SQL = `SELECT
  ${batchIdExpr} AS batch_id,
  '\${ENV:SYSTEM_BOOK}' AS system_book,
  CAST('\${date-1d}' AS DATE) AS bizday,
  CAST(o.order_no AS VARCHAR) AS order_no,
  CAST(o.order_type AS VARCHAR) AS order_type,
  CAST(o.state_code AS INTEGER) AS state_code,
  CAST(o.business_date AS VARCHAR) AS business_date,
  CAST(o.create_time AS VARCHAR) AS create_time,
  CAST(o.audit_time AS VARCHAR) AS audit_time,
  CAST(o.branch_num AS INTEGER) AS branch_num,
  CAST(o.branch_code AS VARCHAR) AS branch_code,
  CAST(o.branch_name AS VARCHAR) AS branch_name,
  CAST(o.out_branch_num AS INTEGER) AS out_branch_num,
  CAST(o.out_branch_name AS VARCHAR) AS out_branch_name,
  CAST(o.total_money AS DECIMAL(14,2)) AS total_money,
  CAST(json_extract_string(u.d, '$.item_num') AS BIGINT) AS item_num,
  CAST(json_extract_string(u.d, '$.item_grade_num') AS BIGINT) AS item_grade_num,
  json_extract_string(u.d, '$.item_code') AS item_code,
  json_extract_string(u.d, '$.item_barcode') AS bar_code,
  json_extract_string(u.d, '$.item_name') AS item_name,
  json_extract_string(u.d, '$.item_spec') AS item_spec,
  json_extract_string(u.d, '$.item_unit') AS item_unit,
  json_extract_string(u.d, '$.lot_number') AS lot_number,
  CAST(json_extract_string(u.d, '$.quantity') AS DECIMAL(14,6)) AS quantity,
  CAST(json_extract_string(u.d, '$.use_quantity') AS DECIMAL(14,6)) AS use_quantity,
  json_extract_string(u.d, '$.use_unit') AS use_unit,
  CAST(json_extract_string(u.d, '$.use_rate') AS DECIMAL(18,8)) AS use_rate,
  CAST(json_extract_string(u.d, '$.present_quantity') AS DECIMAL(14,6)) AS present_quantity,
  json_extract_string(u.d, '$.production_date') AS production_date,
  CAST(json_extract_string(u.d, '$.unit_price') AS DECIMAL(18,8)) AS unit_price,
  CAST(json_extract_string(u.d, '$.subtotal') AS DECIMAL(14,2)) AS subtotal,
  CAST(json_extract_string(u.d, '$.out_money') AS DECIMAL(14,2)) AS out_money,
  CAST(json_extract_string(u.d, '$.in_money') AS DECIMAL(14,2)) AS in_money,
  CAST(json_extract_string(u.d, '$.cost') AS DECIMAL(18,8)) AS cost
FROM input o
CROSS JOIN UNNEST(from_json(CAST(o.items AS JSON), '["JSON"]')) AS u(d)`

// 哨兵页守卫：第 9 页（哨兵页）非空 = 单量击穿 8 页×100 = 800 单/日容量 ⇒ 大声红（dim.item 口径）
const sentinelMsg = "lemeng transfer_out 容量截断：第 9 页（哨兵页）仍有 {rows} 行（system_book=${ENV:SYSTEM_BOOK}）⇒ 单量已击穿真阈值 800 条/日（算式：数据页 8 × page_size 100，哨兵页不计容量）。处置：加数据页节点 → 同步改本算式与哨兵页的 page_number → 重生成 → 走 PR"

/** @param {string} id @param {string} componentId @param {Record<string, unknown>} properties @param {string} [type] */
const node = (id, componentId, properties, type = 'transform') => ({
  id, type, position: { x: 0, y: 0 },
  data: { label: id, componentId, properties },
})
/** @param {string} id @param {string} condition @param {string} message */
const die = (id, condition, message) => node(id, 'ctl.die', { condition, message })
/** @type {(sql: string) => Record<string, string>} 单形状：code.sql 节点属性恒只有 sql */
const codeSql = (sql) => ({ sql })

const PAGES = 9          // p1..p8 数据页 + p9 哨兵页
const DATA_PAGES = PAGES - 1
const pIds = []
/** @type {unknown[]} */
const pNodes = []
for (let i = 1; i <= PAGES; i++) {
  const id = `p${i}`
  pIds.push(id)
  pNodes.push(pageNode(id, i))
}

/** @type {any} */
const pipeline = {
  name: `lemeng.transfer.out.l0.${book}`,
  nodes: [
    // ── 身份门（逐字镜像 dim.item/price w0..d1）─────────────────────────────────
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
    node('gv', 'code.sql', codeSql(`SELECT 'BRANCH_NUMS' AS violation, '\${ENV:BRANCH_NUMS}' AS detail, 'JSON integer array, e.g. [1001,1002]' AS rule WHERE NOT regexp_full_match('\${ENV:BRANCH_NUMS}', '\\[[0-9]+([, ]+[0-9]+)*\\]') UNION ALL SELECT 'SYSTEM_BOOK', '\${ENV:SYSTEM_BOOK}', 'digits only' WHERE NOT regexp_full_match('\${ENV:SYSTEM_BOOK}', '[0-9]{1,32}') UNION ALL SELECT 'BIZDAY', '\${date-1d}', 'YYYY-MM-DD' WHERE NOT regexp_full_match('\${date-1d}', '[0-9]{4}-[0-9]{2}-[0-9]{2}') UNION ALL SELECT 'BATCH_ID', ${batchIdExpr} AS v, 'to-<book>-transfer_out-YYYYMMDDTHHMMSSZ' WHERE NOT regexp_full_match(${batchIdExpr}, 'to-[0-9]+-transfer_out-[0-9]{8}T[0-9]{6}Z')`)),
    die('dv', 'has-rows', 'EXPECTED_VALUE_MISSING_OR_MALFORMED: 期望值缺席或形状非法（{rows} 条违规，明细见上）⇒ 拒绝采集与写湖。处置：检查该管线调度/触发面的 env 注入'),
    ...pNodes,
    node('merge', 'ctl.merge', {}),
    node('shape', 'code.sql', codeSql(SHAPE_SQL)),
    node('gate', 'qa.contract', { rules: {
      batch_id: 'not_null', system_book: 'not_null', bizday: 'not_null',
      order_no: 'not_null', branch_num: 'not_null', item_num: 'not_null', item_code: 'not_null',
    } }),
    node('sink', 'snk.minio', {
      bucket: '${ENV:ZOS_BUCKET}',
      key: 'lemeng/transfer_out/system_book=${ENV:SYSTEM_BOOK}/bizday=${date-1d}/all.parquet',
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
    ...pIds.map((id, i) => ({ id: `e-${id}-merge`, source: id, target: 'merge', sourceHandle: 'main', targetHandle: `main_${i + 1}`, data: { connectionType: 'main' } })),
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
