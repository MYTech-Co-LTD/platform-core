#!/usr/bin/env node
// check-source-manifests.mjs — 源清单（manifest）门禁（P1）。
//
// 判据（deploy/duckle/manifests/*.json 每个）：
//   ① manifest 合法（复用 gen-pipeline 的 validateManifest）；
//   ② 有生成物且与 manifest 一致：优先 pipelines/<id>.json（已晋级），否则 manifests/generated/<id>.json（试点/草稿）。
// 失败字面量：SOURCE_MANIFEST_FAILED: <file>: <reason>（exit 1）。
//
// 为什么需要它：manifest 是「不写代码接源」的唯一输入；没有门禁时，改 manifest 不重生成
// （或手改生成物）会让仓里两套事实悄悄漂移——生成器 --check 只查单个，本脚本查全量。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildPipeline, pipelineNames, validateManifest } from './gen-pipeline.mjs'

const MANIFEST_DIR = 'deploy/duckle/manifests'
const PIPELINE_DIR = 'deploy/duckle/console/pipelines'
const GENERATED_DIR = join(MANIFEST_DIR, 'generated')

/** @type {string[]} */
const violations = []
const files = readdirSync(MANIFEST_DIR).filter((f) => f.endsWith('.json'))
for (const f of files) {
  /** @type {unknown} */
  let raw
  try {
    raw = JSON.parse(readFileSync(join(MANIFEST_DIR, f), 'utf8'))
  } catch (e) {
    violations.push(`${f}: JSON 解析失败：${e instanceof Error ? e.message : String(e)}`)
    continue
  }
  const errs = validateManifest(raw)
  if (errs.length > 0) {
    violations.push(`${f}: ${errs.join('；')}`)
    continue
  }
  for (const name of pipelineNames(/** @type {any} */ (raw))) {
    const rendered = `${JSON.stringify(buildPipeline(/** @type {any} */ (raw), name), null, 2)}\n`
    const promoted = join(PIPELINE_DIR, `${name}.json`)
    const generated = join(GENERATED_DIR, `${name}.json`)
    const target = existsSync(promoted) ? promoted : existsSync(generated) ? generated : null
    if (target === null) {
      violations.push(`${f}: 缺生成物（${promoted} / ${generated} 都不存在）`)
      continue
    }
    if (readFileSync(target, 'utf8') !== rendered) {
      violations.push(`${f}: ${target} 与 manifest 不一致（改 manifest 后重生成）`)
    }
  }
}

if (violations.length > 0) {
  for (const v of violations) console.error(`SOURCE_MANIFEST_FAILED: ${v}`)
  process.exit(1)
}
console.log(`check-source-manifests: OK（${files.length} manifests）`)
