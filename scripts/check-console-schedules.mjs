// check-console-schedules.mjs — console 排班↔能力完整性门禁（#531）。
//
// 判据（对 deploy/duckle/console/ 下每本 schedules/<book>.json 的每条目）：
//   ① pipeline_id 必须等于某管线文件的顶层 `name` —— 抓拼写错/引用了不存在的管线；
//   ② `enabled: true` 的条目，其 name 还必须「能力属于本账套」：
//      name stem 无账套数字后缀（共享族），或后缀 == <book>（本账套族）。
//      —— 这是 SOP §F.1「一账套一 console」危害形态（错账套排班 ⇒ 静默采错数据）在
//      **仓内源头**的闸：64188 的排班里出现 `*.l0.3120` 一类引用，合入前就红。
//
// 不变量顺带钉住：管线顶层 name == 文件名 stem（生成器保证；suffix 判定依赖它）。
// books 由 schedules/*.json 文件集推导（不写死账套清单）。
//
// 失败字面量：`SCHEDULE_INTEGRITY_FAILED:`（每条违规一行，exit 1）。
// 用法：pnpm exec tsx scripts/check-console-schedules.mjs [--root <console目录>]（默认仓内正典路径）
import { readdirSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'

const rootArgIdx = process.argv.indexOf('--root')
const ROOT = rootArgIdx === -1 ? 'deploy/duckle/console' : process.argv[rootArgIdx + 1]
if (typeof ROOT !== 'string' || ROOT.length === 0) {
  console.error('check-console-schedules: --root 需要一个目录参数')
  process.exit(2)
}

/** 单形状纪律（scripts/ 是 checkJs）：字段恒在，缺了就当结构漂移大声红，不做可辨识联合收窄。 */
/** @param {string} path @returns {any} */
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

// ── 能力集：管线顶层 name → 账套后缀（'' = 共享族）────────────────────────────
/** @param {string} f @returns {string} 文件名 stem（去 .json） */
const stemOf = (f) => basename(f).replace(/\.json$/, '')
/** @param {string} stem @returns {string} stem 尾部 `.<纯数字>` 的数字串；无 = ''（共享族） */
function accountSuffix(stem) {
  const m = /\.([0-9]+)$/.exec(stem)
  return m === null ? '' : m[1]
}

/** @type {Map<string, string>} name → suffix */
const capability = new Map()
for (const f of readdirSync(join(ROOT, 'pipelines'))) {
  if (!f.endsWith('.json')) continue
  const j = readJson(join(ROOT, 'pipelines', f))
  if (typeof j.name !== 'string' || j.name.length === 0) {
    console.error(`SCHEDULE_INTEGRITY_FAILED: 管线 ${f} 顶层缺非空 name（结构漂移）`)
    process.exit(1)
  }
  const stem = stemOf(f)
  if (j.name !== stem) {
    console.error(`SCHEDULE_INTEGRITY_FAILED: 管线 ${f} 顶层 name(${j.name}) != 文件名 stem(${stem})——suffix 判定依赖两者一致`)
    process.exit(1)
  }
  capability.set(j.name, accountSuffix(stem))
}

// ── 逐本排班过判据 ────────────────────────────────────────────────────────────
/** @type {string[]} 违规明细（每条一行） */
const violations = []
let entryTotal = 0
const scheduleFiles = readdirSync(join(ROOT, 'schedules')).filter((f) => f.endsWith('.json')).sort()
if (scheduleFiles.length === 0) {
  console.error('SCHEDULE_INTEGRITY_FAILED: schedules/ 下一本排班都没有——门禁没东西可判本身就可疑')
  process.exit(1)
}
for (const f of scheduleFiles) {
  const book = stemOf(f)
  if (!/^[0-9]+$/.test(book)) {
    violations.push(`book=<${book}> 排班文件名不是纯数字账套号（schedules/<账套>.json 约定）`)
    continue
  }
  const entries = readJson(join(ROOT, 'schedules', f))
  if (!Array.isArray(entries)) {
    violations.push(`book=${book} 排班顶层不是数组（结构漂移）`)
    continue
  }
  for (const entry of entries) {
    entryTotal += 1
    const pid = entry.pipeline_id
    if (typeof pid !== 'string' || pid.length === 0) {
      violations.push(`book=${book} entry=${String(entry.id)} 条目缺非空 pipeline_id`)
      continue
    }
    if (!capability.has(pid)) {
      violations.push(`book=${book} entry=${String(entry.id)} 引用了不存在的管线 ${pid}（拼写错/漏生成？）`)
      continue
    }
    const suf = capability.get(pid)
    if (entry.enabled === true && suf !== '' && suf !== book) {
      violations.push(`book=${book} entry=${String(entry.id)} enabled 引用他账套管线 ${pid}（后缀 ${suf}≠${book}）——错账套排班，§F.1 危害形态`)
    }
  }
}

if (violations.length > 0) {
  for (const v of violations) console.error(`SCHEDULE_INTEGRITY_FAILED: ${v}`)
  process.exit(1)
}
console.log(`check-console-schedules: OK（${scheduleFiles.length} 本排班 / ${entryTotal} 条目 / 能力集 ${capability.size} 管线）`)
