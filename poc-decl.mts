// PoC：DB 作 L1 事实源——声明表 / 运行时编译 / 变更审计 / 反向导出
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { parse, stringify } from 'yaml'
import { declarationsFromYaml } from './scripts/sync-data-semantics.mjs'
import { loadMergedCatalog, upsertL1Metric } from './modules/data/domain/metric-store.ts'

const require = createRequire('/Users/duo/mytechcode/platform-core/modules/data/package.json')
const { Pool } = require('pg')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const YAML = '/Users/duo/mytechcode/platform-core/dbt/semantics/l1_metrics.yml'
const doc = parse(readFileSync(YAML, 'utf8'))

// ① 声明表 + 顶层文档表
await pool.query(`create table if not exists data.metric_declaration (
  id text primary key, doc jsonb not null, decl_version int not null default 1,
  updated_by text, updated_at timestamptz not null default now())`)
await pool.query(`create table if not exists data.semantic_doc (
  name text primary key, doc jsonb not null, doc_version int not null default 1,
  updated_by text, updated_at timestamptz not null default now())`)
for (const m of doc.metrics) {
  await pool.query(`insert into data.metric_declaration(id, doc, updated_by) values ($1,$2,'poc')
    on conflict (id) do update set doc=excluded.doc, decl_version=data.metric_declaration.decl_version+1, updated_at=now()`,
  [m.name, JSON.stringify(m)])
}
await pool.query(`insert into data.semantic_doc(name, doc, updated_by) values ('l1',$1,'poc')
  on conflict (name) do update set doc=excluded.doc, updated_at=now()`,
[JSON.stringify({ version: doc.version, entities: doc.entities, domains: doc.domains, measures: doc.measures })])

// ② 运行时编译：同一份 YAML → 声明（现由 sync 独占），比对现有 DB 产物
const compiled = declarationsFromYaml(doc)
const dbSel = new Map((await pool.query("select id, select_sql from data.metrics where source='l1'")).rows.map((r) => [r.id, r.select_sql]))
const norm = (x) => String(x).replace(/\s+/g, ' ').trim()
const stable = (v) => {
  if (Array.isArray(v)) return v.map(stable)
  if (v !== null && typeof v === 'object') {
    const o = {}
    for (const k of Object.keys(v).sort()) o[k] = stable(v[k])
    return o
  }
  return v
}
const eqDeep = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b))
let same = 0; const diffs = []
for (const d of compiled) {
  if (norm(d.selectSql) === norm(dbSel.get(d.id))) same += 1
  else diffs.push({ id: d.id, compiled: norm(d.selectSql).slice(0, 80), db: norm(dbSel.get(d.id) ?? '').slice(0, 80) })
}

// ③ 反向导出：库内声明 → 文档对象 → 与仓内逐字段深比对
const decls = (await pool.query('select id, doc from data.metric_declaration order by id')).rows
const sdoc = (await pool.query("select doc from data.semantic_doc where name='l1'")).rows[0].doc
const exported = { version: sdoc.version, entities: sdoc.entities, domains: sdoc.domains, measures: sdoc.measures, metrics: decls.map((r) => r.doc) }
const byName = new Map(doc.metrics.map((m) => [m.name, m]))
let eq = 0; const fd = []
for (const m of exported.metrics) {
  const o = byName.get(m.name)
  for (const k of new Set([...Object.keys(m), ...Object.keys(o ?? {})])) {
    if (eqDeep(m[k], o?.[k])) eq += 1
    else fd.push({ id: m.name, field: k })
  }
}
for (const k of ['version', 'entities', 'domains', 'measures']) {
  if (eqDeep(exported[k], doc[k])) eq += 1
  else fd.push({ id: 'top', field: k })
}

// ④ 运行时改一条「率类」指标（原来需要改 YAML + 发版）
const target = 'lemeng:outbound:gross_margin_rate'
const beforeDecl = decls.find((r) => r.id === target).doc
const beforeRow = (await pool.query("select select_sql from data.metrics where org='platform' and id=$1", [target])).rows[0]
const edited = JSON.parse(JSON.stringify(beforeDecl))
edited.ratio.denominator = 'sum(fct_hq_outbound.r_net) * 1'   // 语义等价的「改动」演示（真实变更会改口径）
const editDoc = structuredClone(doc); editDoc.metrics = editDoc.metrics.map((m) => m.name === target ? edited : m)
const newDecl = declarationsFromYaml(editDoc).find((d) => d.id === target)
await upsertL1Metric(pool, newDecl)
const afterRow = (await pool.query("select select_sql from data.metrics where org='platform' and id=$1", [target])).rows[0]
const catalog = (await loadMergedCatalog(pool, 'acme')).find((m) => m.id === target)

// ⑤ 审计（当前 upsertL1Metric 不写，PoC 证明可补）
await pool.query(`insert into data.metric_audit(org, metric_id, action, user_id, channel, row_before, row_after)
  values ('platform',$1,'update','poc-user','session',$2::jsonb,$3::jsonb)`,
[target, JSON.stringify(beforeRow), JSON.stringify(afterRow)])
const audit = (await pool.query("select id, row_before->>'select_sql' as b, row_after->>'select_sql' as a from data.metric_audit where org='platform' and metric_id=$1 order by id desc limit 1", [target])).rows[0]

// ⑥ 从审计快照回滚，并核对词表
await pool.query(`update data.metrics set select_sql=$2, updated_at=now() where org='platform' and id=$1`, [target, audit.b])
const reverted = (await loadMergedCatalog(pool, 'acme')).find((m) => m.id === target)

import { writeFileSync } from 'node:fs'
writeFileSync('/tmp/l1-exported.yml', stringify(exported, { lineWidth: 0 }))
console.log(JSON.stringify({
  declared: compiled.length,
  compileSameAsSync: same, compileDiffs: diffs.slice(0, 2), compileDiffCount: diffs.length,
  exportFieldsEqual: eq, exportFieldDiffs: fd.slice(0, 5), exportFieldDiffCount: fd.length,
  runtimeEdit: {
    changed: beforeRow.select_sql !== afterRow.select_sql,
    catalogSeesEdit: catalog?.selectSql === afterRow.select_sql,
    auditCaptured: audit !== undefined,
    revertRestored: reverted?.selectSql === beforeRow.select_sql,
  },
}, null, 1))
await pool.end()
