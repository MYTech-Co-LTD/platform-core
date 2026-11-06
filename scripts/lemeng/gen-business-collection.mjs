#!/usr/bin/env node
// gen-business-collection.mjs —— 营业收款三件套管线生成器（2026-11-06）。
//
// 为什么用生成器：三件套（门店汇总 / 门店收款构成 / 卡券汇总）**骨架逐字相同**，
// 只差「请求体 / 列集 / 湖前缀 / 契约规则」四处。手编 9 个 JSON 必然漂移
// （同一个列名会同时出现在子管线 n、s 与父级 asm、s、gc 五处）。
//
// 骨架来源：`lemeng.branch_indicator.{day,l0.3120}.json`（已验证的身份门 + 分块 foreach 形态）。
// 本脚本**克隆那份模板再改属性**，保证 type/position/边的连接类型与模板逐字一致。
//
// 产出（仓根跑）：
//   node scripts/lemeng/gen-business-collection.mjs           # 生成/覆盖
//   node scripts/lemeng/gen-business-collection.mjs --check   # 只比对，漂移 exit 1
//
// 产出后必须：duckle `validate_pipeline` 过 → 才许提交（仓内文件 = 引擎验过的）。
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'deploy/duckle/console/pipelines'
const CHECK = process.argv.includes('--check')
const TPL_SUB = 'lemeng.branch_indicator.day.json'
const TPL_PARENT = 'lemeng.branch_indicator.l0.3120.json'
const BOOKS = ['3120', '64188']

/** @typedef {[string, string]} Col  列（名字, SQL 类型） */
/** @typedef {{ slug: string, name: string, ability: string, body: (d: string) => string, extraRules: Record<string, string>, cols: Col[] }} Report */

/** DEC = 金额列（DECIMAL(20,2)）；RATE = 占比列；INT/TXT/JSON */
const DEC = 'DECIMAL(20, 2)'
const RATE = 'DECIMAL(20, 6)'

/**
 * 三件套定义。`cols` 里 branch_* 恒在首位（父级 gchk 按 branch_num 对账）。
 * `key` = 湖前缀 / staging 目录名；`dims` = 行粒度补充列（会被 gc 断言 not_null）。
 */
/** @type {Report[]} */
const REPORTS = [
  {
    slug: 'business_collection',
    name: '营业收款报表-门店汇总',
    ability: 'nhsoft.report.ai.businesscollection.find',
    body: (d) => `{"date_start":"${d}","date_end":"${d}","summary_types":["branch"],"branch_nums":\${ITER_ITEM_BRANCH_NUMS_JSON},"date_type":"bizday"}`,
    extraRules: {},
    cols: [
      ['branch_num', 'INT'], ['branch_code', 'TXT'], ['branch_name', 'TXT'],
      ['branch_region_num', 'INT'], ['branch_region_name', 'TXT'], ['branch_type', 'TXT'],
      ['payment_receipt_money', DEC], ['payment_receipt_total_money', DEC],
      ['all_order_post_fee', DEC], ['order_total_discount_money', DEC],
      ['un_paid_money', DEC], ['make_up_money', DEC],
      ['cash_system_money', DEC], ['cash_difference_money', DEC], ['shift_table_actual_cash_money', DEC],
      ['card_deposit_money', 'JSONL'], ['card_deposit_total_money', DEC],
      ['card_consume_self_money', DEC], ['card_consume_present_money', DEC],
      ['prepaid_card_money', 'JSONL'], ['prepaid_card_total_money', DEC],
      ['pick_up_card_money', 'JSONL'], ['pick_up_card_total_money', DEC],
      ['coupon_amount', DEC], ['coupon_detail_sale_money', DEC], ['order_coupon_total_money', DEC],
      ['other_inout_money', 'JSONL'], ['other_inout_total_money', DEC],
      ['online_payment_receipt_money', DEC], ['online_coupon_amount', DEC],
      ['all_payment_type_moneys', 'JSONL'],
    ],
  },
  {
    slug: 'business_collection_receive',
    name: '营业收款报表-门店收款构成',
    ability: 'nhsoft.report.ai.businesscollection.receive.find',
    body: (d) => `{"date_start":"${d}","date_end":"${d}","summary_types":["branch","payment_type"],"branch_nums":\${ITER_ITEM_BRANCH_NUMS_JSON},"order_types":["已结账单","卡存款","其他收支","会员换卡","会员续卡","付费会员","次卡"],"date_type":"bizday"}`,
    extraRules: { payment_type: 'not_null' },
    cols: [
      ['branch_num', 'INT'], ['branch_code', 'TXT'], ['branch_name', 'TXT'], ['payment_type', 'TXT'],
      ['receive_money', DEC], ['receive_money_rate', RATE],
      ['order_count', 'INT'], ['order_count_rate', RATE],
      ['pos_order_receive_money', DEC], ['pos_order_count', 'INT'],
      ['card_deposit_receive_money', DEC], ['card_deposit_order_count', 'INT'],
      ['card_relate_receive_money', DEC], ['card_relate_order_count', 'INT'],
      ['card_replace_receive_money', DEC], ['card_replace_order_count', 'INT'],
      ['exchange_card_receive_money', DEC], ['exchange_card_order_count', 'INT'],
      ['other_receive_money', DEC], ['other_order_count', 'INT'],
      ['purchase_records_receive_money', DEC], ['purchase_records_order_count', 'INT'],
    ],
  },
  {
    slug: 'business_collection_coupon',
    name: '营业收款报表-卡券汇总',
    ability: 'nhsoft.report.ai.businesscollection.coupon.find',
    body: (d) => `{"date_start":"${d}","date_end":"${d}","summary_types":["branch","coupon_type"],"branch_nums":\${ITER_ITEM_BRANCH_NUMS_JSON},"date_type":"bizday"}`,
    extraRules: { coupon_type_name: 'not_null' },
    cols: [
      ['branch_num', 'INT'], ['branch_code', 'TXT'], ['branch_name', 'TXT'],
      ['branch_region_num', 'INT'], ['branch_region_name', 'TXT'], ['branch_type', 'TXT'],
      ['coupon_type_name', 'TXT'],
      ['coupon_amount', DEC], ['coupon_detail_sale_money', DEC],
      ['coupon_discount_money', DEC], ['coupon_value', DEC],
      ['exchange_card_sale_money', DEC], ['exchange_card_total_money', DEC],
      ['exchange_card_verification_count', 'INT'],
    ],
  },
]

/** @param {string} expr @param {string} type @returns {string} */
/** 列类型速记 → DuckDB SQL 类型。JSONL = 源端返回的是「对象数组」（如按支付方式拆分的金额明细），
 *  统一按 JSON 串落湖（2026-11-06 真机实测：.find 的 card_deposit_money / prepaid_card_money /
 *  pick_up_card_money / other_inout_money / all_payment_type_moneys 都是 list，强转 DECIMAL 会炸
 *  `Unimplemented type for cast (STRUCT(...)[] -> DECIMAL(20,2))`）。⚠️ 占位行 `CAST(NULL AS …)` 必须用**这里**，不能用速记本身
 *  （2026-11-06 真机教训：`validate` 对 `CAST(NULL AS TXT)` 放行，run 时 DuckDB 报
 *  `Catalog Error: Type with name TXT does not exist` ⇒ 整个 foreach 子管线炸在 s 节点）。 */
const sqlType = (/** @type {string} */ t) =>
  t === 'INT' ? 'INTEGER' : t === 'TXT' || t === 'JSON' || t === 'JSONL' ? 'VARCHAR' : t

/** @param {string} expr @param {string} type @returns {string} */
const cast = (expr, type) => `CAST(${expr} AS ${sqlType(type)})`

/** @param {string} f @returns {any} */
const readJson = (f) => JSON.parse(readFileSync(join(DIR, f), 'utf8'))
/** @param {any} o @returns {any} */
const clone = (o) => JSON.parse(JSON.stringify(o))
/** @param {any} doc @param {string} id @returns {any} */
const nodeOf = (doc, id) => {
  const n = doc.nodes.find((/** @type {any} */ x) => x.id === id)
  if (!n) throw new Error(`node ${id} 不在模板里`)
  return n
}
/** @param {any} doc @param {string} id @param {any} props @returns {void} */
const setProps = (doc, id, props) => Object.assign(nodeOf(doc, id).data.properties, props)

/** 子管线：单块请求 → 网关闸 → 逐门店左连接 → staging 分块。 @param {Report} r @returns {any} */
function buildSub(r) {
  const doc = clone(readJson(TPL_SUB))
  doc.name = `lemeng.${r.slug}.day`
  doc.id = `lemeng.${r.slug}.day`
  doc.version = 1
  doc._note = [
    `lemeng.${r.slug}.day —— ${r.name} 的单块子管线（由父管线 ctl.foreach 驱动，不单独调度）。`,
    '',
    `生成器：scripts/lemeng/gen-business-collection.mjs（勿手改；改列集改生成器再重跑）。`,
    `骨架克隆自 lemeng.branch_indicator.day.json，身份门与分块在父管线。`,
    '',
    `① 请求：POST ${r.ability}，一天一窗（BIZDAY=BIZDAY），branch_nums 由父管线按 100 家切好传入。`,
    `② 网关闸（denv）：code != 0 即拒写；10001=单请求超 100 家，10003=名单含本凭据无权限的店号。`,
    `③ 截断闸（gtc/dtc）：result.total_count 必须等于 result.rows 长度——接口不分页，不等即被截断。`,
    `④ 逐门店左连接（n）：以请求里的门店清单为左表，源端没返回的门店 matched=false ⇒`,
    `   整天全空由父级 gall/dall 裁决，单块空只写 1 行占位（branch_num=NULL）保证分块到齐判据成立。`,
    `⑤ staging：/workspace/.duckle-stage/${r.slug}/chunk-<batch>-<chunk>.parquet。`,
  ]
  setProps(doc, 'f', {
    url: `https://cloud.nhsoft.cn/agi/api/${r.ability}`,
    body: r.body('${ITER_ITEM_BIZDAY}'),
    rawResponseDestination: `/workspace/.duckle-raw/${r.slug}-\${ITER_ITEM_BATCH_ID}-c\${ITER_ITEM_CHUNK_NO}.json`,
  })
  setProps(doc, 'env', {
    sql: `SELECT CAST(code AS INTEGER) AS code, CAST(msg AS VARCHAR) AS msg\nFROM read_json_auto('/workspace/.duckle-raw/${r.slug}-\${ITER_ITEM_BATCH_ID}-c\${ITER_ITEM_CHUNK_NO}.json')\nWHERE CAST(code AS INTEGER) <> 0`,
  })
  setProps(doc, 'denv', {
    message: `${r.slug} 网关非 0 code（{rows} 条）：chunk \${ITER_ITEM_CHUNK_NO}/\${ITER_ITEM_N_CHUNKS} bizday=\${ITER_ITEM_BIZDAY}；10001=单请求超 100 家，10003=名单里有本凭据无权限的店号。raw 见 /workspace/.duckle-raw/${r.slug}-\${ITER_ITEM_BATCH_ID}-c\${ITER_ITEM_CHUNK_NO}.json`,
  })
  setProps(doc, 'gtc', {
    sql: `SELECT * FROM (\n  SELECT CAST(json_extract_string(CAST(content AS JSON), '$.result.total_count') AS BIGINT) AS total_count,\n         CAST(json_array_length(json_extract(CAST(content AS JSON), '$.result.rows')) AS BIGINT) AS n_rows\n  FROM read_text('/workspace/.duckle-raw/${r.slug}-\${ITER_ITEM_BATCH_ID}-c\${ITER_ITEM_CHUNK_NO}.json')\n) t\nWHERE t.total_count IS DISTINCT FROM t.n_rows`,
  })
  setProps(doc, 'dtc', {
    message: `网关自相矛盾：total_count 与返回行数不等（{rows} 条）——响应被截断，拒绝写湖。raw 见 /workspace/.duckle-raw/${r.slug}-\${ITER_ITEM_BATCH_ID}-c\${ITER_ITEM_CHUNK_NO}.json`,
  })

  // n：请求门店清单左连接源端行
  // ⚠️ 直接 join `input`，**不再套派生表**：2026-11-06 真机实测，套派生表时 coupon 子管线在绑定阶段报
  //    `Binder Error: Referenced table "r" not found! Candidate tables: "req"`（同一形状 receive 却能过）。
  //    扁平成 `LEFT JOIN input ON ...` 后不再有别名作用域可丢。
  setProps(doc, 'n', {
    sql:
      `SELECT CAST(req.branch_num AS INTEGER) AS branch_num,\n` +
      r.cols.filter(([c]) => c !== 'branch_num').map(([c, t]) => `       ${cast('input.' + c, t)} AS ${c}`).join(',\n') + ',\n' +
      `       input.branch_num IS NOT NULL AS matched\n` +
      `FROM (SELECT CAST(j.value AS BIGINT) AS branch_num FROM json_each('\${ITER_ITEM_BRANCH_NUMS_JSON}') j) req\n` +
      `LEFT JOIN input ON CAST(input.branch_num AS BIGINT) = req.branch_num`,
  })

  // 子管线不再需要「月份锚里的日项」那道闸（本接口一请求即一天）
  doc.nodes = doc.nodes.filter((/** @type {any} */ n) => !['gday', 'dday'].includes(n.id))
  doc.edges = doc.edges.filter((/** @type {any} */ e) => !['gday', 'dday'].includes(e.source) && !['gday', 'dday'].includes(e.target))

  const bodyCols = r.cols.filter(([c]) => c !== 'branch_num').map(([c, t]) => `       ${cast(c, t)} AS ${c}`).join(',\n')
  setProps(doc, 's', {
    sql:
      `SELECT '\${ITER_ITEM_BATCH_ID}' AS batch_id,\n` +
      `       CAST(\${ITER_ITEM_SYSTEM_BOOK} AS INTEGER) AS system_book,\n` +
      `       CAST('\${ITER_ITEM_BIZDAY}' AS DATE) AS bizday,\n` +
      `       CAST(branch_num AS INTEGER) AS branch_num,\n` +
      `${bodyCols},\n` +
      `       CAST(CURRENT_TIMESTAMP AS TIMESTAMPTZ) AS computed_at,\n` +
      `       CAST((SELECT count(DISTINCT branch_num) FROM input WHERE matched) AS INTEGER) AS chunk_n_matched\n` +
      `FROM input\nWHERE matched\nUNION ALL\n` +
      `SELECT '\${ITER_ITEM_BATCH_ID}', CAST(\${ITER_ITEM_SYSTEM_BOOK} AS INTEGER), CAST('\${ITER_ITEM_BIZDAY}' AS DATE),\n` +
      `       CAST(NULL AS INTEGER),\n` +
      r.cols.filter(([c]) => c !== 'branch_num').map(([, t]) => `       CAST(NULL AS ${sqlType(t)})`).join(',\n') + ',\n' +
      `       CAST(CURRENT_TIMESTAMP AS TIMESTAMPTZ), CAST(0 AS INTEGER)\n` +
      `WHERE NOT EXISTS (SELECT 1 FROM input WHERE matched)`,
  })
  setProps(doc, 'sink', { path: `/workspace/.duckle-stage/${r.slug}/chunk-\${ITER_ITEM_BATCH_ID}-\${ITER_ITEM_CHUNK_NO}.parquet` })
  return doc
}

/** 父管线：身份门 → 按 100 家切块 → foreach → 汇总闸 → 契约 → sink。 @param {Report} r @param {string} book @returns {any} */
function buildParent(r, book) {
  const doc = clone(readJson(TPL_PARENT))
  doc.name = `lemeng.${r.slug}.l0.${book}`
  doc.id = `lemeng.${r.slug}.l0.${book}`
  doc.version = 1
  doc._note = [
    `lemeng.${r.slug}.l0.${book} —— ${r.name}（账套 ${book}）日更主管线。`,
    '',
    `生成器：scripts/lemeng/gen-business-collection.mjs（勿手改）。`,
    `骨架克隆自 lemeng.branch_indicator.l0.3120.json；差异只有四处：`,
    `  ① 子管线 pipelineRef → lemeng.${r.slug}.day.json；`,
    `  ② staging 目录 /workspace/.duckle-stage/${r.slug}/；`,
    `  ③ 汇总列集（见 s / asm / gc）；`,
    `  ④ sink key → lemeng/${r.slug}/system_book=\${ENV:SYSTEM_BOOK}/bizday=\${date-1d}/all.parquet。`,
    '',
    `身份门同模板：whoami 自证账套与门店清单，未过则一个采集请求都不发。`,
    `分块：whoami 的 branch_nums 按 100 家切（接口硬上限），每块一次请求。`,
    `闸序：分块到齐 → 每块落盘门店数 == 自报匹配数 → 全空 → 契约 → sink。`,
    '',
    `回填变体由 scripts/lemeng/gen-backfill-variants.mjs 机械派生（窗口 \${date-1d} → \${BIZDAY}）。`,
  ]
  setProps(doc, 'fe', { pipelineRef: `\${workspace}/pipelines/lemeng.${r.slug}.day.json` })

  const asmCols = r.cols.map(([c, t]) => `       ${cast('cur.' + c, t)} AS ${c}`).join(',\n')
  setProps(doc, 'asm', {
    sql:
      `SELECT CAST(cur.batch_id AS VARCHAR) AS batch_id,\n` +
      `       CAST(cur.system_book AS INTEGER) AS system_book,\n` +
      `       CAST(cur.bizday AS DATE) AS bizday,\n` +
      `${asmCols},\n` +
      `       CAST(cur.computed_at AS TIMESTAMPTZ) AS computed_at,\n` +
      `       CAST(cur.file_chunk AS INTEGER) AS file_chunk,\n` +
      `       CAST(cur.chunk_n_matched AS INTEGER) AS chunk_n_matched,\n` +
      `       CAST(e.n_chunks AS INTEGER) AS exp_n_chunks,\n` +
      `       CAST(e.n_branches AS INTEGER) AS exp_n_branches\n` +
      `FROM (\n  SELECT *, regexp_extract(filename, 'chunk-([0-9]{8}T[0-9]{6}Z)-([0-9]+)\\.parquet$', 1) AS file_batch,\n` +
      `            CAST(regexp_extract(filename, 'chunk-([0-9]{8}T[0-9]{6}Z)-([0-9]+)\\.parquet$', 2) AS INTEGER) AS file_chunk\n` +
      `  FROM read_parquet('/workspace/.duckle-stage/${r.slug}/*.parquet', filename = true)\n) cur\n` +
      `CROSS JOIN (\n  SELECT any_value(batch_id) AS batch_id,\n         max(CAST(n_chunks AS INTEGER)) AS n_chunks,\n         sum(CAST(n_branches AS INTEGER)) AS n_branches\n  FROM input\n) e\n` +
      `WHERE cur.file_batch = e.batch_id`,
  })
  setProps(doc, 'gchk', {
    sql: `SELECT 'chunk_missing' AS violation, CAST(count(DISTINCT file_chunk) AS VARCHAR) AS detail, CAST(any_value(exp_n_chunks) AS VARCHAR) AS expected\nFROM input\nHAVING count(DISTINCT file_chunk) <> any_value(exp_n_chunks) OR count(*) = 0\nUNION ALL\nSELECT 'chunk_rows_vs_matched', CAST(file_chunk AS VARCHAR), CAST(max(chunk_n_matched) AS VARCHAR)\nFROM input\nGROUP BY file_chunk\nHAVING count(DISTINCT branch_num) <> max(chunk_n_matched)`,
  })
  setProps(doc, 's', {
    sql:
      `SELECT\n  CAST(batch_id AS VARCHAR) AS batch_id,\n  CAST(system_book AS INTEGER) AS system_book,\n  CAST(bizday AS DATE) AS bizday,\n` +
      r.cols.map(([c, t]) => `  ${cast(c, t)} AS ${c}`).join(',\n') + ',\n' +
      `  CAST(computed_at AS TIMESTAMPTZ) AS computed_at\nFROM input\nWHERE branch_num IS NOT NULL`,
  })
  const rules = { batch_id: 'not_null', system_book: 'not_null', bizday: 'not_null', branch_num: 'not_null', ...r.extraRules }
  setProps(doc, 'gc', { rules })
  setProps(doc, 'snk', { key: `lemeng/${r.slug}/system_book=\${ENV:SYSTEM_BOOK}/bizday=\${date-1d}/all.parquet` })
  setProps(doc, 'dasm', { message: `汇总为空：本期 batch 的 staging 分块没产出（foreach 全失败 / 目录被清）⇒ 拒绝写湖（${r.slug}）` })
  setProps(doc, 'dall', { message: `全部块 0 家门店有数据（bizday=\${date-1d}，共 {rows} 块）——权限收窄 / 网关空集，拒绝写湖（${r.slug}）` })
  return doc
}

const outputs = []
for (const r of REPORTS) {
  outputs.push([`lemeng.${r.slug}.day.json`, buildSub(r)])
  for (const b of BOOKS) outputs.push([`lemeng.${r.slug}.l0.${b}.json`, buildParent(r, b)])
}

let drift = 0
for (const [file, doc] of outputs) {
  const text = JSON.stringify(doc, null, 2) + '\n'
  if (CHECK) {
    let cur = ''
    try { cur = readFileSync(join(DIR, file), 'utf8') } catch { /* 缺失即漂移 */ }
    if (cur !== text) { console.error(`DRIFT ${file}`); drift++ }
  } else {
    writeFileSync(join(DIR, file), text)
    console.log(`wrote ${file}`)
  }
}
if (CHECK && drift) process.exit(1)
if (CHECK) console.log(`OK ${outputs.length} 个生成物与仓内一致`)
