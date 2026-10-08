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
//   `DATA_WAREHOUSE_URL`（pg_duckdb staging，stg_lemeng_branch / stg_lemeng_item / stg_lemeng_item_price / stg_lemeng_transfer_out）
//     → 裁剪（列集 = data 模块定的发布契约，见 009/011 迁移）+ 跨账套去重
//     → `DATABASE_URL`（平台 PG data.dim_branch / data.dim_item / data.dim_item_price / data.dim_transfer_out，事务内整批替换）。
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

    // ── dim_item_price（#481 价格批）：门店×商品粒度的应用价 ──────────────────────
    // 换算 price_minor = round(regular_real_price * 100 / coalesce(nullif(spec_rate,0),1))
    //（口径单点在publish 侧，迁移 011 只存结果；spec_rate 真机验证 = #481 计划 Task 7 未验环节①）。
    // 过滤：regular_real_price 0/空行不发（源侧未单独设置，无诚实价；全量实测 1.07%）。
    // store_code 解析：branch_num → stg_lemeng_branch（branch_num 账套内唯一；join 取
    // 门店 staging 的最新快照——门店清单变更由它自愈）。
    // 去重（同 009 口径①）：两账套交集门店 distinct on 取 system_book 字典序小者（3120 优先）。
    const priceMax = await warehouse.query(
      `select coalesce(max(bizday)::text,'') as s from staging.stg_lemeng_item_price`,
    )
    const priceSnapshot = priceMax.rows[0].s
    if (priceSnapshot !== '') {
      // R1 增量模型：staging = 变更事件流 ⇒ 现价 = 每 key 取 last_edit_time 最新（口径单一来源；
      // 并列时取 bizday 新者）。之后再走 0/空价过滤与跨账套去重（口径同 009：3120 优先）。
      const prices = await warehouse.query(
        `select distinct on (p.org, b.code, p.item_code, coalesce(p.item_grade_num, 0))
                p.org,
                b.code as store_code,
                p.item_code,
                coalesce(p.item_grade_num, 0) as grade_item_num,
                round(p.regular_real_price * 100 / coalesce(nullif(p.spec_rate, 0), 1))::bigint as price_minor,
                p.regular_real_price as price_raw,
                p.system_book
           from (
             select *, row_number() over (
                    partition by system_book, branch_num, item_num, item_grade_num
                    order by last_edit_time desc, bizday desc) as rn
               from staging.stg_lemeng_item_price
           ) p
           join staging.stg_lemeng_branch b
             on b.system_book = p.system_book and b.branch_num = p.branch_num
            and b.snapshot = (select max(snapshot) from staging.stg_lemeng_branch)
          where p.rn = 1
            and p.regular_real_price is not null and p.regular_real_price > 0
          order by p.org, b.code, p.item_code, coalesce(p.item_grade_num, 0), p.system_book asc`,
      )
      await platform.query('begin')
      try {
        await platform.query('delete from data.dim_item_price')
        /** @type {{ org: string, store_code: string, item_code: string, grade_item_num: number, price_minor: string | number, price_raw: string | null, system_book: string }[]} */
        const priceRows = prices.rows
        for (let i = 0; i < priceRows.length; i += 5000) {
          const chunk = priceRows.slice(i, i + 5000)
          await platform.query(
            `insert into data.dim_item_price (org, store_code, item_code, grade_item_num, price_minor, price_raw, source_book, snapshot)
             select t.org, t.store_code, t.item_code, t.grade_item_num, t.price_minor, t.price_raw, t.source_book, $1::date
               from unnest($2::text[], $3::text[], $4::text[], $5::bigint[], $6::bigint[], $7::decimal[], $8::text[]) as
                    t(org, store_code, item_code, grade_item_num, price_minor, price_raw, source_book)`,
            [
              priceSnapshot,
              chunk.map((r) => r.org),
              chunk.map((r) => String(r.store_code)),
              chunk.map((r) => String(r.item_code)),
              chunk.map((r) => Number(r.grade_item_num)),
              chunk.map((r) => Number(r.price_minor)),
              chunk.map((r) => (r.price_raw === null ? null : Number(r.price_raw))),
              chunk.map((r) => r.system_book),
            ],
          )
        }
        await platform.query('commit')
      } catch (err) {
        await platform.query('rollback')
        throw err
      }
      console.log(`${SCRIPT_NAME}: dim_item_price snapshot=${priceSnapshot} —— ${prices.rows.length} 行（0/空价已滤、跨账套去重后）`)
    } else {
      console.log(`${SCRIPT_NAME}: staging 无价格行，dim_item_price 发布 0 行（上游未物化？看探活 ④）`)
    }

    // ── dim_transfer_out（#499/R2 配送调出单）：工单金额依据的取价面 ────────────────
    // 粒度 = 单×商品（跨批次 sum）；仅 state_code=3（已审核；金额未定不发布）；
    // price_minor = round(sum(out_money) ÷ sum(quantity) × 100)——**按单结算口径**
    //   （实测配送单实际价 27 ≠ 档案批发价 25；口径单点在此，迁移 012 只存结果）。
    // out_money=0/空（纯赠品行）不参与。
    const toRows = await warehouse.query(
      `select
         t.org,
         t.order_no,
         max(t.order_type)      as order_type,
         max(t.state_code)      as state_code,
         max(t.business_date)   as business_date,
         max(t.create_time)     as create_time,
         max(t.audit_time)      as audit_time,
         max(b.code)            as branch_code,
         max(t.branch_name)     as branch_name,
         max(t.out_branch_name) as out_branch_name,
         t.item_code,
         coalesce(t.item_grade_num, 0) as grade_item_num,
         max(t.item_name)       as item_name,
         sum(t.quantity)        as quantity,
         sum(t.out_money)       as out_money,
         min(t.bizday)          as bizday
       from staging.stg_lemeng_transfer_out t
       left join staging.stg_lemeng_branch b
         on b.system_book = t.system_book and b.branch_num = t.branch_num
        and b.snapshot = (select max(snapshot) from staging.stg_lemeng_branch)
       where t.state_code = 3 and t.out_money is not null and t.out_money > 0
       group by t.org, t.order_no, t.item_code, coalesce(t.item_grade_num, 0)
       having sum(t.quantity) > 0`,
    )
    await platform.query('begin')
    try {
      await platform.query('delete from data.dim_transfer_out')
      /** @type {{ org: string, order_no: string, order_type: string | null, state_code: number, business_date: string | null, create_time: string | null, audit_time: string | null, branch_code: string | null, branch_name: string | null, out_branch_name: string | null, item_code: string, grade_item_num: number, item_name: string | null, quantity: string | number | null, out_money: string | number | null, bizday: string }[]} */
      const toRowsAll = toRows.rows
      for (let i = 0; i < toRowsAll.length; i += 5000) {
        const chunk = toRowsAll.slice(i, i + 5000)
        await platform.query(
          `insert into data.dim_transfer_out (org, order_no, order_type, state_code, business_date, create_time, audit_time, branch_code, branch_name, out_branch_name, item_code, item_grade_num, item_name, quantity, out_money, price_minor, bizday)
           select t.org, t.order_no, t.order_type, t.state_code, t.business_date, t.create_time, t.audit_time, t.branch_code, t.branch_name, t.out_branch_name, t.item_code, t.grade_item_num, t.item_name, t.quantity, t.out_money,
                  round(t.out_money / nullif(t.quantity, 0) * 100)::bigint as price_minor,
                  t.bizday
             from unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::bigint[], $13::text[], $14::decimal(14,6)[], $15::decimal(14,2)[], $16::date[]) as
                  t(org, order_no, order_type, state_code, business_date, create_time, audit_time, branch_code, branch_name, out_branch_name, item_code, grade_item_num, item_name, quantity, out_money, bizday)`,
          [
            chunk.map((r) => r.org),
            chunk.map((r) => String(r.order_no)),
            chunk.map((r) => (r.order_type === null ? null : String(r.order_type))),
            chunk.map((r) => (r.state_code === null ? null : Number(r.state_code))),
            chunk.map((r) => (r.business_date === null ? null : String(r.business_date))),
            chunk.map((r) => (r.create_time === null ? null : String(r.create_time))),
            chunk.map((r) => (r.audit_time === null ? null : String(r.audit_time))),
            chunk.map((r) => (r.branch_code === null ? '' : String(r.branch_code))),
            chunk.map((r) => (r.branch_name === null ? null : String(r.branch_name))),
            chunk.map((r) => (r.out_branch_name === null ? null : String(r.out_branch_name))),
            chunk.map((r) => String(r.item_code)),
            chunk.map((r) => Number(r.grade_item_num)),
            chunk.map((r) => (r.item_name === null ? null : String(r.item_name))),
            chunk.map((r) => (r.quantity === null ? null : Number(r.quantity))),
            chunk.map((r) => (r.out_money === null ? null : Number(r.out_money))),
            chunk.map((r) => String(r.bizday)),
          ],
        )
      }
      await platform.query('commit')
    } catch (err) {
      await platform.query('rollback')
      throw err
    }
    console.log(`${SCRIPT_NAME}: dim_transfer_out —— ${toRows.rows.length} 行（仅审核单；price_minor=按单结算基本单位分价）`)

    // 回读验收面（不拿「没抛错」当成功）
    const check = await platform.query(
      `select (select count(*)::int from data.dim_branch) as branch,
              (select count(*)::int from data.dim_item) as item,
              (select count(*)::int from data.dim_item_price) as item_price,
              (select count(*)::int from data.dim_transfer_out) as transfer_out`,
    )
    console.log(
      `${SCRIPT_NAME}: 发布完成 —— 回读 dim_branch ${check.rows[0].branch} / dim_item ${check.rows[0].item} / dim_item_price ${check.rows[0].item_price} / dim_transfer_out ${check.rows[0].transfer_out}`,
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
