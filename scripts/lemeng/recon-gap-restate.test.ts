// scripts/lemeng/recon-gap-restate.test.ts — 「缺整天」自愈闸（#2742 第②刀）的判据机检。
//
// 这里钉三件不需要数据库的事：
//   ① 选日 SQL 的**三个条件必须同时在**（无台账 ∧ 无 break ∧ 平台侧有营业）——
//      少任一条都会把 `ledger_stale`（该归 ledger_guard）或 `nobiz`（闭店，不该有台账）误当 gap，
//      那会每天夜里白白重采一遍并烧 API 配额；
//   ② console 触发的**请求体形状**与 `recon-monthly.mjs` 同源（同一条 backfill 管线、同一个 BIZDAY 参数）；
//   ③ 结果归类里 `lake_unavailable` 是**合法空窗**（零销/天文件未封版），不判红。
import { describe, expect, it } from 'vitest'
import { classifyRun, gapSql, triggerBody } from './recon-gap-restate.mjs'

describe('recon-gap-restate · 选日判据', () => {
  const sql = gapSql('2026-11-18', '2026-11-24')

  it('① 无台账行', () => {
    expect(sql).toContain('not exists (select 1 from staging.recon_run')
  })
  it('② 无 break 行（有行的是 ledger_stale，归 ledger_guard）', () => {
    expect(sql).toContain('not exists (select 1 from staging.recon_break')
  })
  it('③ 平台侧该日有营业（两侧全空 = 闭店，不该有台账）', () => {
    expect(sql).toContain('exists (select 1 from pd')
  })
  it('日期是字面量（不让 pg_duckdb 放弃文件裁剪）', () => {
    expect(sql).toContain("date '2026-11-18'")
    expect(sql).toContain("date '2026-11-24'")
    expect(sql).not.toMatch(/now\(\)/)
  })
  it('只读：不含任何写语句', () => {
    expect(sql).not.toMatch(/\b(insert|update|delete|truncate|create)\b/i)
  })
})

describe('recon-gap-restate · console 触发', () => {
  it('请求体同源：同一条 backfill 管线 + BIZDAY 参数', () => {
    expect(triggerBody('2026-11-20')).toEqual({
      file: 'pipelines/lemeng.recon.preagg.backfill.json',
      params: { BIZDAY: '2026-11-20' },
    })
  })
})

describe('recon-gap-restate · 结果归类', () => {
  it('ok ⇒ pass', () => {
    expect(classifyRun({ status: 'ok' })).toBe('pass')
  })
  it('依赖不可用 ⇒ skip（零销 / 天文件未封版是合法空窗）', () => {
    expect(classifyRun({ status: 'error', error: 'ctl.die: recon 依赖不可用（lake_unavailable）' })).toBe('skip')
    expect(classifyRun({ status: 'error', error: 'query returned 0 records' })).toBe('skip')
  })
  it('其它错误 ⇒ fail（要人看）', () => {
    expect(classifyRun({ status: 'error', error: 'gthresh 判据破' })).toBe('fail')
    expect(classifyRun(undefined)).toBe('fail')
  })
})
