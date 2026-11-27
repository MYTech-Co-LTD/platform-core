#!/usr/bin/env node
// @ts-nocheck —— CLI 薄壳：SQL/IO 编排，pg 经 root 解析、checkJs 推不出类型；逻辑用 dry-run/本地库实测兜底
// backfill-ticket-level.mjs — 历史工单门店等级快照回填（#2924）。
//
// 用法（默认 dry-run）：
//   node scripts/backfill-ticket-level.mjs --org shanhaiyiguo-org [--limit 5000] [--apply]
//
// 纪律：
//   · **只填空值**（store_level_code=''），绝不覆盖已有快照——重跑安全、幂等；
//   · 等级只来自 `data.v_store_profile`（没有商品级等级），且只取启用中的等级；
//   · 回填是**近似**：门店后来改过等级时，历史工单会按当前等级归类；
//     store_level_source='backfill' 单独标出，运营能区分「提单时解析」与「事后补的」。
//   · 每批一个事务，最终写一条 data.store_profile_audit（profile.backfill）。
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

const SELECT_SQL = `
  select t.id, sp.level_code, lr.name as level_name, sp.level_source
    from aftersales.ticket t
    join data.v_store_profile sp
      on sp.org = t.org and sp.store_code = t.store_code
    join data.v_store_level_registry lr
      on lr.org = sp.org and lr.code = sp.level_code and lr.enabled
   where t.org = $1 and t.store_level_code = ''
   order by t.id
   limit $2`

async function main() {
  const client = await pool.connect()
  try {
    const sample = await client.query(SELECT_SQL, [org, Math.min(limit, 10)])
    const totalRes = await client.query(
      `select count(*)::int as n
         from aftersales.ticket t
         join data.v_store_profile sp
           on sp.org = t.org and sp.store_code = t.store_code
         join data.v_store_level_registry lr
           on lr.org = sp.org and lr.code = sp.level_code and lr.enabled
        where t.org = $1 and t.store_level_code = ''`,
      [org],
    )
    const total = totalRes.rows[0]?.n ?? 0
    console.log(JSON.stringify({
      org, apply, candidates: total, limit,
      sample: sample.rows,
    }, null, 2))
    if (!apply) {
      console.log('dry-run：加 --apply 才写库')
      return
    }

    let done = 0
    while (done < limit) {
      const res = await client.query(SELECT_SQL, [org, Math.min(batch, limit - done)])
      const rows = res.rows
      if (rows.length === 0) break
      await client.query('begin')
      try {
        for (const r of rows) {
          // 再带 store_level_code='' 谓词：并发提单/重跑都不会覆盖已有快照。
          await client.query(
            `update aftersales.ticket
                set store_level_code = $3, store_level_name = $4, store_level_source = 'backfill'
              where org = $1 and id = $2 and store_level_code = ''`,
            [org, r.id, r.level_code, r.level_name ?? ''],
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
      `insert into data.store_profile_audit(org, actor, action, detail)
       values ($1,$2,'profile.backfill',$3::jsonb)`,
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
