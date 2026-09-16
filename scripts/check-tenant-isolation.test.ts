// scripts/check-tenant-isolation.test.ts — 租户隔离门禁（issue #77）的 fixture 测试。
//
// 三层，各自钉住不同的东西：
//   ① 纯核（不连库）：SQL 注释掩码 + 豁免标记契约 —— 标记挂空 / 空理由 / 建表写错 schema
//      都在这里钉死，不依赖任何环境。
//   ② 真库对账（需要 DATABASE_URL，与 apps/server 的测试同一约定：没有就整体跳过）：
//      在临时 fixture 仓里**真跑迁移、真查 information_schema**。这层刻意不做 mock ——
//      本门禁的全部价值就是「拿真库当真值」，给它配个假库等于把要测的东西换成替身
//      （AGENTS.md 第 11 条：#50/#51 的教训是替身比真机宽松时缺陷结构性不可见）。
//      脚本内部用固定名的一次性库（drop/create 自己那个），故本文件的 DB 用例**不能并发**；
//      vitest 同文件内默认串行，够用。
//   ③ CLI 契约：spawn 真实入口，钉住 exit code 与 OK 行（其余四个守卫脚本的对外契约就是这两样）。
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { checkTenantIsolation, maskSql, parseCreateTableLine, parseModuleSql } from './check-tenant-isolation.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const scriptsDir = join(repoRoot, 'scripts')
const dbUrl = process.env.DATABASE_URL
/** 没有 DATABASE_URL 就整体跳过 DB 层（同 apps/server 的 describePg 约定） */
const describePg = dbUrl ? describe : describe.skip

const tmpRoots: string[] = []

/** 建一个临时 fixture 根目录（files: 相对路径 → 内容），afterAll 统一删除 */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'platform-tenant-isolation-'))
  tmpRoots.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

afterAll(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true })
})

/** 造一个 fixture 模块的文件表（manifest + migrations/*.sql） */
function moduleFiles(
  dirName: string,
  sql: Record<string, string>,
  opts: { id?: string; manifest?: string | false } = {},
): Record<string, string> {
  const files: Record<string, string> = {}
  for (const [name, text] of Object.entries(sql)) files[`modules/${dirName}/migrations/${name}`] = text
  if (opts.manifest !== false) files[`modules/${dirName}/manifest.yaml`] = opts.manifest ?? `id: ${opts.id ?? dirName}\n`
  return files
}

/** 单个 SQL 文本 → parseModuleSql 的入参 */
function asModule(sql: string, id = 'fx') {
  return {
    id,
    dirRel: `modules/${id}`,
    migrationsDir: '',
    migrationsDirRel: `modules/${id}/migrations`,
    files: [{ rel: `modules/${id}/migrations/001_init.sql`, text: sql }],
  }
}

/** CLI 入口（tsx 运行时：本脚本 import 仓内 TS 源，裸 node 解析不了，见脚本头注实现判断②） */
function runCli(args: string[], env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', join(scriptsDir, 'check-tenant-isolation.mjs'), ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    if (typeof err.status !== 'number') throw e
    return { status: err.status, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

describe('纯核：SQL 掩码与豁免标记契约（不连库）', () => {
  it('掩码等长（行号不变），代码视角认不出注释/字符串里的 create table，标记视角保留行注释原文', () => {
    const src = [
      "-- 散文里提到 create table fx.a 不算数",
      "select 'create table fx.b'",
      '/* create table fx.c */',
    ].join('\n')
    const code = maskSql(src, false)
    expect(code.length).toBe(src.length)
    expect(code.split('\n').length).toBe(src.split('\n').length)
    expect(/create table/i.test(code), '代码视角不该看见任何建表语句').toBe(false)
    // 标记视角：行注释原文在，字符串与块注释仍被掩掉（标记不会从字符串/块注释里长出来）
    const marker = maskSql(src, true)
    expect(marker).toContain('-- 散文里提到 create table fx.a 不算数')
    expect(/fx\.b|fx\.c/.test(marker), '字符串与块注释里的内容不该漏出来').toBe(false)
  })

  it('豁免标记紧贴本模块建表 ⇒ 记进 markers（含理由与行号），createHints 计数', () => {
    const parsed = parseModuleSql(asModule([
      '-- 注释行可以插在中间',
      '',
      '-- global-table: 省份字典，全租户共用',
      'create table if not exists fx.province (id serial primary key);',
    ].join('\n')))
    expect(parsed.violations).toEqual([])
    expect(parsed.markers.get('province')).toMatchObject({ reason: '省份字典，全租户共用', line: 3 })
    expect(parsed.creates.get('province')).toMatchObject({ line: 4 })
    expect(parsed.createHints).toBe(1)
  })

  it('豁免标记挂空（其后第一条语句不是建表）⇒ 违规，且指到标记那一行', () => {
    const parsed = parseModuleSql(asModule([
      '-- global-table: 我先写着，回头补',
      'create index if not exists fx_org_idx on fx.note(org);',
    ].join('\n')))
    expect(parsed.violations).toHaveLength(1)
    expect(parsed.violations[0]).toMatchObject({ file: 'modules/fx/migrations/001_init.sql', line: 1 })
    expect(parsed.violations[0]?.message).toContain('没挂到本模块的 create table 上')
    expect(parsed.markers.size).toBe(0)
  })

  it('豁免标记没写理由 ⇒ 违规（空理由 = 豁免变成默认勾选）', () => {
    const parsed = parseModuleSql(asModule([
      '-- global-table:   ',
      'create table if not exists fx.dict (id serial primary key);',
    ].join('\n')))
    expect(parsed.violations).toHaveLength(1)
    expect(parsed.violations[0]?.message).toContain('没写理由')
    expect(parsed.markers.size, '空理由不产生豁免').toBe(0)
  })

  it('认不出的建表写法归类为 unrecognized，不得被正则回溯误报（开发期真踩过）', () => {
    // `(?:if not exists)?` 可选 ⇒ 正则遇到带引号的目标会回溯，把 `if` 当成首个标识符，
    // 报出「未限定 schema：写成 `if`」这种与事实相反的违规。故这里逐段取词并单独钉住。
    // 形状是「字段恒在、空串代替 null」（见脚本里的 CreateTableLine typedef）。
    expect(parseCreateTableLine('create table if not exists "fx"."note" (id serial);'))
      .toMatchObject({ kind: 'unrecognized', target: '"fx"."note"' })
    expect(parseCreateTableLine('create table if not exists fx.note (id serial);'))
      .toMatchObject({ kind: 'table', schema: 'fx', table: 'note' })
    expect(parseCreateTableLine('create table loose (id serial);'))
      .toMatchObject({ kind: 'table', schema: '', table: 'loose' })
    expect(parseCreateTableLine('create index if not exists fx_org_idx on fx.note(org);'))
      .toEqual({ kind: 'none', schema: '', table: '', target: '' })
  })

  it('建表写到别的 schema / 不限定 schema ⇒ 违规（门禁只查本模块 schema，建到别处 = 看不见）', () => {
    const parsed = parseModuleSql(asModule([
      'create table if not exists other_schema.thing (id serial primary key);',
      'create table loose (id serial primary key);',
    ].join('\n')))
    expect(parsed.violations).toHaveLength(2)
    expect(parsed.violations[0]?.message).toContain('"other_schema.thing"')
    expect(parsed.violations[1]?.message).toContain('未限定 schema')
    expect(parsed.creates.size, '两张表都不计入本模块的建表账').toBe(0)
  })
})

describePg('真库对账（真跑迁移 + 真查 information_schema）', () => {
  it('建表无 org ⇒ 红，且报出表名与建表语句所在位置', async () => {
    const root = fixture(moduleFiles('fx', { '001_init.sql': 'create schema if not exists fx;\ncreate table if not exists fx.note (id serial primary key, body text not null);\n' }))
    const result = await checkTenantIsolation({ rootDir: root, dbUrl })
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]).toMatchObject({ file: 'modules/fx/migrations/001_init.sql', line: 2 })
    expect(result.violations[0]?.message).toContain('"fx.note"')
  })

  it('★ 累积终态：001 建表无 org、002 后补 org ⇒ 绿（demo 那个反例的回归）', async () => {
    // 逐字复刻 modules/demo 的形状：建表在 001（无 org）、org 在 003 才补上。
    // 按文件判的正则实现会在这里误报 —— 而 demo 是每个新模块照抄的模板，
    // 「最该干净的文件被误报」就是门禁上线即被关掉的那种死法（issue #77 §三）。
    const root = fixture(moduleFiles('demo', {
      '001_note.sql': 'create schema if not exists demo;\ncreate table if not exists demo.note(id serial primary key, body text not null);\n',
      '003_note_org.sql': "alter table demo.note add column if not exists org text;\nupdate demo.note set org = '' where org is null;\nalter table demo.note alter column org set not null;\n",
    }))
    const result = await checkTenantIsolation({ rootDir: root, dbUrl })
    expect(result.violations).toEqual([])
    expect(result).toMatchObject({ checked: 1, skipped: 0, tables: 1 })
  })

  it('豁免标记 ⇒ 无 org 的表合法通过（且不豁免别的表）', async () => {
    const root = fixture(moduleFiles('fx', {
      '001_init.sql': [
        'create schema if not exists fx;',
        '-- global-table: 省份字典，全租户共用',
        'create table if not exists fx.province (id serial primary key);',
        'create table if not exists fx.note (id serial primary key, org text not null);',
      ].join('\n'),
    }))
    const result = await checkTenantIsolation({ rootDir: root, dbUrl })
    expect(result.violations).toEqual([])
    expect(result.tables).toBe(2)
  })

  it('无 migrations/ 的模块静默跳过并计数（与装载器同一约定），没有待检模块时连库都不必连', async () => {
    const root = fixture({
      'modules/empty/manifest.yaml': 'id: empty\n',
      'modules/empty/index.ts': 'export default {}\n',
    })
    const result = await checkTenantIsolation({ rootDir: root, dbUrl: undefined })
    expect(result).toEqual({ violations: [], checked: 0, skipped: 1, tables: 0 })
  })

  it('有待检模块却没有 DATABASE_URL ⇒ 响亮失败（判据只能来自真库，不静默跳过）', async () => {
    const root = fixture(moduleFiles('fx', { '001_init.sql': 'create schema if not exists fx;\ncreate table if not exists fx.note (id serial primary key);\n' }))
    await expect(checkTenantIsolation({ rootDir: root, dbUrl: undefined })).rejects.toThrow(/DATABASE_URL/)
  })

  it('认不出的写法（带引号的标识符）⇒ 表仍是真库说的，违规指到迁移目录（不伪造行号）', async () => {
    const root = fixture(moduleFiles('fx', { '001_init.sql': 'create schema if not exists fx;\ncreate table if not exists "fx"."note" (id serial primary key);\n' }))
    const result = await checkTenantIsolation({ rootDir: root, dbUrl })
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]).toMatchObject({ file: 'modules/fx/migrations', line: null })
    expect(result.violations[0]?.message).toContain('"fx.note"')
  })

  it('空转自检：迁移里有建表迹象、本模块 schema 里却一张表都没有 ⇒ 违规（不静默放过）', async () => {
    const root = fixture(moduleFiles('fx', { '001_init.sql': 'create table if not exists "public"."dict" (id serial primary key);\n' }))
    const result = await checkTenantIsolation({ rootDir: root, dbUrl })
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]).toMatchObject({ file: 'modules/fx/migrations', line: null })
    expect(result.violations[0]?.message).toContain('一张表都没有')
  })

  it('manifest 声明的迁移目录被采纳（与 loader.ts 同一条取值规则）', async () => {
    const root = fixture({
      'modules/fx/manifest.yaml': 'id: fx\nmigrations: { dir: ./sql }\n',
      'modules/fx/sql/001_init.sql': 'create schema if not exists fx;\ncreate table if not exists fx.note (id serial primary key);\n',
    })
    const result = await checkTenantIsolation({ rootDir: root, dbUrl })
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]?.file).toBe('modules/fx/sql/001_init.sql')
  })

  it('真实仓必须干净（这也是「demo 不被误报」的实证：跑的就是仓库里那个真 demo）', async () => {
    const result = await checkTenantIsolation({ rootDir: repoRoot, dbUrl })
    expect(result.violations).toEqual([])
    expect(result.checked).toBeGreaterThanOrEqual(2)
    expect(result.tables).toBeGreaterThanOrEqual(10)
  })
})

describePg('CLI 契约（spawn 真实入口）', () => {
  it('干净 ⇒ exit 0 且 OK 行带检查面计数', () => {
    const r = runCli([repoRoot])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/^check-tenant-isolation: OK（\d+ 个模块 \/ \d+ 张表全部带 org；跳过 \d+ 个无 migrations\/ 的模块）\n$/)
  })

  it('有违规 ⇒ exit 1 且逐行 `路径:行号: [租户隔离] 说明`', () => {
    const root = fixture(moduleFiles('fx', { '001_init.sql': 'create schema if not exists fx;\ncreate table if not exists fx.note (id serial primary key);\n' }))
    const r = runCli([root])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('modules/fx/migrations/001_init.sql:2: [租户隔离]')
    expect(r.stderr).toContain('"fx.note"')
  })
})
