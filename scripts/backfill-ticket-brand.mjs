#!/usr/bin/env node
// @ts-nocheck —— CLI 薄壳：SQL/IO 编排，pg 经 root 解析、checkJs 推不出类型；逻辑用 dry-run/本地库实测兜底
// backfill-ticket-brand.mjs — 历史工单品牌快照回填（#2892）。
//
// 用法（默认 dry-run）：
//   node scripts/backfill-ticket-brand.mjs --org shanhaiyiguo-org [--limit 5000] [--apply]
//
// 纪律：
//   · **只填空值**（brand_code=''），绝不覆盖已有快照——重跑安全、幂等；
//   · 解析顺序与运行时一致：product 分配 > store 分配；停用品牌（brand_enabled=false）不参与；
//   · 每批一个事务，最终写一条 data.brand_audit（assignment.backfill）；
//   · 回填是**近似**：门店/商品后来换过品牌时，历史工单会按当前映射归类。所以
//     brand_source='backfill' 单独标出，运营能区分「提单时解析」与「事后补的」。
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
const limit = Math.max(1, Math.trunc(Number(arg('limit', '5000'))) || 5000)
const batch = Math.max(1, Math.trunc(Number(arg('batch', '500'))) || 500)
const actor = arg('actor', process.env.USER ?? 'ops')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

// 解析顺序与运行时一致：product 分配 > 门店画像（store_profile）> 未分类。
// 只取启用中的品牌（停用品牌仍在字典里供历史筛选，但不参与新分类）。
const SELECT_SQL = `
  select t.id,
         p.brand_code as p_code, p.brand_name as p_name, p.source as p_source,
         case when sr.code is not null then sp.brand_code end as s_code,
         sr.name as s_name, sp.brand_source as s_source
    from aftersales.ticket t
    left join data.v_brand_assignment p
      on p.org = t.org and p.subject_type = 'product'
     and p.subject_code = t.product_code and p.brand_enabled
    left join data.v_store_profile sp
      on sp.org = t.org and sp.store_code = t.store_code
    left join data.v_brand_registry sr
      on sr.org = sp.org and sr.code = sp.brand_code and sr.enabled
   where t.org = $1 and t.brand_code = ''
     and coalesce(p.brand_code, case when sr.code is not null then sp.brand_code end) is not null
   order by t.id
   limit $2`

function rowsOf(rows) {
  return rows.map((r) => {
    const product = r.p_code !== null && r.p_code !== undefined
    return {
      id: r.id,
      code: product ? r.p_code : r.s_code,
      name: (product ? r.p_name : r.s_name) ?? '',
      source: product ? 'product' : 'store',
      origin: product ? r.p_source : r.s_source,
    }
  })
}

async function main() {
  const client = await pool.connect()
  try {
    const sample = await client.query(SELECT_SQL, [org, Math.min(limit, 10)])
    const totalRes = await client.query(
      `select count(*)::int as n
         from aftersales.ticket t
         left join data.v_brand_assignment p
           on p.org = t.org and p.subject_type = 'product'
          and p.subject_code = t.product_code and p.brand_enabled
         left join data.v_store_profile sp
           on sp.org = t.org and sp.store_code = t.store_code
         left join data.v_brand_registry sr
           on sr.org = sp.org and sr.code = sp.brand_code and sr.enabled
        where t.org = $1 and t.brand_code = ''
          and coalesce(p.brand_code, case when sr.code is not null then sp.brand_code end) is not null`,
      [org],
    )
    const total = totalRes.rows[0]?.n ?? 0
    console.log(JSON.stringify({
      org, apply, candidates: total, limit,
      sample: rowsOf(sample.rows),
    }, null, 2))
    if (!apply) {
      console.log('dry-run：加 --apply 才写库')
      return
    }

    let done = 0
    while (done < limit) {
      const res = await client.query(SELECT_SQL, [org, Math.min(batch, limit - done)])
      const rows = rowsOf(res.rows)
      if (rows.length === 0) break
      await client.query('begin')
      try {
        for (const r of rows) {
          // 再次带 brand_code='' 谓词：并发提单/重跑都不会覆盖已有快照。
          await client.query(
            `update aftersales.ticket
                set brand_code = $3, brand_name = $4, brand_source = $5, brand_origin = $6
              where org = $1 and id = $2 and brand_code = ''`,
            [org, r.id, r.code, r.name, r.source, r.origin],
          )
        }
        await client.query('commit')
      } catch (e) {
        await client.query('rollback').catch(() => {})
        throw e
      }
      done += rows.length
      console.log(`回填 ${done}/${Math.min(total, limit)}`)
    }

    await client.query(
      `insert into data.brand_audit(org, actor, action, detail)
       values ($1,$2,'assignment.backfill',$3::jsonb)`,
      [org, actor, JSON.stringify({ candidates: total, written: done, limit })],
    )
    console.log(`OK：written=${done}（候选 ${total}，上限 ${limit}）`)
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
