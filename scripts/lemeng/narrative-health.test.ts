// scripts/lemeng/narrative-health.test.ts —— 薄壳的唯一职责：argv 组装（总是 --emit）。
//
// 变异靶点：把 `--emit` 去掉 ⇒ 用例红（不投递的探针等于没跑，退出码还是 0 —— 假绿）。
import { describe, expect, it } from 'vitest'
import { PROBE_SCRIPT, buildArgv } from './narrative-health.mjs'

describe('narrative-health 薄壳', () => {
  it('★ 总是带 --emit（否则只打印、不投递，job 仍然绿）', () => {
    expect(buildArgv()).toEqual([PROBE_SCRIPT, '--emit'])
    expect(buildArgv(['--days', '30'])).toEqual([PROBE_SCRIPT, '--emit', '--days', '30'])
  })

  it('判据本体路径在 scripts/ 下且是 python（runner 会经 tsx 起本壳，再 spawn python3）', () => {
    expect(PROBE_SCRIPT.startsWith('scripts/')).toBe(true)
    expect(PROBE_SCRIPT.endsWith('.py')).toBe(true)
  })
})
