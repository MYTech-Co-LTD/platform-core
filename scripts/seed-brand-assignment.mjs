#!/usr/bin/env node
// @ts-nocheck —— CLI 薄壳：SQL/IO 编排，pg 经 root 解析、checkJs 推不出类型；逻辑用 dry-run/本地库实测兜底
// seed-brand-assignment.mjs — 租户品牌字典/门店归属灌数（#2892）。
//
// 用法（默认 dry-run，必须显式 --apply 才写库）：
//   node scripts/seed-brand-assignment.mjs --org shanhaiyiguo-org \
//     --input brand-seed.json [--apply] [--actor ops]
//   node scripts/seed-brand-assignment.mjs --org shanhaiyiguo-org --from-wuji \
//     --brand-map brand-map.json [--prefix-map prefix-map.json] [--apply]
//   node scripts/seed-brand-assignment.mjs --org shanhaiyiguo-org \
//     --from-dim-branch --prefix-map prefix-map.json [--apply]
//   ↑ 无 wuji 凭据时的引导：按 data.dim_branch 名称前缀分配（source='prefix'），
//     与旧运行时行为一致；之后用 --from-wuji 的 source_field 覆盖（prefix 行未锁，会被更新）。
//
// input JSON 形状：
//   {
//     "brands":      [{ "code":"xiongmao", "name":"熊喵", "sort":1, "source":"source_field" }],
//     "assignments": [{ "subject_type":"store", "subject_code":"S01",
//                       "brand_code":"xiongmao", "source":"source_field" }]
//   }
//
// wuji 模式的键从哪取：env `WUJI_ORIGIN` / `WUJI_APPID` / `WUJI_STORE_SCHEMAKEY`
// （可选 `WUJI_STORE_SCHEMAID` 默认 store_info、`WUJI_API_PATH` 默认 /api/private/object）。
// **密钥不进仓、不打印**。
//
// 纪律：
//   · 幂等：brand_registry / brand_assignment 都是 upsert；
//   · manual/locked 行不被源同步覆盖（where not locked or excluded.locked）；
//   · 每次运行写一条 data.brand_audit 汇总（不回填工单——回填用 backfill-ticket-brand.mjs）。
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
// pg 不是根依赖：从 data 模块解析（与 test-all.mjs 同一个绕法），别在根 package.json 加依赖。
const require = createRequire(new URL('../modules/data/package.json', import.meta.url))
const { Pool } = require('pg')

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? (process.argv[i + 1] ?? '') : fallback
}
const has = (name) => process.argv.includes(`--${name}`)

const org = arg('org')
if (!org) {
  console.error('缺 --org')
  process.exit(2)
}
const apply = has('apply')
const actor = arg('actor', process.env.USER ?? 'ops')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

function bad(msg) {
  console.error(msg)
  process.exit(2)
}

async function loadJson(path, what) {
  if (!path) bad(`缺 --${what}`)
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (e) {
    bad(`读 ${path} 失败：${e.message}`)
  }
}

function normalizeInput(raw) {
  const brands = Array.isArray(raw?.brands) ? raw.brands : []
  const assignments = Array.isArray(raw?.assignments) ? raw.assignments : []
  if (brands.length === 0) bad('input.brands 为空')
  if (assignments.length === 0) bad('input.assignments 为空')
  const brandByCode = new Map()
  for (const b of brands) {
    if (!b?.code || !b?.name) bad(`brand 缺 code/name：${JSON.stringify(b)}`)
    brandByCode.set(String(b.code), {
      code: String(b.code),
      name: String(b.name),
      sort: Number.isFinite(Number(b.sort)) ? Number(b.sort) : 0,
      source: String(b.source ?? 'manual'),
    })
  }
  const out = []
  for (const a of assignments) {
    if (!['store', 'product'].includes(a?.subject_type)) bad(`subject_type 非法：${JSON.stringify(a)}`)
    if (!a?.subject_code || !a?.brand_code) bad(`assignment 缺 subject_code/brand_code：${JSON.stringify(a)}`)
    if (!brandByCode.has(String(a.brand_code))) bad(`assignment 引用了不存在的 brand：${a.brand_code}`)
    const source = String(a.source ?? 'manual')
    out.push({
      subjectType: String(a.subject_type),
      subjectCode: String(a.subject_code),
      brandCode: String(a.brand_code),
      source,
      // 人工映射锁定；源同步/前缀/回填不锁
      locked: source === 'manual',
    })
  }
  return { brands: [...brandByCode.values()], assignments: out }
}

async function fetchWujiRows() {
  const origin = process.env.WUJI_ORIGIN
  const appid = process.env.WUJI_APPID
  const schemakey = process.env.WUJI_STORE_SCHEMAKEY
  if (!origin || !appid || !schemakey) {
    bad('wuji 模式需要 WUJI_ORIGIN / WUJI_APPID / WUJI_STORE_SCHEMAKEY')
  }
  const schemaid = process.env.WUJI_STORE_SCHEMAID ?? 'store_info'
  const apiPath = process.env.WUJI_API_PATH ?? '/api/private/object'
  const pageSize = 15000 // 源接口实测上限
  const rows = []
  for (let page = 1; ; page++) {
    const u = new URL(apiPath, origin)
    u.searchParams.set('appid', appid)
    u.searchParams.set('schemaid', schemaid)
    u.searchParams.set('schemakey', schemakey)
    u.searchParams.set('page', String(page))
    u.searchParams.set('size', String(pageSize))
    const res = await fetch(u)
    if (!res.ok) bad(`wuji HTTP ${res.status}（page=${page}）`)
    const body = await res.json().catch(() => null)
    const part = Array.isArray(body?.data) ? body.data : []
    rows.push(...part)
    if (part.length < pageSize) break
  }
  return rows
}

async function buildFromWuji() {
  const brandMap = await loadJson(arg('brand-map'), 'brand-map')
  const prefixMap = arg('prefix-map') ? await loadJson(arg('prefix-map'), 'prefix-map') : null
  const rows = await fetchWujiRows()
  const brands = []
  const seenBrands = new Set()
  for (const [key, v] of Object.entries(brandMap)) {
    if (!v?.code || !v?.name) bad(`brand-map[${key}] 缺 code/name`)
    if (!seenBrands.has(v.code)) {
      seenBrands.add(v.code)
      brands.push({ code: v.code, name: v.name, sort: Number(v.sort ?? 0), source: 'source_field' })
    }
  }
  const assignments = []
  let skipped = 0
  for (const r of rows) {
    const code = String(r?.store_code ?? '')
    const name = String(r?.store_name ?? '')
    if (!code) { skipped++; continue }
    let brand = brandMap[String(r?.brand_relation ?? '')]
    let source = 'source_field'
    if (!brand && prefixMap) {
      for (const [prefix, b] of Object.entries(prefixMap)) {
        if (name.startsWith(prefix) && b?.code) { brand = b; source = 'prefix'; break }
      }
    }
    if (!brand?.code) { skipped++; continue }
    assignments.push({ subject_type: 'store', subject_code: code, brand_code: brand.code, source })
  }
  return { ...normalizeInput({ brands, assignments }), skipped }
}

async function buildFromDimBranch(pool) {
  const prefixMap = await loadJson(arg('prefix-map'), 'prefix-map')
  const brands = []
  const seen = new Set()
  for (const [, b] of Object.entries(prefixMap)) {
    if (!b?.code || !b?.name) bad('prefix-map 的值缺 code/name')
    if (!seen.has(b.code)) {
      seen.add(b.code)
      brands.push({ code: b.code, name: b.name, sort: Number(b.sort ?? 0), source: 'prefix' })
    }
  }
  const rows = (await pool.query(
    'select code, name from data.dim_branch where org = $1 order by code', [org],
  )).rows
  const assignments = []
  let skipped = 0
  for (const r of rows) {
    let hit = null
    for (const [prefix, b] of Object.entries(prefixMap)) {
      if (String(r.name ?? '').startsWith(prefix) && b?.code) { hit = b; break }
    }
    if (!hit) { skipped++; continue }
    assignments.push({ subject_type: 'store', subject_code: r.code, brand_code: hit.code, source: 'prefix' })
  }
  return { ...normalizeInput({ brands, assignments }), skipped }
}

async function main() {
  const input = has('from-wuji')
    ? await buildFromWuji()
    : has('from-dim-branch')
      ? await buildFromDimBranch(pool)
      : normalizeInput(await loadJson(arg('input'), 'input'))

  console.log(JSON.stringify({
    org, apply,
    brands: input.brands.length,
    assignments: input.assignments.length,
    skipped: input.skipped ?? 0,
    sample: input.assignments.slice(0, 5),
  }, null, 2))
  if (!apply) {
    console.log('dry-run：加 --apply 才写库')
    return
  }

  const client = await pool.connect()
  try {
    await client.query('begin')
    for (const b of input.brands) {
      await client.query(
        `insert into data.brand_registry(org, code, name, sort, enabled, source)
         values ($1,$2,$3,$4,true,$5)
         on conflict (org, code) do update
           set name = excluded.name, sort = excluded.sort, source = excluded.source, updated_at = now()`,
        [org, b.code, b.name, b.sort, b.source],
      )
    }
    let written = 0
    let lockedSkipped = 0
    for (const a of input.assignments) {
      const res = await client.query(
        `insert into data.brand_assignment as ba(org, subject_type, subject_code, brand_code, source, locked)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (org, subject_type, subject_code) do update
           set brand_code = excluded.brand_code, source = excluded.source,
               locked = excluded.locked, updated_at = now()
           where not ba.locked or excluded.locked`,
        [org, a.subjectType, a.subjectCode, a.brandCode, a.source, a.locked],
      )
      if (res.rowCount === 0) lockedSkipped++
      else written++
    }
    await client.query(
      `insert into data.brand_audit(org, actor, action, detail)
       values ($1,$2,'assignment.import',$3::jsonb)`,
      [org, actor, JSON.stringify({
        brands: input.brands.length, assignments: input.assignments.length,
        skipped: input.skipped ?? 0, written, lockedSkipped,
        mode: has('from-wuji') ? 'wuji' : 'input',
      })],
    )
    await client.query('commit')
    console.log(`OK：brands=${input.brands.length} assignments_written=${written} locked_skipped=${lockedSkipped}`)
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((e) => {
  console.error(e)
  pool.end().catch(() => {})
  process.exit(1)
})
