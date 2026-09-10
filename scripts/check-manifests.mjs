#!/usr/bin/env node
// B4/B5 机检门禁：模块 manifest.yaml 合法性 + 命名空间唯一性 + 引用实体存在性。
// 用法：pnpm exec tsx scripts/check-manifests.mjs [rootDir]（默认仓库根）
// 核心逻辑在 packages/platform-sdk/src/checks.ts 的 runChecks——CLI 只做一行调用。
import { fileURLToPath } from 'node:url'
import { runChecks } from '../packages/platform-sdk/src/checks.ts'

const rootDir = process.argv[2] ?? fileURLToPath(new URL('../', import.meta.url))

const { errors } = await runChecks(rootDir)
if (errors.length > 0) {
  console.error(`check-manifests: ${errors.length} 处违规`)
  for (const e of errors) console.error(`  ✗ ${e}`)
  process.exit(1)
}
console.log('check-manifests: OK')
