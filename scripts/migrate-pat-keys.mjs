// scripts/migrate-pat-keys.mjs — 存量个人 Key 迁移：data.query_keys → platform.api_key（issue #894，Task 8）。
//
// **为什么是 scripts/ 而不是宿主迁移**：宿主迁移在 `apps/server/src/migrations/`，那是 B1 扫描根
// （apps/ + packages/ + modules/）——**宿主迁移不得引用 data schema**（B1 只许 platform.*），
// 而这次迁移必须读 modules/data 的表。`scripts/` 不在扫描根内（已核 lint-architecture 第 8/49 行），
// 是唯一合规落点。迁移性质读模块表，与 `backfill-identity-links.mjs` 同款边界。
//
// 幂等：`on conflict (token_hash) do nothing` —— 重跑不重复插、不改已存在的行。
// **原样搬三个时间戳**（created_at / last_used_at / revoked_at）：
//   ⇒ **已发出的 token 继续有效**（哈希不变），**已吊销的不会复活**。
//
// 用法：DATABASE_URL=… npx tsx scripts/migrate-pat-keys.mjs          # dry-run，只数不写
//      DATABASE_URL=… npx tsx scripts/migrate-pat-keys.mjs --apply  # 真写
import { createRequire } from 'node:module'

// scripts/ 不属于任何 workspace 包，裸 import 'pg' 解析不到 ⇒ 锚到 apps/server（同 backfill 脚本）
const requireFromServer = createRequire(new URL('../apps/server/package.json', import.meta.url))

async function main() {
  const apply = process.argv.includes('--apply')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('需要 DATABASE_URL')
  const { Pool } = requireFromServer('pg')
  const pool = new Pool({ connectionString: dbUrl })

  try {
    const { rows } = await pool.query(
      `select org, casdoor_user, name, token_hash, created_at, last_used_at, revoked_at
         from data.query_keys order by id`,
    )
    const before = await pool.query('select count(*)::int as n from platform.api_key')
    console.log(`源 data.query_keys: ${rows.length} 行；既有 platform.api_key: ${before.rows[0].n} 行`)

    if (!apply) {
      console.log('（dry-run：未写入。确认无误后加 --apply）')
      return
    }

    let moved = 0
    for (const r of rows) {
      const ins = await pool.query(
        `insert into platform.api_key (org, casdoor_user, name, token_hash, created_at, last_used_at, revoked_at)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (token_hash) do nothing`,
        [r.org, r.casdoor_user, r.name, r.token_hash, r.created_at, r.last_used_at, r.revoked_at],
      )
      if ((ins.rowCount ?? 0) > 0) moved++
    }
    const after = await pool.query('select count(*)::int as n from platform.api_key')
    console.log(
      `moved=${moved} skipped(已存在)=${rows.length - moved}；迁移后 platform.api_key: ${after.rows[0].n} 行`,
    )
    console.log('⚠️ 旧表 data.query_keys **不删**（expand-contract，留一个发布周期；删除时点另定）')
  } finally {
    await pool.end()
  }
}

main().catch((e) => {
  console.error('迁移失败:', e instanceof Error ? e.message : String(e))
  process.exit(1)
})
