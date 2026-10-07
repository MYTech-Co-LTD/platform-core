// test-util.test.ts —— 夹具脚手架的**行为契约**（不是业务测试）。
//
// 只锁一件事（#483）：`ensureDimTables` 必须**与包序无关**。CI 的包间测试顺序不保证 data 包
// 先迁移（pnpm -r 对无依赖关系的包顺序未定），而旧实现只执行 data 的 009——009 **假定 `data`
// schema 已存在**（那个 schema 由 data 包更早的迁移建立）⇒ 空库上撞
// `schema "data" does not exist`，main 的 unit 自 #480 起因此持续红。
//
// ⚠️ 判据是**变异确认**（本仓口径）：把 `ensureDimTables` 换回「只执行 009」的实现，本条必须变红。
// ⚠️ 必须用**一次性临时库**：当前库可能已被别的测试文件迁移过（那正是旧实现「看起来正常」的
//    顺序），只有「data schema 还不存在」的库里才验得出这件事。
import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { ensureDimTables } from './test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

/** `postgres://…/<db>` ⇒ `postgres://…`（去掉库名）。
 *  用字符串裁剪而不是 `new URL`：URL 会对 userinfo 做百分号编码，pg 那边解析不回来。 */
function withoutDb(url: string): string {
  return url.replace(/\/[^/]*$/, '')
}

/** 临时库名：PG 标识符只允许小写字母/数字/下划线；带时间戳 + 随机后缀以免并发或重跑撞名。 */
const SCRATCH_DB = `fx483_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`

describePg('夹具自愈的顺序无关性（#483）', () => {
  // 必须连到**另一个**库才能 create/drop database —— 既不能在事务里，也不能在被删的那个库上操作
  const base = withoutDb(dbUrl ?? '')
  const admin = new Pool({ connectionString: `${base}/postgres` })
  let scratch: Pool | undefined

  afterAll(async () => {
    await scratch?.end().catch(() => {})
    await admin.query(`drop database if exists "${SCRATCH_DB}" with (force)`).catch(() => {})
    await admin.end().catch(() => {})
  })

  it('在「data schema 还不存在」的库上：调完 ensureDimTables 即可查 data.dim_*', async () => {
    await admin.query(`create database "${SCRATCH_DB}"`)
    scratch = new Pool({ connectionString: `${base}/${SCRATCH_DB}` })

    // 前置：这个库确实还没有 data schema —— 否则本条验的就成了「已经迁移过」，等于没验
    const pre = await scratch.query<{ n: number }>(
      `select count(*)::int as n from information_schema.schemata where schema_name = 'data'`)
    expect(pre.rows[0]?.n).toBe(0)

    await ensureDimTables(scratch)

    // 两张发布维表就位（旧实现在这一步之前就抛 `schema "data" does not exist`）
    const tables = await scratch.query<{ n: number }>(
      `select count(*)::int as n from information_schema.tables
        where table_schema = 'data' and table_name in ('dim_branch','dim_item')`)
    expect(tables.rows[0]?.n).toBe(2)
    // 且"建出来了"不等于"查得动"：真解析一次（基表或列缺失会在这里以解析失败红出来）
    for (const t of ['data.dim_branch', 'data.dim_item']) {
      await expect(scratch.query(`select * from ${t} limit 0`)).resolves.toBeTruthy()
    }
  })
})
