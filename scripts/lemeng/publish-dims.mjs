// publish-dims.mjs — 把数据面 warehouse 的 staging 维表**发布**成平台 PG 的 `data.dim_*`
// 快照（ADR 2026-10-07 跨模块数据消费契约，形状②；issue #476）。
//
// 为什么是这个形状（裁决记录，别回退）：
//   业务模块（售后）消费维表走「owner 发布的带版本快照」，**不走**直连 warehouse、
//   **不走**跨模块实时 API（判定三问：售后营业关键流容得下 T+1 维表，容不下实时依赖
//   问数链可用性；46 万商品搜索查本地发布表远优于跨模块分页；零新机制——不需要模块服务身份）。
//   消费方对发布表**只读**（lint B1 白名单 `data.dim_` 只开 from/join）。
//
// 事实源与流向：
//   `DATA_WAREHOUSE_URL`（pg_duckdb staging，stg_lemeng_branch / stg_lemeng_item）
//     → 裁剪（列集 = data 模块定的发布契约，见 008_dim_snapshots.sql；**不整份搬运**
//       stg_lemeng_item 的 190+ 列）
//     → `DATABASE_URL`（平台 PG data.dim_branch / data.dim_item，事务内整批替换）。
//
// 幂等（job 每天重跑）：每张表按 (org, system_book) **delete 后整批 insert 当前 snapshot**——
//   重跑同一份 staging ⇒ 行集不变（验收判据：行数不变，不是「没报错」）。
// 版本语义：`snapshot` = staging 里该 (org, system_book) 的最新业务日；发布后消费方读到的
//   永远是「某一版」，新鲜度由探活断言盯（staging 有而 dim 停更 ⇒ 红）。
//
// 跑法（与 sync-data-semantics 同形态——平台 server 容器里，两个连接都在手）：
//   docker exec -w /app openship-platform-core-shanhai-server node_modules/.bin/tsx \
//     scripts/lemeng/publish-dims.mjs
import { createRequire } from 'node:module'

const SCRIPT_NAME = 'publish-dims'

/** @param {string} varName */
function requireEnv(varName) {
  const v = process.env[varName]
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`缺少必填环境变量 ${varName}（读 staging 与写发布表各需一个连接）`)
  }
  return v
}

async function main() {
  // 两个连接分属两库：pg 客户端从 modules/data 解析（scripts/ 不自带 pg 依赖，同 sync 脚本）
  const requireFromModule = createRequire(new URL('../../modules/data/package.json', import.meta.url))
  const { Client } = requireFromModule('pg')

  const warehouse = new Client({ connectionString: requireEnv('DATA_WAREHOUSE_URL') })
  const platform = new Client({ connectionString: requireEnv('DATABASE_URL') })
  await warehouse.connect()
  await platform.connect()

  try {
    // 每个 (org, system_book) 只发布其**最新 snapshot** 的行集（staging 按日累积多版快照）
    const scopes = await warehouse.query(
      `select org, system_book, max(snapshot)::text as snapshot
         from staging.stg_lemeng_branch
        group by org, system_book
        union
       select org, system_book, max(snapshot)::text
         from staging.stg_lemeng_item
        group by org, system_book`,
    )
    const seen = new Map()
    for (const s of scopes.rows) seen.set(`${s.org}\u0000${s.system_book}`, s.snapshot)
    if (seen.size === 0) {
      // staging 全空 = 上游没物化过 ⇒ 发布 0 行是**如实结果**，但要让 job 响亮可见（探活⑤
      // 会红词表、④红新鲜度）——这里只打印不报错，退出码 0
      console.log(`${SCRIPT_NAME}: staging 无维表行，发布 0 行（上游未物化？看探活 ④⑤）`)
      return
    }

    let totalBranch = 0
    let totalItem = 0
    for (const [key, snapshot] of seen) {
      const [org, systemBook] = key.split('\u0000')

      // ── dim_branch：事务内整批替换（delete + insert 当前 snapshot）──
      const branches = await warehouse.query(
        `select code, name, enable, address, phone, region_id, province, city, district
           from staging.stg_lemeng_branch
          where org = $1 and system_book = $2 and snapshot = $3::date`,
        [org, systemBook, snapshot],
      )
      await platform.query('begin')
      try {
        await platform.query('delete from data.dim_branch where org = $1 and system_book = $2', [org, systemBook])
        for (const b of branches.rows) {
          await platform.query(
            `insert into data.dim_branch (org, system_book, code, name, enable, address, phone, region_id, province, city, district, snapshot)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::date)`,
            [org, systemBook, String(b.code), b.name, b.enable, b.address, b.phone, b.region_id, b.province, b.city, b.district, snapshot],
          )
        }
        await platform.query('commit')
      } catch (err) {
        await platform.query('rollback')
        throw err
      }
      totalBranch += branches.rows.length

      // ── dim_item：同款整批替换（46 万行，逐行 insert 太慢 ⇒ 用 unnest 批量绑定）──
      const items = await warehouse.query(
        `select item_code, bar_code, item_name as name, spec, unit_name,
                item_sale_cease_flag as sale_cease, eliminate_flag as eliminate
           from staging.stg_lemeng_item
          where org = $1 and system_book = $2 and snapshot = $3::date`,
        [org, systemBook, snapshot],
      )
      await platform.query('begin')
      try {
        await platform.query('delete from data.dim_item where org = $1 and system_book = $2', [org, systemBook])
        /** @type {{ item_code: string, bar_code: string | null, name: string, spec: string | null, unit_name: string | null, sale_cease: boolean | null, eliminate: boolean | null }[]} */
      const rows = items.rows
      for (let i = 0; i < rows.length; i += 5000) {
          const chunk = rows.slice(i, i + 5000)
          await platform.query(
            `insert into data.dim_item (org, system_book, item_code, bar_code, name, spec, unit_name, sale_cease, eliminate, snapshot)
             select $1, $2, t.item_code, t.bar_code, t.name, t.spec, t.unit_name, t.sale_cease, t.eliminate, $3::date
               from unnest($4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::boolean[], $10::boolean[]) as
                    t(item_code, bar_code, name, spec, unit_name, sale_cease, eliminate)`,
            [
              org, systemBook, snapshot,
              chunk.map((r) => String(r.item_code)),
              chunk.map((r) => (r.bar_code === null ? null : String(r.bar_code))),
              chunk.map((r) => r.name),
              chunk.map((r) => r.spec),
              chunk.map((r) => r.unit_name),
              chunk.map((r) => r.sale_cease),
              chunk.map((r) => r.eliminate),
            ],
          )
        }
        await platform.query('commit')
      } catch (err) {
        await platform.query('rollback')
        throw err
      }
      totalItem += items.rows.length

      console.log(`${SCRIPT_NAME}: ${org}/${systemBook} snapshot=${snapshot} —— dim_branch ${branches.rows.length} 行 / dim_item ${items.rows.length} 行`)
    }

    // 回读验收面（不拿「没抛错」当成功）
    const check = await platform.query(
      `select (select count(*)::int from data.dim_branch) as branch, (select count(*)::int from data.dim_item) as item`,
    )
    console.log(
      `${SCRIPT_NAME}: 发布完成 —— 合计 branch ${totalBranch} / item ${totalItem}；`
        + `回读 dim_branch ${check.rows[0].branch} / dim_item ${check.rows[0].item}`,
    )
  } finally {
    await warehouse.end()
    await platform.end()
  }
}

main().catch((/** @type {unknown} */ e) => {
  console.error(`${SCRIPT_NAME}: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
