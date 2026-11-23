#!/usr/bin/env node
// check-data-dependencies.mjs — 数据依赖门禁（正典 docs/module-protocol.md「跨模块只读数据依赖」
// 门禁判据 2；数据宪法 docs/superpowers/specs/2026-11-23-platform-data-constitution.md §4/§9-2）。
//
// 用法：DATABASE_URL=postgres://… pnpm exec tsx scripts/check-data-dependencies.mjs [rootDir]
//   显式登记：… scripts/check-data-dependencies.mjs --write-lock   （更新 lock 后**同 PR 提交**）
//   rootDir 默认 = 仓库根（fixture 测试用形参，与 check-tenant-isolation / lint-architecture 同形）。
// 契约：干净 → exit 0，stdout 一行 `check-data-dependencies: OK…`（带检查面计数，防空转）；
//       有违规 → exit 1，stderr 每条一行 `发布物: [数据依赖] 说明`。
//
// ── 判据：声明集 / 库实际列集 / lock 登记三方对账（真库，累积终态） ────────────────────
// 先跑**宿主迁移**（platform.*，键与 app.ts 逐字一致）再跑全部模块迁移（一次性库，与
// check-tenant-isolation 同哲学同机械），然后对每条声明分三档：
//   ① 跨面（条目的 schema 不在本装配库里，如数据面的 staging.*）⇒ **跳过不判**——本装配
//     真库对不到它；它的列集契约归所属面的纪律（staging 归 B10 数据契约），OK 行里计数可见。
//   ② 面在、对象不在 ⇒ 红——提供方迁移本该建它/没删干净/声明拼错。
//   ③ 面在、对象在 ⇒ 列集三方对账：库实际列集 vs lock 登记（scripts/data-dependencies.lock.json）。
//     提供方对**已被任何模块声明**的发布物做列集变更（加列/删列/改型）而未显式登记 ⇒ 红。
//     **登记即变更记录**：`--write-lock` 更新 lock 并同 PR 提交，评审一眼可见「谁改了谁的契约」。
//     lock 里列集按列名排序存放，比对顺序无关，只认集合与类型。
//   另：lock 无陈条目——登记的对象已无人声明 ⇒ 红（登记是活的契约面，不是历史 archive）。
// 判据按迁移**累积终态**判、不按文件判（幂等写法与增量迁移骗不到真库）。
//
// ── 边界（都写在这里，别当成漏检） ────────────────────────────────────────────────
// · 本门禁只管判据 2（列集登记）；「声明 ↔ 代码引用一致」（判据 1）由 lint-architecture B1
//   以声明集判——两处合起来才是正典判据 1+2 的完整执法，别把哪一处单独当成全部。
// · 只对账 manifest `dataDependencies` 声明面；没有声明的模块对本门禁不可见（它们本来就不许
//   跨 schema 读——那是 B1 的地盘）。
// · 可声明物 = owner 发布物（稳定视图或带版本快照表，宪法 §4）；「声明的对象该不该是发布物」
//   本门禁判不出（库里视图与表都长列集），由评审按正典守。
// · 跨面条目的豁免是**结构性的**（schema 缺席），不是名单式的：装配里出现同名 schema 时它
//   自动进入对账面——不需要人来维护豁免清单。
// · 无任何模块声明 ⇒ OK 计数 0——门禁在线但检查面为零，计数可见，别把空绿当成坏了。
// · 一次性库**固定名**（platform_data_dependencies_check）⇒ 不可并发重入；CI 单实例、本地
//   偶发，不为它引入随机名 + 孤儿库清理（与 check-tenant-isolation 同一取舍）。
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { runMigrations } from '../apps/server/src/migrate.ts'

export const SCRIPT_NAME = 'check-data-dependencies'
/** 违规行前缀标签（与 [B1]/[租户隔离] 同形，便于 grep） */
const LABEL = '数据依赖'
/** 一次性数据库名（固定名 ⇒ 不可并发重入，见头注「边界」） */
const SCRATCH_DB = 'platform_data_dependencies_check'
/** 模块迁移目录的缺省名（与 loader.ts 的 `manifest.migrations?.dir ?? 'migrations'` 一致） */
const DEFAULT_MIGRATIONS_DIR = 'migrations'
/** 宿主迁移目录与记账键（与 app.ts 逐字一致：platform.* 归宿主迁移建） */
const HOST_MIGRATIONS_REL = 'apps/server/src/migrations'
const HOST_LEDGER_KEY = 'platform'
/** 列集登记（唯一事实源；B10 同哲学：改列集 = 改 lock 一处 + 显式 PR） */
const LOCK_REL = 'scripts/data-dependencies.lock.json'

/**
 * @typedef {{ name: string, type: string }} ColumnDef 库列定义（type = information_schema.data_type）
 * @typedef {{ module: string, id: string, migrationsDir: string, deps: string[] }} DeclaringModule
 * @typedef {{ file: string, message: string }} Violation （file = 发布物名 / lock 相对路径；无行号——判据在库不在文本）
 * 单一形状的探针结果（字段恒在，不做可辨识联合——JSDoc 字面量类型在 checkJs 下会加宽，见仓内先例）：
 * @typedef {{ schemaPresent: boolean, objectPresent: boolean, cols: ColumnDef[] }} ProbeResult
 */

/** @param {string} p */
const toPosix = (p) => p.split(path.sep).join('/')

/**
 * 收集各模块 manifest 的 dataDependencies 声明与迁移目录。manifest 缺失/YAML 挂 ⇒ 静默跳过
 * （manifest 合法性归 check-manifests，这里不重复执法）；deps 只收字符串条目（形状校验在
 * ManifestSchema superRefine）。
 * @param {string} rootDir @returns {Promise<DeclaringModule[]>}
 */
export async function collectDeclared(rootDir) {
  const modulesDir = path.join(rootDir, 'modules')
  /** @type {DeclaringModule[]} */
  const out = []
  const entries = await readdir(modulesDir, { withFileTypes: true })
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue
    /** @type {any} */
    let doc
    try {
      doc = parseYaml(await readFile(path.join(modulesDir, e.name, 'manifest.yaml'), 'utf8'))
    } catch {
      continue
    }
    if (!doc || typeof doc !== 'object') continue
    const raw = doc.dataDependencies
    const deps = Array.isArray(raw) ? raw.filter((d) => typeof d === 'string') : []
    const migrationsDirRel = typeof doc.migrations?.dir === 'string' ? doc.migrations.dir : DEFAULT_MIGRATIONS_DIR
    out.push({
      module: e.name,
      id: typeof doc.id === 'string' ? doc.id : e.name,
      migrationsDir: path.join(modulesDir, e.name, migrationsDirRel),
      deps,
    })
  }
  return out
}

/**
 * 两组列定义对账，返回差异描述（空数组 = 一致）。两侧各自按列名排序后按名字比对——
 * **顺序无关**，只认集合与类型。
 * @param {ColumnDef[]} actual 库里的实际列集
 * @param {ColumnDef[]} registered lock 登记的列集
 * @returns {string[]}
 */
export function diffColumns(actual, registered) {
  /** @param {ColumnDef[]} list @returns {Map<string, string>} */
  const byName = (list) => new Map([...list].sort((a, b) => a.name.localeCompare(b.name)).map((c) => [c.name, c.type]))
  const actualByName = byName(actual)
  const registeredByName = byName(registered)
  /** @type {string[]} */
  const out = []
  for (const [name, type] of actualByName) {
    if (!registeredByName.has(name)) out.push(`多列：+${name} ${type}`)
  }
  for (const [name, registeredType] of registeredByName) {
    const actualType = actualByName.get(name)
    if (actualType === undefined) out.push(`缺列：-${name} ${registeredType}`)
    else if (actualType !== registeredType) out.push(`改型：~${name} ${registeredType} → ${actualType}`)
  }
  return out
}

/**
 * 声明集与 lock 键集对账。missing = 声明了但 lock 未登记（未登记列集）；
 * stale = lock 有但已无人声明（陈条目）。
 * @param {string[]} declared @param {string[]} lockKeys @returns {{ missing: string[], stale: string[] }}
 */
export function diffDeclaredVsLock(declared, lockKeys) {
  const declaredSet = new Set(declared)
  const lockSet = new Set(lockKeys)
  return {
    missing: [...declaredSet].filter((k) => !lockSet.has(k)).sort(),
    stale: [...lockSet].filter((k) => !declaredSet.has(k)).sort(),
  }
}

/**
 * 归一化列定义：收窄成 {name,type} + 按列名排序（lock 落盘形状；比对用的同一形状）。
 * @param {Array<{ name: unknown, type: unknown }>} cols @returns {ColumnDef[]}
 */
export function normalizeColumns(cols) {
  return cols
    .map((c) => ({ name: String(c.name), type: String(c.type) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** 把 DATABASE_URL 指到的库换成连接串里的另一个库名（与 check-tenant-isolation 同实现） */
/** @param {string} dbUrl @param {string} dbName @returns {string} */
function withDatabaseName(dbUrl, dbName) {
  let u
  try {
    u = new URL(dbUrl)
  } catch {
    throw new Error(`DATABASE_URL 不是合法连接串：${dbUrl}`)
  }
  u.pathname = `/${dbName}`
  return u.toString()
}

/**
 * 在一次性数据库里跑宿主迁移 + 全部模块迁移 → 对每个声明条目探针。
 * **绝不碰 DATABASE_URL 指的那个库**；scratch 在本函数内 try/finally drop。
 * @param {string} dbUrl @param {string} rootDir @param {DeclaringModule[]} modules @param {string[]} declaredEntries
 * @returns {Promise<Map<string, ProbeResult>>}
 */
async function inspectDeclared(dbUrl, rootDir, modules, declaredEntries) {
  // scripts/ 不属于任何 workspace 包，裸 import 'pg' 解析不到 ⇒ 锚到 apps/server 解析
  // （与 check-tenant-isolation 同坑同修）
  const requireFromServer = createRequire(new URL('../apps/server/package.json', import.meta.url))
  const { Pool } = requireFromServer('pg')

  const admin = new Pool({ connectionString: dbUrl })
  try {
    try {
      await admin.query(`drop database if exists ${SCRATCH_DB}`)
      await admin.query(`create database ${SCRATCH_DB}`)
    } catch (err) {
      throw new Error(
        `无法在 DATABASE_URL 指向的 PG 上创建一次性库 ${SCRATCH_DB}（本门禁只在一次性库里跑 DDL，绝不碰你的库）：${/** @type {Error} */ (err).message}\n`
        + '  · CI / 本地 compose 的 POSTGRES_USER=platform 是超级用户，天然有 CREATEDB；\n'
        + '  · 托管/受管 PG 一般不给 CREATEDB——那就别把它指向这里（本门禁要真库，给一个能建库的测试实例）。',
      )
    }

    const pool = new Pool({ connectionString: withDatabaseName(dbUrl, SCRATCH_DB) })
    /** @type {Map<string, ProbeResult>} */
    let probed
    try {
      // 与生产同一执行器、同一记账键，跑法与生产逐字一致（app.ts 同序：先宿主后模块）——
      // 全部模块都跑（不只声明方）：提供方的对象长在提供方的迁移里
      await runMigrations(pool, HOST_LEDGER_KEY, path.join(rootDir, HOST_MIGRATIONS_REL), { onMissingDir: 'error' })
      for (const mod of modules) {
        await runMigrations(pool, mod.id, mod.migrationsDir)
      }
      // schema 在不在 = 探针的跨面判据（结构性豁免，见头注「边界」）
      const { rows: schemaRows } = await pool.query(`select schema_name from information_schema.schemata`)
      const schemas = new Set(schemaRows.map((/** @type {{ schema_name: unknown }} */ r) => String(r.schema_name)))
      probed = new Map()
      for (const entry of declaredEntries) {
        const dot = entry.indexOf('.')
        const schema = entry.slice(0, dot)
        const table = entry.slice(dot + 1)
        const schemaPresent = schemas.has(schema)
        /** @type {ColumnDef[]} */
        let cols = []
        if (schemaPresent) {
          const { rows } = await pool.query(
            `select column_name as name, data_type as type
               from information_schema.columns
              where table_schema = $1 and table_name = $2
              order by ordinal_position`,
            [schema, table],
          )
          cols = normalizeColumns(/** @type {Array<{ name: unknown, type: unknown }>} */ (rows))
        }
        probed.set(entry, { schemaPresent, objectPresent: cols.length > 0, cols })
      }
    } finally {
      await pool.end()
    }
    return probed
  } finally {
    await admin.query(`drop database if exists ${SCRATCH_DB}`).catch(() => {})
    await admin.end()
  }
}

/**
 * @param {{ rootDir: string, dbUrl?: string, writeLock?: boolean }} args
 * @returns {Promise<{ violations: Violation[], counts: { modules: number, declared: number, lockEntries: number, dbChecked: number, crossPlaneSkipped: number } }>}
 */
export async function checkDataDependencies({ rootDir, dbUrl, writeLock = false }) {
  const modules = await collectDeclared(rootDir)
  /** @type {string[]} */
  const declaredEntries = []
  /** @type {Map<string, string[]>} */
  const declarersOf = new Map()
  for (const m of modules) {
    for (const d of m.deps) {
      if (!declarersOf.has(d)) {
        declarersOf.set(d, [])
        declaredEntries.push(d)
      }
      declarersOf.get(d)?.push(m.module)
    }
  }
  declaredEntries.sort()

  const lockPath = path.join(rootDir, LOCK_REL)
  /** @type {Record<string, ColumnDef[]>} */
  let lock = {}
  try {
    lock = JSON.parse(await readFile(lockPath, 'utf8'))
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code
    if (code !== 'ENOENT') throw new Error(`lock 文件读不了（${LOCK_REL}）：${/** @type {Error} */ (err).message}`)
  }
  const lockKeys = Object.keys(lock).sort()

  /** @type {Violation[]} */
  const violations = []

  const needsDb = declaredEntries.length > 0 || lockKeys.length > 0
  /** @type {Map<string, ProbeResult>} */
  const probed = new Map()
  let dbChecked = 0
  let crossPlaneSkipped = 0
  if (needsDb) {
    if (!dbUrl) {
      throw new Error(`${SCRIPT_NAME} 要真库（判据的「库实际列集」只来自 information_schema）：设 DATABASE_URL 后重跑。CI 的 gates job 已挂 postgres service；本地用 compose pg。`)
    }
    const inspected = await inspectDeclared(dbUrl, rootDir, modules, declaredEntries)
    for (const [entry, probe] of inspected) probed.set(entry, probe)

    // 跨面条目：结构性豁免——对账面只含「schema 在本装配」的条目
    /** @type {string[]} */
    const verifiable = []
    for (const entry of declaredEntries) {
      const probe = probed.get(entry)
      if (probe?.schemaPresent) verifiable.push(entry)
      else crossPlaneSkipped++
    }

    // ③ 陈条目：登记是活的契约面，不是 archive（只对可对账条目要求——跨面条目的登记
    // 本就不该出现在 lock 里，见 --write-lock 只写 verifiable）
    const { missing, stale } = diffDeclaredVsLock(verifiable, lockKeys)
    for (const k of stale) {
      violations.push({
        file: LOCK_REL,
        message: `lock 有陈条目 "${k}"——已无任何模块声明它。登记跟着声明走：要么删掉这条，要么它本该出现在某个 manifest 里`,
      })
    }
    // ② 前置：声明了但 lock 未登记（列集无从比对，先报登记缺失）
    for (const k of missing) {
      violations.push({
        file: `${declarersOf.get(k)?.[0] ?? '?'}/manifest.yaml`,
        message: `"${k}" 已声明但 lock 未登记列集——显式登记：跑 --write-lock 并把 ${LOCK_REL} 同 PR 提交`,
      })
    }

    // ①/②③ 逐条对账
    for (const entry of verifiable) {
      const probe = probed.get(entry)
      if (!probe?.objectPresent) {
        violations.push({
          file: entry,
          message: `声明的对象在库不存在（宿主 + 全部模块迁移跑完后查 information_schema 无此列集）——检查提供方迁移是否建了它、或声明拼写`,
        })
        continue
      }
      dbChecked++
      const registered = lock[entry]
      if (!Array.isArray(registered)) continue // missing 已在前面报过，这里不重复
      for (const d of diffColumns(probe.cols, registered)) {
        violations.push({
          file: entry,
          message: `列集漂移：${d}——提供方改了已声明发布物；显式登记：--write-lock 更新 ${LOCK_REL} 并同 PR 提交`,
        })
      }
    }
  }

  if (writeLock) {
    if (!dbUrl) throw new Error(`--write-lock 要真库（登记的是库的实际列集）：设 DATABASE_URL 后重跑。`)
    /** @type {Record<string, ColumnDef[]>} */
    const next = {}
    for (const entry of declaredEntries) {
      const probe = probed.get(entry)
      // 只登记本装配对得到账的条目（跨面条目归所属面纪律：staging 归 B10）
      if (probe?.schemaPresent && probe.objectPresent) next[entry] = probe.cols
    }
    const body = JSON.stringify(next, null, 2) + '\n'
    await writeFile(lockPath, body, 'utf8')
  }

  return {
    violations,
    counts: { modules: modules.length, declared: declaredEntries.length, lockEntries: lockKeys.length, dbChecked, crossPlaneSkipped },
  }
}

async function main() {
  const args = process.argv.slice(2)
  const writeLock = args.includes('--write-lock')
  const rootDir = args.find((a) => !a.startsWith('--')) ?? fileURLToPath(new URL('..', import.meta.url))
  const { violations, counts } = await checkDataDependencies({ rootDir, dbUrl: process.env.DATABASE_URL, writeLock })
  if (writeLock) {
    console.log(`${SCRIPT_NAME}: ${LOCK_REL} 已按库实际列集重写——**同 PR 提交**，这就是列集变更的显式登记`)
  }
  if (violations.length > 0) {
    console.error(`${SCRIPT_NAME}: ${violations.length} 处违规`)
    for (const v of violations) {
      console.error(`  ${v.file}: [${LABEL}] ${v.message}`)
    }
    process.exit(1)
  }
  // OK 行必须带计数：门禁「检查面为 0」也是绿的，那种绿要靠人看得见（fetch-depth 教训同源）。
  // 跨面跳过数印在 OK 行里，不静默（跨面声明的列集契约归所属面纪律，如 staging 归 B10）。
  console.log(
    `${SCRIPT_NAME}: OK（模块 ${counts.modules} / 声明 ${counts.declared} / 登记 ${counts.lockEntries}`
    + ` / 真库对账 ${counts.dbChecked} / 跨面跳过 ${counts.crossPlaneSkipped}）`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((err) => {
    console.error(`${SCRIPT_NAME}: ${/** @type {Error} */ (err).message}`)
    process.exit(1)
  })
}
