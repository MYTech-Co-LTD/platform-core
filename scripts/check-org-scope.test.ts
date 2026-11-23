// check-org-scope（B14）fixture 单测：判据表 + 边界形态。
// 直接 import 函数（不走 CLI）：脚本 import 链含 .ts（parsers 复用 check-tenant-isolation），
// 与 gates 的 tsx 运行同源；CLI 契约（exit code / OK 行计数）由 gates 真仓跑覆盖。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkOrgScope, maskJsComments } from './check-org-scope.mjs'

const tmpRoots: string[] = []
afterAll(() => {
  for (const r of tmpRoots) rmSync(r, { recursive: true, force: true })
})

/** 建 fixture 根：modules/fx/{manifest.yaml, migrations/001.sql, <code>} */
function fixture(opts: { sql?: string, code?: string, extraModules?: Record<string, { sql?: string, code?: string }> }): string {
  const root = mkdtempSync(join(tmpdir(), 'platform-guard-orgscope-'))
  tmpRoots.push(root)
  const put = (rel: string, content: string) => {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  const mod = (id: string, sql: string, code: string) => {
    put(`modules/${id}/manifest.yaml`, `id: ${id}\nname: ${id}\nversion: 0.1.0\nplatform: '>=0.1'\npermissions: [{ code: '${id}:manage', name: m }]\n`)
    put(`modules/${id}/migrations/001_init.sql`, sql)
    if (code !== '') put(`modules/${id}/index.ts`, code)
  }
  mod('fx', opts.sql ?? TENANT_SQL, opts.code ?? '')
  for (const [id, o] of Object.entries(opts.extraModules ?? {})) mod(id, o.sql ?? TENANT_SQL, o.code ?? '')
  return root
}

const TENANT_SQL = `create table if not exists fx.ticket (
  id bigserial primary key,
  org text not null,
  code text not null
);
`

const GLOBAL_SQL = `-- global-table: 全租户共用的字典，无租户归属
create table if not exists fx.dict (
  key text primary key,
  label text
);
`

describe('判据：租户表查询必须带 org', () => {
  it('带 org 谓词 ⇒ 绿', async () => {
    const r = await checkOrgScope({
      rootDir: fixture({ code: "pool.query('select * from fx.ticket where org = $1 and code = $2')\n" }),
    })
    expect(r.violations).toEqual([])
    expect(r.counts.statements).toBe(1)
  })

  it('无 org ⇒ 红（报文件:行号与表名）', async () => {
    const r = await checkOrgScope({
      rootDir: fixture({ code: "const a = 1\npool.query('select * from fx.ticket where code = $1')\n" }),
    })
    expect(r.violations).toHaveLength(1)
    expect(r.violations[0].file).toBe('modules/fx/index.ts')
    expect(r.violations[0].line).toBe(2)
    expect(r.violations[0].message).toContain('fx.ticket')
  })

  it('update 无 org ⇒ 红', async () => {
    const r = await checkOrgScope({
      rootDir: fixture({ code: "pool.query(`update fx.ticket set code = $1 where id = $2`)\n" }),
    })
    expect(r.violations).toHaveLength(1)
  })

  it('delete from 无 org ⇒ 红', async () => {
    const r = await checkOrgScope({
      rootDir: fixture({ code: "pool.query('delete from fx.ticket where id = $1')\n" }),
    })
    expect(r.violations).toHaveLength(1)
  })
})

describe('动态插值边界：只有 WHERE 整体插值才放行', () => {
  it('`where ${where}` 形态 ⇒ 动态放行且计数', async () => {
    const r = await checkOrgScope({
      rootDir: fixture({
        code: "let where = 'org = $1'\npool.query(`select * from fx.ticket where ${where} order by id`)\n",
      }),
    })
    expect(r.violations).toEqual([])
    expect(r.counts.dynamic).toBe(1)
  })

  it('★ 插值在 SET 片段、WHERE 静态 ⇒ 仍红（metric_change 形态回归：部分动态不得整条漏网）', async () => {
    const r = await checkOrgScope({
      rootDir: fixture({
        code: 'const SETS = `x = 1`\npool.query(`update fx.ticket set code = $1, ${SETS} where id = $2 and status = any($3)`)\n',
      }),
    })
    expect(r.violations).toHaveLength(1)
    expect(r.counts.dynamic).toBe(0)
  })
})

describe('显式豁免：-- org-exempt: <理由>', () => {
  it('有理由 ⇒ 绿且计数', async () => {
    const r = await checkOrgScope({
      rootDir: fixture({
        code: "pool.query(`-- org-exempt: 保留策略，跨租户清老数据\n delete from fx.ticket where created_at < now()`)\n",
      }),
    })
    expect(r.violations).toEqual([])
    expect(r.counts.exempt).toBe(1)
  })

  it('★ 标记里的 org 一词不得让语句被当成「已有 org 谓词」', async () => {
    const r = await checkOrgScope({
      rootDir: fixture({ code: "pool.query(`-- org-exempt: 清理\n delete from fx.ticket`)\n" }),
    })
    expect(r.counts.exempt).toBe(1) // 走豁免路径，不是 org 判据路径
    expect(r.violations).toEqual([])
  })

  it('空理由 ⇒ 红（豁免不许变成默认勾选）', async () => {
    const r = await checkOrgScope({
      rootDir: fixture({ code: "pool.query(`-- org-exempt:\n delete from fx.ticket`)\n" }),
    })
    expect(r.violations).toHaveLength(1)
    expect(r.violations[0].message).toContain('没写理由')
  })
})

describe('不判的形态（边界）', () => {
  it('global-table 标记的表 ⇒ 不判', async () => {
    const r = await checkOrgScope({
      rootDir: fixture({ sql: GLOBAL_SQL, code: "pool.query('select * from fx.dict')\n" }),
    })
    // 注意：除 global 表外 fixture 没有别的租户表 ⇒ 走空转自检；这里断言「不是因 fx.dict 报的」
    const dictViolations = r.violations.filter((v) => v.message.includes('fx.dict'))
    expect(dictViolations).toEqual([])
  })

  it('insert into 租户表 ⇒ 不判（无 where 语义，由 T1「每行带 org 列」管）', async () => {
    const r = await checkOrgScope({
      rootDir: fixture({ code: "pool.query('insert into fx.ticket (code) values ($1)')\n" }),
    })
    expect(r.violations).toEqual([])
    expect(r.counts.statements).toBe(0)
  })

  it('注释里的伪 SQL 不算（TS 注释已掩码）', async () => {
    const r = await checkOrgScope({
      rootDir: fixture({ code: "// 这一步跑 select * from fx.ticket where code = $1\nconst a = 1\n" }),
    })
    expect(r.violations).toEqual([])
    expect(r.counts.statements).toBe(0)
  })

  it('增量迁移 alter table add column org ⇒ 表进租户集', async () => {
    const r = await checkOrgScope({
      rootDir: fixture({
        sql: `create table if not exists fx.note (id bigserial primary key, body text);
alter table fx.note add column if not exists org text not null;
`,
        code: "pool.query('select * from fx.note where id = $1')\n",
      }),
    })
    expect(r.violations).toHaveLength(1)
    expect(r.violations[0].message).toContain('fx.note')
  })
})

describe('空转自检', () => {
  it('全仓没有任何租户表 ⇒ 红（不许绿灯绿在空转上）', async () => {
    const r = await checkOrgScope({ rootDir: fixture({ sql: GLOBAL_SQL, code: '' }) })
    expect(r.violations.some((v) => v.message.includes('未提取到任何租户表'))).toBe(true)
  })
})

describe('maskJsComments（等长掩码）', () => {
  it('掩掉行注释与块注释，字符串与模板原文保留，长度不变', () => {
    const src = "const a = 'x' // select 1\n/* block */ const b = `t`\n"
    const masked = maskJsComments(src)
    expect(masked.length).toBe(src.length)
    expect(masked).toContain("'x'")
    expect(masked).toContain('`t`')
    expect(masked).not.toContain('select 1')
    expect(masked).not.toContain('block')
  })

  it('字符串里的 // 不是注释', () => {
    const src = "const u = 'http://x' \n"
    expect(maskJsComments(src).length).toBe(src.length)
    expect(maskJsComments(src)).toContain("'http://x'")
  })
})
