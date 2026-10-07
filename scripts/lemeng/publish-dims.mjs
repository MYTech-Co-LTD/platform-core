// publish-dims.mjs — 把数据面 warehouse 的 staging 维表**发布**成平台 PG 的 `data.dim_*`
// 租户视图（ADR 2026-10-07 跨模块数据消费契约，形状②；口径①人裁 2026-10-07：方案 C；
// issue #476）。
//
// 为什么是这个形状（裁决记录，别回退）：
//   业务模块（售后）消费维表走「owner 发布的带版本快照」，**不走**直连 warehouse、
//   **不走**跨模块实时 API（判定三问：售后营业关键流容得下 T+1 维表，容不下实时依赖
//   问数链可用性；46 万商品搜索查本地发布表远优于跨模块分页；零新机制——不需要模块服务身份）。
//   消费方对发布表**只读**（lint B1 白名单 `data.dim_` 只开 from/join）。
//
// ⚠️ 发布的是**跨账套去重的租户视图**（口径①方案 C）：两账套门店**不是包含关系**
//   （3120=271 / 64188=129 / 交集仅 40，2026-10-07 实测）⇒ 去重规则收在 owner 侧
//   （本脚本的 SQL `distinct on`），消费方无感。规则：
//   · 键 = org + 自然键；启用/在售标记 = 任一账套为真即真（OR）；
//   · 其余属性取「在售行」优先，同状态取 system_book 字典序小者（3120 优先，确定性）；
//   · source_book 记录该行取自哪个账套（排障用）。
//   ⚠️ branch 与 item 的 snapshot **各自独立**（两个 dim 批次节奏不同，首跑实测踩过：
//   UNION 合并 scope 会让 item 恒 0 行）——两表各自取各自的 max(snapshot)。
//
// 事实源与流向：
//   `DATA_WAREHOUSE_URL`（pg_duckdb staging，stg_lemeng_branch / stg_lemeng_item）
//     → 裁剪（列集 = data 模块定的发布契约，见 009_dim_tenant_view.sql）+ 跨账套去重
//     → `DATABASE_URL`（平台 PG data.dim_branch / data.dim_item，事务内整批替换）。
//
// 幂等（job 每天重跑）：每张表按 org **delete 后整批 insert**——重跑同一份 staging ⇒
//   行集不变（验收判据：行数不变，不是「没报错」）。
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
    // ── dim_branch：跨账套去重的租户视图 ──
    // distinct on (code)：每门店一行。排序键 = 启用行优先（enable desc），同状态取
    // system_book 字典序小者（3120 优先于 64188，确定性，别改成别的隐式顺序）。
    const branchMax = await warehouse.query(
      `select coalesce(max(snapshot)::text,'') as s from staging.stg_lemeng_branch`,
    )
    const branchSnapshot = branchMax.rows[0].s
    if (branchSnapshot !== '') {
      const branches = await warehouse.query(
        `select distinct on (org, code)
                org, code, name, enable, address, phone, region_id, province, city, district, system_book
           from staging.stg_lemeng_branch
          where snapshot = $1::date
          order by org, code, enable desc nulls last, system_book asc`,
        [branchSnapshot],
      )
      await platform.query('begin')
      try {
        await platform.query('delete from data.dim_branch')
        for (const b of branches.rows) {
          await platform.query(
            `insert into data.dim_branch (org, code, name, enable, address, phone, region_id, province, city, district, source_book, snapshot)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::date)`,
            [b.org, String(b.code), b.name, b.enable, b.address, b.phone, b.region_id, b.province, b.city, b.district, b.system_book, branchSnapshot],
          )
        }
        await platform.query('commit')
      } catch (err) {
        await platform.query('rollback')
        throw err
      }
      console.log(`${SCRIPT_NAME}: dim_branch snapshot=${branchSnapshot} —— ${branches.rows.length} 行（跨账套去重后）`)
    } else {
      console.log(`${SCRIPT_NAME}: staging 无门店维行，dim_branch 发布 0 行（上游未物化？看探活 ④）`)
    }

    // ── dim_item：同款去重（与 branch 的 snapshot 独立）；46 万行逐行 insert 太慢 ⇒
    //    unnest 批量绑定（5000 行/批）。
    const itemMax = await warehouse.query(
      `select coalesce(max(snapshot)::text,'') as s from staging.stg_lemeng_item`,
    )
    const itemSnapshot = itemMax.rows[0].s
    if (itemSnapshot !== '') {
      const items = await warehouse.query(
        `select distinct on (org, item_code)
                org, item_code, bar_code, item_name as name, spec, unit_name,
                item_sale_cease_flag as sale_cease, eliminate_flag as eliminate, system_book
           from staging.stg_lemeng_item
          where snapshot = $1::date
          order by org, item_code, eliminate asc, item_sale_cease_flag asc nulls last, system_book asc`,
        [itemSnapshot],
      )
      await platform.query('begin')
      try {
        await platform.query('delete from data.dim_item')
        /** @type {{ org: string, item_code: string, bar_code: string | null, name: string, spec: string | null, unit_name: string | null, sale_cease: boolean | null, eliminate: boolean | null, system_book: string }[]} */
        const rows = items.rows
        for (let i = 0; i < rows.length; i += 5000) {
          const chunk = rows.slice(i, i + 5000)
          await platform.query(
            `insert into data.dim_item (org, item_code, bar_code, name, spec, unit_name, sale_cease, eliminate, source_book, snapshot)
             select t.org, t.item_code, t.bar_code, t.name, t.spec, t.unit_name, t.sale_cease, t.eliminate, t.source_book, $1::date
               from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::boolean[], $9::boolean[], $10::text[]) as
                    t(org, item_code, bar_code, name, spec, unit_name, sale_cease, eliminate, source_book)`,
            [
              itemSnapshot,
              chunk.map((r) => r.org),
              chunk.map((r) => String(r.item_code)),
              chunk.map((r) => (r.bar_code === null ? null : String(r.bar_code))),
              chunk.map((r) => r.name),
              chunk.map((r) => r.spec),
              chunk.map((r) => r.unit_name),
              chunk.map((r) => r.sale_cease),
              chunk.map((r) => r.eliminate),
              chunk.map((r) => r.system_book),
            ],
          )
        }
        await platform.query('commit')
      } catch (err) {
        await platform.query('rollback')
        throw err
      }
      console.log(`${SCRIPT_NAME}: dim_item snapshot=${itemSnapshot} —— ${items.rows.length} 行（跨账套去重后）`)
    } else {
      console.log(`${SCRIPT_NAME}: staging 无商品维行，dim_item 发布 0 行（上游未物化？看探活 ④）`)
    }

    // 回读验收面（不拿「没抛错」当成功）
    const check = await platform.query(
      `select (select count(*)::int from data.dim_branch) as branch, (select count(*)::int from data.dim_item) as item`,
    )
    console.log(
      `${SCRIPT_NAME}: 发布完成 —— 回读 dim_branch ${check.rows[0].branch} / dim_item ${check.rows[0].item}`,
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
