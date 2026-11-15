#!/usr/bin/env node
// scripts/lemeng/materialize-job.mjs — dbt 物化的调度器入口（Wave 8 P1）。
//
// 真身是 `scripts/lemeng/materialize.sh`（openship 时代由 /opt 投递，同一份文件）；本脚本只做
// 「调度器 → sh」的薄转发：env 原样继承（`MATERIALIZE_SCOPE` / `DATA_PLANE_DOMAINS` 由
// registry 的 `JobDef.env` 注入），退出码原样透传（materialize.sh 的 0/1/2 语义不变）。
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./materialize.sh', import.meta.url))

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const r = spawnSync('sh', [script], { stdio: 'inherit', env: process.env })
  if (r.error) {
    console.error(`materialize-job: 启动失败 ${r.error.message}`)
    process.exit(2)
  }
  process.exit(r.status ?? 1)
}
