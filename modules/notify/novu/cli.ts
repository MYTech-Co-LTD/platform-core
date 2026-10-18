#!/usr/bin/env node
// cli.ts — 把文案正典播进 Novu（**Dev**；生产只能经 sync，Novu 生产建 workflow 一律 401）。
//
// 用法：NOVU_API_BASE=<dev base> NOVU_API_KEY=<dev key> pnpm exec tsx modules/notify/novu/cli.ts
// 幂等：只建缺失的（create-if-absent），已存在的一律跳过、不覆盖 dashboard 改动。
import { seedWorkflows } from './seed'

const { NOVU_API_BASE: base, NOVU_API_KEY: key } = process.env
if (!base || !key) {
  console.error('需要 NOVU_API_BASE / NOVU_API_KEY（取法见 .env.example 的 NOVU_* 段）')
  process.exit(1)
}

try {
  const { created, skipped } = await seedWorkflows({ base, key })
  console.log(`created: ${created.join(', ') || '(none)'}`)
  console.log(`skipped(已存在不覆盖): ${skipped.join(', ') || '(none)'}`)
  if (created.length > 0) {
    console.log('⚠️ 下一步：人审线上渲染 → sync 到生产（§2.6 门禁分层：文案是低频 × 大，不可撤回）')
  }
} catch (e) {
  console.error(`seed 失败: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}
