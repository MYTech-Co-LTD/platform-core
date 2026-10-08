import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { ManifestSchema } from '@platform/sdk'
import mod from './index'
import { applyMigrations, rawMigrationSqls } from './test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

describe('manifest（不需要数据库）', () => {
  it('manifest.yaml 过 schema，id / 权限码 / 迁移目录自洽', () => {
    const raw = parseYaml(readFileSync(new URL('./manifest.yaml', import.meta.url), 'utf8'))
    const m = ManifestSchema.parse(raw)
    expect(m.id).toBe('data')
    expect(m.permissions.map((p) => p.code).sort()).toEqual(['data:manage', 'data:query'])
    expect(m.migrations?.dir).toBe('./migrations')
    // 本模块【不】声明 storage：问数不碰租户级对象存储（数据仓库连接是部署级，见 T3）
    expect(m.storage).toBeUndefined()
  })

  it('api.internal 的声明集合与 createRouter 注册的路由集合逐条一致（装载期双向核对的本地版）', () => {
    const declared = new Set((mod.manifest.api?.internal ?? []).map((e) => `${e.method} ${e.path}`))
    const registered = new Set(
      mod
        .createRouter({ pool: null as never })
        .routes.filter((r) => r.method !== 'ALL')
        .map((r) => `${r.method} ${r.path}`),
    )
    expect([...registered].sort()).toEqual([...declared].sort())
  })
})

describePg('迁移（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })

  afterAll(async () => {
    // 池在本 afterAll 之前就被 end 了 ⇒ 说明有别的钩子提前收摊，本文件后续断言会假红。
    expect(pool.ended, '池在本 afterAll 之前已被 end——有别的钩子提前收摊').toBe(false)
    await pool.end().catch(() => {})
  })

  it('applyMigrations 幂等：连跑两次，第二次不新应用任何版本', async () => {
    await applyMigrations(pool)
    const second = await applyMigrations(pool)
    expect(second).toEqual([])
  })

  it('迁移 SQL 本身幂等：不记账、直接连跑两遍不报错（部署脚本会全量重跑）', async () => {
    const sqls = await rawMigrationSqls()
    expect(sqls.length).toBeGreaterThan(0)
    for (const sql of sqls) {
      await pool.query(sql)
      await pool.query(sql)
    }
  })

  it('十张表建成（001 三张 + 002 报表登记 + 009 三张发布维 + 010 口径审计 + 011 价格批 + 012 调出单 + 013 批发单），且 data.query_keys.token_hash 唯一', async () => {
    await applyMigrations(pool)
    const t = await pool.query(
      `select table_name from information_schema.tables
        where table_schema = 'data' order by table_name`,
    )
    // 清单是**穷举**（不是「包含」）：新增迁移必须在这里显式表态，
    // 免得删掉一张表时这道断言还绿（002_reports 就是这么加进来的）。
    expect(t.rows.map((r) => r.table_name)).toEqual([
      'dim_branch', 'dim_item', 'dim_item_price', 'dim_transfer_out', 'dim_wholesale_out', 'metric_audit', 'metrics', 'query_audit', 'query_keys', 'reports',
    ])

    // 口径两条（都是开工实测订正，别按口味改回去）：
    //  ① `lower(indexdef) like '%unique%'`：pg_indexes.indexdef 里是 **大写** `CREATE UNIQUE INDEX`
    //     ——原稿写小写 `like '%unique%'` 恒不命中（大小写敏感），该断言**永远绿不了**（RED 实测）。
    //  ② 只断言「有唯一索引」不够：query_keys 的主键索引同样唯一 ⇒ 拿掉 token_hash 的 unique
    //     也照样过（断言与用例名「token_hash 唯一」不符）。故直接断言唯一索引覆盖 token_hash。
    const u = await pool.query(
      `select indexdef from pg_indexes
        where schemaname = 'data' and tablename = 'query_keys' and lower(indexdef) like '%unique%'`,
    )
    expect(u.rows.map((r) => r.indexdef).some((d) => /[(]token_hash[)]/.test(d))).toBe(true)
  })

  it('009：发布维表（dim_branch/dim_item）= 跨账套去重租户视图，键列/版本列/来源列在位（#476）', async () => {
    await applyMigrations(pool)
    // 判据面：两张发布表的自然键（org+code/item_code）、版本列 snapshot、来源列 source_book
    // （各 not null）与名称列。009 起**不再有 system_book**（口径①方案 C：跨账套去重收进
    // owner，账套粒度留在数据面 staging）。消费方（售后）与 lint 白名单都押在这张形状上。
    const cols = await pool.query(
      `select table_name, column_name, is_nullable from information_schema.columns
        where table_schema = 'data' and table_name in ('dim_branch', 'dim_item')
          and column_name in ('org', 'code', 'item_code', 'name', 'snapshot', 'source_book')
        order by table_name, column_name`,
    )
    const got = cols.rows.map((r) => `${r.table_name}.${r.column_name}:${r.is_nullable}`)
    // 实测：PG 对主键列的 is_nullable 报 NO（主键隐式 NOT NULL）——别按「PK 可空」猜
    expect(got).toEqual([
      'dim_branch.code:NO',
      'dim_branch.name:NO',
      'dim_branch.org:NO',
      'dim_branch.snapshot:NO',
      'dim_branch.source_book:NO',
      'dim_item.item_code:NO',
      'dim_item.name:NO',
      'dim_item.org:NO',
      'dim_item.snapshot:NO',
      'dim_item.source_book:NO',
    ])
  })

  it('004：data.reports.renderer 列存在、非空、且取值域含 metabase/platform', async () => {
    await applyMigrations(pool)
    // 判据面三条：列存在 / not null / **default 是 'metabase'**。
    // ⚠️ 上一稿在这里写着「default 不在此断言——列已存在时 add column 整句 no-op，重读 default
    //    会假红」，那个理由是**错的**（评审 Important 订正）：本列**只由本迁移建**，本文件的两条
    //    路径（applyMigrations 与裸跑迁移 SQL）都**带着 default** 建它 ⇒ 库里不可能存在「没有
    //    default 的 renderer」⇒ 这条断言在本套件里不会假红。
    //    而它挡的恰恰是**最贵的一种回归**：把 004 的字面量改成 `default 'platform'` 时，列还在、
    //    仍然 NOT NULL、约束定义里两个串也都还在 ⇒ 其余断言全绿，**只有这一条会红**。生产上那一改
    //    意味着**每一行存量被静默标成"平台自绘"**，而渲染器尚未实现 ⇒ 点开是空白，且**从库里看不
    //    出它们标错了**——迁移头注（004_report_renderer.sql）论证「绝不能发生」的正是这一条。
    const c = await pool.query(
      `select column_name, is_nullable, column_default from information_schema.columns
        where table_schema = 'data' and table_name = 'reports' and column_name = 'renderer'`,
    )
    expect(c.rows).toEqual([
      { column_name: 'renderer', is_nullable: 'NO', column_default: "'metabase'::text" },
    ])

    // 取值域由 check 约束兜（与 003 的 source 同一口径：枚举写错一个字母会走另一条渲染路径）
    const k = await pool.query(
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conname = 'data_reports_renderer_check'`,
    )
    expect(k.rowCount).toBe(1)
    expect(k.rows[0].def).toContain('metabase')
    expect(k.rows[0].def).toContain('platform')
  })
})
