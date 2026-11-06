#!/usr/bin/env node
// apply-entity-bindings.mjs —— W4 Task 2 的一次性批量绑定（文本插入，只加 `entity:` 一行）。
// 用法：`pnpm exec tsx scripts/apply-entity-bindings.mjs [--write] [rootDir]`
// 不加 --write 只打印将要写入的映射（dry-run）。
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 指标族前缀 → 业务对象（保守规则，按描述对象归组）。 */
/** @param {string} name @returns {string} */
export function entityFor(name) {
  if (name.startsWith('lemeng:outbound:')) return 'outbound_order'
  if (name.startsWith('lemeng:transfer:')) return 'transfer'
  if (name.startsWith('lemeng:purchase:')) return 'supplier'
  if (name.startsWith('lemeng:client_contribution:')) return 'client'
  if (name.startsWith('lemeng:expense:client_')) return 'client'
  if (name.startsWith('lemeng:inventory:')) return 'storehouse'
  if (name.startsWith('lemeng:request:')) return 'request_order'
  if (name === 'lemeng:retail:order_line') return 'order'
  if (name === 'lemeng:wholesale:order_line') return 'wholesale_order'
  if (name.startsWith('lemeng:loss:')) return 'loss_bill'
  return 'branch' // retail / expense:branch / contribution / member / branch
}

function main() {
  const write = process.argv.includes('--write')
  const rootDir = process.argv.filter((a) => !a.startsWith('--'))[2] ?? fileURLToPath(new URL('..', import.meta.url))
  const p = join(rootDir, 'dbt', 'semantics', 'l1_metrics.yml')
  const lines = readFileSync(p, 'utf8').split('\n')
  const out = []
  let added = 0
  for (let i = 0; i < lines.length; i += 1) {
    out.push(lines[i])
    const m = /^  - name: '([^']+)'\s*$/.exec(lines[i])
    if (m === null) continue
    // 本条目块内已有 entity: 就跳过（块 = 下一条 `  - name:` 之前）
    let has = false
    for (let j = i + 1; j < lines.length && !/^  - name:/.test(lines[j]); j += 1) {
      if (/^    entity:/.test(lines[j])) { has = true; break }
    }
    if (has) continue
    const ent = entityFor(m[1])
    out.push(`    entity: ${ent}`)
    added += 1
    console.log(`${m[1]} → ${ent}`)
  }
  console.log(`\n新增 entity 绑定：${added} 条${write ? '（已写入）' : '（dry-run，加 --write 落盘）'}`)
  if (write) writeFileSync(p, out.join('\n'))
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('apply-entity-bindings.mjs')) main()
