#!/usr/bin/env node
// gen-invariant-tests.mjs —— 由 invariants.yml 生成 dbt singular tests（W4 Task 4，#1447）。
//
// 只生成 `status: verified` 的条目；`observing`/`candidate` 不生成（不把未验证的规则变成硬门）。
// 变换：`select count(*) from <rel> where <P>` → `select * from <rel> where <P>`（dbt 以「返回行」判失败）。
// 用法：`pnpm exec tsx scripts/gen-invariant-tests.mjs [--check] [rootDir]`
//   --check：只比对不写盘（文件内容不一致 ⇒ exit 1），用于 CI 防「改了声明忘了重生成」。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

/** @param {any} doc */
export function testsOf(doc) {
  const list = Array.isArray(doc?.invariants) ? doc.invariants : []
  return list
    .filter((/** @type {any} */ i) => i?.status === 'verified' && typeof i.check_sql === 'string')
    .map((/** @type {any} */ i) => {
      const sql = String(i.check_sql)
      const m = /^select\s+count\(\*\)\s+from\s+([A-Za-z_][\w.]*)\s+where\s+/i.exec(sql)
      if (m === null) throw new Error(`invariant ${i.name}: check_sql 不是「select count(*) from <rel> where …」形态`)
      const body = `select * from ${m[1]} where ${sql.slice(m[0].length).trim().replace(/;\s*$/, '')}`
      const header = `-- 由 dbt/semantics/invariants.yml 生成（W4 #1447）——不要手改；改声明后重跑 scripts/gen-invariant-tests.mjs。\n-- 不变量：${i.name}\n{{ config(severity='${i.severity === 'warn' ? 'warn' : 'error'}') }}\n`
      return { name: String(i.name), path: `dbt/tests/lemeng/invariant_${String(i.name)}.sql`, content: `${header}${body}\n` }
    })
}

function main() {
  const check = process.argv.includes('--check')
  const rootDir = process.argv.filter((a) => !a.startsWith('--'))[2] ?? fileURLToPath(new URL('..', import.meta.url))
  const doc = parse(readFileSync(join(rootDir, 'dbt', 'semantics', 'invariants.yml'), 'utf8'))
  const tests = testsOf(doc)
  let drift = 0
  for (const t of tests) {
    const p = join(rootDir, t.path)
    const cur = existsSync(p) ? readFileSync(p, 'utf8') : null
    if (cur === t.content) continue
    drift += 1
    if (!check) {
      mkdirSync(join(rootDir, 'dbt', 'tests', 'lemeng'), { recursive: true })
      writeFileSync(p, t.content)
      console.log(`写入 ${t.path}`)
    } else console.log(`DRIFT ${t.path}`)
  }
  console.log(`gen-invariant-tests: ${tests.length} 条 verified，${drift} 处${check ? 'drift' : '写入'}`)
  if (check && drift > 0) process.exit(1)
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('gen-invariant-tests.mjs')) main()
