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

  it('四张表建成（001 三张 + 002 报表登记），且 data.query_keys.token_hash 唯一', async () => {
    await applyMigrations(pool)
    const t = await pool.query(
      `select table_name from information_schema.tables
        where table_schema = 'data' order by table_name`,
    )
    // 清单是**穷举**（不是「包含」）：新增迁移必须在这里显式表态，
    // 免得删掉一张表时这道断言还绿（002_reports 就是这么加进来的）。
    expect(t.rows.map((r) => r.table_name)).toEqual(['metrics', 'query_audit', 'query_keys', 'reports'])

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
})
