#!/usr/bin/env node
// @ts-nocheck —— `pg` 经 createRequire 锚到 apps/server 解析（`scripts/` 不属于任何 workspace 包，
// 裸 `import 'pg'` 在仓库根解析不到——`provision-tenant.mjs` / `migrate-tenant-module-to-subs.mjs`
// 的实测结论）；根 tsconfig 因此解析不到 pg 的类型，不为此给仓根加依赖。
// 纯函数（collectExemptions / detectModuleSchemas / findViolations）有 vitest 兜底。
//
// 租户隔离门禁（spec-1 §2 的 CI 门禁；决定与理由见 docs/module-protocol.md「租户数据隔离」，issue #77）。
//
// 用法：DATABASE_URL=postgres://… tsx scripts/check-tenant-isolation.mjs [选项]
//   --schemas a,b       只查这几个 schema（缺省 = 自动识别模块 schema；fixture 测试用）
//   --modules-dir <p>   豁免标记的扫描根（缺省 = 仓根 modules/；fixture 测试用）
// 契约：干净 → exit 0，stdout 一行 `check-tenant-isolation: OK`；
//       有违规 → exit 1，stderr 每条一行 `<schema>.<table>: [T#] 说明`。
//
// ── 为什么是「真库对账」而不是「扫迁移文本」───────────────────────────────
// 本门禁在 CI 的烟测 job 里紧跟 `smoke-load` 之后跑：那时宿主刚把全部模块 migrations
// 应用完，`information_schema` 就是**唯一真值**。好处是**不必写 DDL 解析器**，也不会被
// 幂等写法（`if not exists`）与增量迁移骗到。
//
// 这条不是纸上推演，是**第一个真模块的案例逼出来的**：`modules/demo/001_note.sql`
// 建表时**没有** org，是 `003_note_org.sql` 才补上的。若按单个迁移文件判
// （「每个 create table 必须含 org」），**本仓自己的参考模块会被判红** —— 而 demo
// 正是每个新模块照抄的模板 ⇒ 门禁一上来就会被人关掉。故判据必须是**累积终态**。
//
// ── 规则 ────────────────────────────────────────────────────────────
//   T1 模块 schema 下的每张表必须含 `org` 列。
//   T2 该 `org` 列必须是 `not null`（正典写的是 `org text not null`）。
//   T3 豁免标记必须指向**存在**的表 —— 防标记腐烂（表改名/删表后标记还挂着，
//      下次真需要豁免时会以为「已经标过了」）。
//
// 模块 schema 的判定：全部 schema 减去 `platform`（宿主）/ `public` / `pg_*` /
// `information_schema`。三同纪律：模块 id = DB schema = API 前缀，故新模块自动被覆盖。
//
// 豁免：迁移文件里 `-- global-table: <schema>.<table> — <理由>`（细则见正典）。
// 脚本只做**平扫取表名**，不做位置关联 —— 这是「不解析 DDL」这条决定的直接后果。
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 锚到 apps/server 解析 pg（见文件头）。
const requireFromServer = createRequire(new URL('../apps/server/package.json', import.meta.url))

const SCRIPT_NAME = 'check-tenant-isolation'

/** 非模块 schema：宿主 schema / 默认 schema / 系统 schema（pg_ 前缀含 pg_temp_*、pg_toast_*） */
const NON_MODULE_SCHEMAS = new Set(['platform', 'public', 'information_schema'])
const EXEMPTION_RE = /--\s*global-table:\s*([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)/g

/**
 * 平扫 <modulesDir>/*\/migrations/*.sql 收集豁免表名。
 * **不解析 DDL**：只认 `-- global-table: <schema>.<table>` 这一行固定格式。
 * @param {string} modulesDir
 * @returns {Promise<Set<string>>} 形如 `aftersales.dict`
 */
export async function collectExemptions(modulesDir) {
  const found = new Set()
  let moduleDirs
  try {
    moduleDirs = await readdir(modulesDir, { withFileTypes: true })
  } catch {
    return found // 没有 modules/ 目录 = 没有豁免可收集
  }
  for (const d of moduleDirs) {
    if (!d.isDirectory()) continue
    const migDir = join(modulesDir, d.name, 'migrations')
    let files
    try {
      files = await readdir(migDir)
    } catch {
      continue // 该模块没有 migrations/：零负担（与 migrate.ts 同口径）
    }
    for (const f of files.filter((x) => x.endsWith('.sql')).sort()) {
      const text = await readFile(join(migDir, f), 'utf8')
      for (const m of text.matchAll(EXEMPTION_RE)) found.add(m[1])
    }
  }
  return found
}

/**
 * 自动识别模块 schema：全部 schema 减去宿主/默认/系统。
 * @param {import('pg').ClientBase} client
 * @returns {Promise<string[]>}
 */
export async function detectModuleSchemas(client) {
  const { rows } = await client.query(
    `select nspname from pg_namespace
      where nspname not like 'pg\\_%' escape '\\'
      order by nspname`,
  )
  return rows.map((r) => r.nspname).filter((s) => !NON_MODULE_SCHEMAS.has(s))
}

/**
 * 对账：返回违规列表（空数组 = 干净）。
 * @param {import('pg').ClientBase} client
 * @param {string[]} schemas
 * @param {Set<string>} exemptions
 * @returns {Promise<Array<{ key: string, rule: string, message: string }>>}
 */
export async function findViolations(client, schemas, exemptions) {
  const violations = []
  if (schemas.length === 0) return violations

  const { rows } = await client.query(
    `select c.table_schema, c.table_name,
            bool_or(c.column_name = 'org') as has_org,
            bool_or(c.column_name = 'org' and c.is_nullable = 'NO') as org_not_null
       from information_schema.columns c
      where c.table_schema = any($1::text[])
      group by c.table_schema, c.table_name
      order by c.table_schema, c.table_name`,
    [schemas],
  )

  const seen = new Set()
  for (const r of rows) {
    const key = `${r.table_schema}.${r.table_name}`
    seen.add(key)
    if (exemptions.has(key)) continue
    if (!r.has_org) {
      violations.push({
        key,
        rule: 'T1',
        message: '缺 `org` 列（租户数据表必须带；确属全局表则加 `-- global-table: ' + key + ' — <理由>`）',
      })
      continue
    }
    if (!r.org_not_null) {
      violations.push({ key, rule: 'T2', message: '`org` 列必须 `not null`（正典：org text not null）' })
    }
  }

  for (const ex of [...exemptions].sort()) {
    if (!seen.has(ex)) {
      violations.push({
        key: ex,
        rule: 'T3',
        message: '豁免标记指向不存在的表 —— 表已改名/删除，或标记写错了（防标记腐烂）',
      })
    }
  }

  return violations
}

async function main() {
  const argv = process.argv.slice(2)
  const readOpt = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const rootDir = fileURLToPath(new URL('..', import.meta.url))
  const modulesDir = readOpt('--modules-dir') ?? join(rootDir, 'modules')
  const schemasOpt = readOpt('--schemas')

  const url = process.env.DATABASE_URL
  if (!url) {
    console.error(
      `${SCRIPT_NAME}: 缺少 DATABASE_URL。\n`
        + '  本门禁是【真库对账】：需要一份已跑过 migrations 的库（CI 里紧跟 smoke-load 之后跑）。\n'
        + '  本地：DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform tsx scripts/check-tenant-isolation.mjs',
    )
    process.exit(2)
  }

  const exemptions = await collectExemptions(modulesDir)
  const { Pool } = requireFromServer('pg')
  const pool = new Pool({ connectionString: url })
  try {
    const schemas = schemasOpt
      ? schemasOpt.split(',').map((s) => s.trim()).filter(Boolean)
      : await detectModuleSchemas(pool)
    const violations = await findViolations(pool, schemas, exemptions)
    if (violations.length > 0) {
      console.error(`${SCRIPT_NAME}: ${violations.length} 处违规（查了 ${schemas.length} 个模块 schema）`)
      for (const v of violations) console.error(`  ${v.key}: [${v.rule}] ${v.message}`)
      process.exit(1)
    }
    console.log(`${SCRIPT_NAME}: OK（${schemas.length} 个模块 schema，${exemptions.size} 处全局表豁免）`)
  } finally {
    await pool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
