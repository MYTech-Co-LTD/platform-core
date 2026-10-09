// gen-client-pipeline.mjs — #516 段① 批发客户档案 L0 管线的**生成器**（管线 JSON 不手编）。
//
// 产出 deploy/duckle/console/pipelines/lemeng.client.l0.3120.json。
// 结构镜像批发单生成器（身份门 w0..d1 → gv/dv → 数据页 → merge → shape → gate → sink），差异：
//   ① 接口 = nhsoft.whs.ai.client.find，**GET 裸码路径**（零参数路由——limit/offset/keyword
//      全无效，openapi paths 无 parameters；POST 三形态全断，见正典 §1.7 例外路线登记与
//      .superpowers/sdd/2026-10-10-500-lemeng-client/probe-report.md）⇒ **单页固定窗快照**，
//      无翻页、无哨兵页。
//   ② 哨兵语义改为**行数带守卫**：no-rows（路由挂了）或 <500（窗口骤缩=接口行为变化）⇒ die。
//      上限不设（窗口变大只增加覆盖，无害漂移）。落窗外客户由发布侧未映射大声红兜底。
//   ③ 基础资料无业务时间窗：分区键 = system_book + snapshot（采集当日，dim_branch 先例）。
//
// 用法（仓根跑）：
//   node scripts/lemeng/gen-client-pipeline.mjs --book 3120 \
//     --out deploy/duckle/console/pipelines/lemeng.client.l0.3120.json
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
const WINDOW_FLOOR = 500   // 行数带下界：2026-10-10 实测固定窗 707；跌破 = 接口行为变化

// shape SQL 引用的源字段全部申报（check-data-contract 硬门；漏报 = 空响应 Binder Error，#432 族）
const SRC_SCHEMA = [
  { name: 'client_fid', type: 'string' },
  { name: 'client_name', type: 'string' },
  { name: 'client_code', type: 'string' },
  { name: 'client_type', type: 'string' },
  { name: 'branch_num', type: 'int64' },
  { name: 'client_actived', type: 'bool' },
  { name: 'client_del_tag', type: 'bool' },
  { name: 'client_last_edit_time', type: 'string' },
]

const batchIdExpr = `'cl-' || '\${ENV:SYSTEM_BOOK}' || '-client-' || replace(replace('\${datetime}','-',''),'_','T') || 'Z'`

const SHAPE_SQL = `SELECT
  ${batchIdExpr} AS batch_id,
  '\${ENV:SYSTEM_BOOK}' AS system_book,
  CAST('\${date}' AS DATE) AS snapshot,
  CAST(c.client_fid AS VARCHAR) AS client_fid,
  CAST(c.client_name AS VARCHAR) AS client_name,
  CAST(c.client_code AS VARCHAR) AS client_code,
  CAST(c.client_type AS VARCHAR) AS client_type,
  CAST(c.branch_num AS BIGINT) AS branch_num,
  CAST(c.client_actived AS BOOLEAN) AS client_actived,
  CAST(c.client_del_tag AS BOOLEAN) AS client_del_tag,
  CAST(c.client_last_edit_time AS VARCHAR) AS client_last_edit_time
FROM input c`

/** @param {string} id @param {string} componentId @param {Record<string, unknown>} properties @param {string} [type] */
const node = (id, componentId, properties, type = 'transform') => ({
  id, type, position: { x: 0, y: 0 },
  data: { label: id, componentId, properties },
})
/** @param {string} id @param {string} condition @param {string} message */
const die = (id, condition, message) => node(id, 'ctl.die', { condition, message })
/** @type {(sql: string) => Record<string, string>} 单形状：code.sql 节点属性恒只有 sql */
const codeSql = (sql) => ({ sql })

/** @type {any} */
const pipeline = {
  name: `lemeng.client.l0.${book}`,
  nodes: [
    // ── 身份门（逐字镜像 wholesale w0..d1）────────────────────────────────────────
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
    node('gv', 'code.sql', codeSql(`SELECT 'SYSTEM_BOOK' AS violation, '\${ENV:SYSTEM_BOOK}' AS detail, 'digits only' AS rule WHERE NOT regexp_full_match('\${ENV:SYSTEM_BOOK}', '[0-9]{1,32}') UNION ALL SELECT 'SNAPSHOT', '\${date}', 'YYYY-MM-DD' WHERE NOT regexp_full_match('\${date}', '[0-9]{4}-[0-9]{2}-[0-9]{2}') UNION ALL SELECT 'BATCH_ID', ${batchIdExpr} AS v, 'cl-<book>-client-YYYYMMDDTHHMMSSZ' WHERE NOT regexp_full_match(${batchIdExpr}, 'cl-[0-9]+-client-[0-9]{8}T[0-9]{6}Z')`)),
    die('dv', 'has-rows', 'EXPECTED_VALUE_MISSING_OR_MALFORMED: 期望值缺席或形状非法（{rows} 条违规，明细见上）⇒ 拒绝采集与写湖。处置：检查该管线调度/触发面的 env 注入'),
    // ── 单页固定窗（GET 零参数；见文件头注 ①）────────────────────────────────────
    // ⚠️ 拓扑纪律（2026-10-10 首跑实测）：**数据主路 p1 → merge 直连**；行数带守卫（d2→b1→dw）
    //    是**旁支**（像批发单的哨兵页一样汇回 merge 的另一个 handle）。若把数据串过守卫链，
    //    健康时 merge 收到的是「违规清单（0 行）」形状，shape 全列 Binder 报错。
    {
      id: 'p1', type: 'source', position: { x: 0, y: 0 },
      data: {
        label: 'p1', componentId: 'src.rest',
        schema: SRC_SCHEMA,
        properties: {
          connectionRef: 'lemeng',
          url: 'https://cloud.nhsoft.cn/agi/api/nhsoft.whs.ai.client.find',
          method: 'GET',
          responsePath: '/result',
          paginationType: 'none',
          retryAttempts: 3,
          retryBackoffMs: 2000,
        },
      },
    },
    die('d2', 'no-rows', 'client: 固定窗返回 0 行（路由挂了或档案被清空）⇒ 拒绝采集与写湖'),
    // ⚠️ 引擎在外层自动包 `WITH input AS (SELECT * FROM 上游)` ⇒ 本 SQL 不能再写顶层 WITH（Parser
    //    Error，2026-10-10 首跑实测）；行数聚合用子查询形态。
    node('b1', 'code.sql', codeSql(`SELECT 'window_shrunk' AS violation, n.c AS detail FROM (SELECT count(*) AS c FROM input) n WHERE n.c < ${WINDOW_FLOOR}`)),
    die('dw', 'has-rows', `lemeng client 窗口骤缩：固定窗实测 707 条（2026-10-10），本窗 < ${WINDOW_FLOOR}（{rows} 行违规）⇒ 接口行为变化，拒绝采集与写湖。处置：复核探针（GET 路由是否改版）→ 走 PR`),
    node('merge', 'ctl.merge', {}),
    node('shape', 'code.sql', codeSql(SHAPE_SQL)),
    node('gate', 'qa.contract', { rules: {
      batch_id: 'not_null', system_book: 'not_null', snapshot: 'not_null', client_fid: 'not_null',
    } }),
    node('sink', 'snk.minio', {
      bucket: '${ENV:ZOS_BUCKET}',
      key: 'lemeng/client/system_book=${ENV:SYSTEM_BOOK}/snapshot=${date}/all.parquet',
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
    { id: 'e-dv-p1', source: 'dv', target: 'p1', sourceHandle: null, targetHandle: null, data: { connectionType: 'on-subjob-ok' } },
    // 数据主路：p1 直连 merge（main_1）
    { id: 'e-p1-merge', source: 'p1', target: 'merge', sourceHandle: 'main', targetHandle: 'main_1', data: { connectionType: 'main' } },
    // 守卫旁支：p1 → d2(no-rows) → b1(行数带) → dw(has-rows) → merge(main_2，健康时 0 行)
    { id: 'e-p1-d2', source: 'p1', target: 'd2', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } },
    { id: 'e-d2-b1', source: 'd2', target: 'b1', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } },
    { id: 'e-b1-dw', source: 'b1', target: 'dw', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } },
    { id: 'e-dw-merge', source: 'dw', target: 'merge', sourceHandle: 'main', targetHandle: 'main_2', data: { connectionType: 'main' } },
    { id: 'e-merge-shape', source: 'merge', target: 'shape', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } },
    { id: 'e-shape-gate', source: 'shape', target: 'gate', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } },
    { id: 'e-gate-sink', source: 'gate', target: 'sink', sourceHandle: 'main', targetHandle: 'main', data: { connectionType: 'main' } },
  ],
}

writeFileSync(out, JSON.stringify(pipeline, null, 2) + '\n')
console.log(`written: ${out} (book=${book} 固定窗单页，窗口下界=${WINDOW_FLOOR})`)

// 自证：读回形状 sanity
const check = JSON.parse(readFileSync(out, 'utf8'))
const sources = check.nodes.filter((/** @type {any} */ n) => n.data.componentId === 'src.rest')
console.log(`sanity: nodes=${check.nodes.length} edges=${check.edges.length} src.rest=${sources.length}（1 身份门 + ${sources.length - 1} 数据页）`)
