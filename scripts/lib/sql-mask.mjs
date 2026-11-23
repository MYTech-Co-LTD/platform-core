// scripts/lib/sql-mask.mjs — SQL 注释掩码（check-tenant-isolation 与 check-org-scope 共用）。
//
// 从 check-tenant-isolation.mjs 抽出（2026-11-23，B14 落地时），实现与注释一字未改；
// check-tenant-isolation 以 `export { maskSql } from './lib/sql-mask.mjs'` 保持对外导出不变。

/**
 * SQL 注释掩码（等长 ⇒ 行号与列位都不变）。
 *
 * 为什么要两种形态：本脚本对**同一段文本**有两个互相冲突的需求——
 *   · 认 `create table` 需要**代码位**（注释里那句「见 001 的 create table…」不能算数）；
 *   · 认豁免标记需要**行注释位**（标记本身就是一行注释，掩掉就没了）。
 * 故同一台状态机跑两遍：`keepLineComments=false` 给代码用（行注释也掩成空格，于是「注释行」在
 * 代码文本里就是一行空白——下面「跳过注释/空行」的判定因此只需判空白），`true` 给标记用
 * （行注释原文保留，字符串与块注释仍掩掉）。两串等长 ⇒ 行号一一对应。
 *
 * 已知边界：只认单引号字符串（含 `''` 转义）与 `--` / 块注释；带双引号的标识符、`$$…$$`
 * dollar-quoted 串、`E''` 里的反斜杠转义不识别。本仓模块迁移不用这些写法；真要用，这里
 * 与头注「边界」节要一起改。
 *
 * @param {string} src @param {boolean} keepLineComments @returns {string}
 */
export function maskSql(src, keepLineComments) {
  let out = ''
  let state = 'code' // code | line | block | sq
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const n = src[i + 1]
    if (state === 'code') {
      if (c === '-' && n === '-') {
        state = 'line'
        out += keepLineComments ? '--' : '  '
        i++
      } else if (c === '/' && n === '*') {
        state = 'block'
        out += '  '
        i++
      } else {
        if (c === "'") state = 'sq'
        out += c
      }
      continue
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code'
        out += c
      } else out += keepLineComments ? c : ' '
      continue
    }
    if (state === 'block') {
      if (c === '*' && n === '/') {
        state = 'code'
        out += '  '
        i++
      } else out += c === '\n' ? '\n' : ' '
      continue
    }
    // 单引号字符串：内容掩成空格（`''` 是转义引号，仍在串内），未闭合则在行尾兜底
    if (c === "'") {
      if (n === "'") {
        out += '  '
        i++
        continue
      }
      state = 'code'
      out += c
      continue
    }
    if (c === '\n') {
      state = 'code'
      out += c
      continue
    }
    out += ' '
  }
  return out
}
