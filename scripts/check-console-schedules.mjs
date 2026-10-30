// check-console-schedules.mjs — console 排班↔能力完整性门禁（#531、#630）。
//
// 判据（对 deploy/duckle/console/ 下每本 schedules/<book>.json 的每条目）：
//   ① pipeline_id 必须等于某管线文件的顶层 `name` —— 抓拼写错/引用了不存在的管线；
//   ② `enabled: true` 的条目，其 name 还必须「能力属于本账套」：
//      name stem 无账套数字后缀（共享族），或后缀 == <book>（本账套族）。
//      —— 这是 SOP §F.1「一账套一 console」危害形态（错账套排班 ⇒ 静默采错数据）在
//      **仓内源头**的闸：64188 的排班里出现 `*.l0.3120` 一类引用，合入前就红。
//   ③（#630）**完整性方向**：每本 book 的期望采集集 =（**同域**共享族 + 本账套后缀族）
//      − 全局豁免 − 本账套豁免；排班里缺一条 = 红。
//      域 = 管线名首段（`lemeng` / `forms` / …）；账套书 → 域：纯数字 = `lemeng`，
//      非数字书名 = 其字面量域（#729：forms 这类非乐檬域有自己的 console，不能塞进乐檬账套书）。
//      —— 反向缺口实证（#630）：W1/W2/W3 六条新管线只进 pipelines/ 没进 schedules/，
//      卷里永不自动采集，本闸当年照样绿。豁免必须显式列名 + 写理由，不许用前缀猜。
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

/** @param {string} stem @returns {string} 管线名首段 = 域（`lemeng` / `forms` / …） */
const domainOf = (stem) => stem.split('.')[0]
/**
 * 账套书 → 域。纯数字 = 乐檬账套号（历史约定）；否则书名字面量即域名（非乐檬域，如 `forms`）。
 * @param {string} book @returns {string}
 */
const bookDomain = (book) => (/^[0-9]+$/.test(book) ? 'lemeng' : book)

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
  // 账套书名：纯数字（乐檬账套号）或一个**有管线的域名**（非乐檬域，如 `forms`）。
  if (!/^[0-9]+$/.test(book) && ![...capability.keys()].some((n) => domainOf(n) === book)) {
    violations.push(
      `book=<${book}> 排班书名既不是纯数字账套号，也不是任何管线的域名（schedules/<账套|域>.json 约定）`,
    )
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
    if (entry.enabled === true && domainOf(pid) !== bookDomain(book)) {
      violations.push(
        `book=${book} entry=${String(entry.id)} enabled 引用**他域**管线 ${pid}（域 ${domainOf(pid)}≠${bookDomain(book)}）——错域排班，§F.1 危害形态`,
      )
    }
    if (entry.enabled === true && suf !== '' && suf !== book) {
      violations.push(`book=${book} entry=${String(entry.id)} enabled 引用他账套管线 ${pid}（后缀 ${suf}≠${book}）——错账套排班，§F.1 危害形态`)
    }
  }
}

// ── ③ 完整性方向（#630）：期望采集集 ⊆ 排班条目集 ────────────────────────────
// 豁免名单：管线名 → 理由（为什么不该有日更排班）。新增豁免必须在这里显式登记。
/** @type {Map<string, string>} */
const EXEMPT_GLOBAL = new Map([
  ['lemeng.retail.windows.backfill', '回填专用（换时间窗手动触发，handbook §1.3 阶段 H）'],
  ['lemeng.wholesale.out.backfill.3120', '回填专用（2026-10-10 裁决：待全管线补采统一覆盖，§1.7）'],
  ['lemeng.transfer.in.backfill.3120', '回填专用（#665 契约 v2 重采 10-12 用；同族 wholesale 先例）'],
  ['lemeng.retail_order_line.tick', '旧零售族残留——已被 retail.tick.l1 取代，待退役（§2 台账）'],
  ['lemeng.retail_order_line.window', '旧零售族残留——已被 retail.windows.l1 取代，待退役（§2 台账）'],
  ['lemeng.retail_order_line.day', '**foreach 子管线**——由 lemeng.retail.windows.l1 的 ctl.foreach 逐天驱动（2026-10-20 起整天重采），不单独排班；排班在父管线'],
  ['lemeng.retail.day.backfill', '回填专用（整天重采某一天，${BIZDAY} 由驱动脚本经 POST /api/run 的 params 传入，handbook §1.3 阶段 H）'],
  ['lemeng.retail_order_line.day.hp', '**foreach 子管线 + 容量溢出变体**（160 页，#1168）——由 lemeng.retail.day.backfill.hp 驱动，只在整天行数击穿 96 页上限的日子（春节峰）手动用；排班在 windows.l1 / backfill'],
  ['lemeng.retail.day.backfill.hp', '回填专用·容量溢出变体（#1168，pipelineRef 指向 160 页 hp 子管线）——仅当 day.backfill 因容量哨兵停机时换用，${BIZDAY} 参数化'],
['lemeng.branch.expense.backfill.3120', '回填专用（#1047 费用空窗补采 9-20..10-12；${BIZDAY} 参数化，同族 transfer.in 先例）'],
['lemeng.loss.adjustment.backfill.3120', '回填专用（#1047 报损回填 10-01..19；同款参数化）'],
  ['lemeng.member.summary.backfill.3120', '回填专用（#1047 会员全店回填 10-01..24；${BIZDAY} 参数化，同族 loss/expense 先例）'],
  ['lemeng.branch_indicator.backfill.3120', '回填专用（#1047 D10 配送金额回填 10-01..19；${BIZDAY} 参数化，同族成员先例）'],
  ['lemeng.branch_indicator.day', '**foreach 子管线**——由 lemeng.branch_indicator.l0.3120 的 ctl.foreach 逐门店块驱动（100 家/块绕端点硬限），不单独排班；排班在父管线'],
  ['lemeng.inventory.snapshot.backfill.3120', '回填专用（#1079 库存快照 10-18..10-25 补采；${BIZDAY} 参数化，同族 transfer.in 先例）'],
  ['lemeng.recon.preagg.item', '按需手动（逐分归零对账执行面，无日更节奏）'],
  ['lemeng.recon.preagg.backfill', '回填专用（换 BIZDAY 参数手动触发，handbook §1.3 阶段 H）'],
  // ── #1160 全量历史回填（2024-10-01 起，双账套）：以下变体由
  //    scripts/lemeng/gen-backfill-variants.mjs 从同账套 l0 机械派生，只在回填期手动驱动。
  ['lemeng.request.order.backfill.3120', '回填专用（#1160 全量历史回填；${BIZDAY} 参数化）'],
  ['lemeng.transfer.out.backfill.3120', '回填专用（#1160 全量历史回填；${BIZDAY} 参数化）'],
  ['lemeng.purchase.analysis.backfill.3120', '回填专用（#1160 全量历史回填；${BIZDAY} 参数化）'],
  ['lemeng.client.expense.backfill.3120', '回填专用（#1160 全量历史回填；${BIZDAY} 参数化）'],
  ['lemeng.branch.expense.backfill.64188', '回填专用（#1160 64188 侧全量历史回填；${BIZDAY} 参数化）'],
  ['lemeng.loss.adjustment.backfill.64188', '回填专用（#1160 64188 侧全量历史回填；${BIZDAY} 参数化）'],
  ['lemeng.member.summary.backfill.64188', '回填专用（#1160 64188 侧全量历史回填；${BIZDAY} 参数化）'],
  ['lemeng.branch_indicator.backfill.64188', '回填专用（#1160 64188 侧全量历史回填；${BIZDAY} 参数化）'],
  ['lemeng.inventory.snapshot.backfill.64188', '回填专用（#1160 64188 侧全量历史回填；${BIZDAY} 参数化）'],
  ['lemeng.request.order.backfill.64188', '回填专用（#1160 64188 侧全量历史回填；${BIZDAY} 参数化）'],
  ['lemeng.purchase.analysis.backfill.64188', '回填专用（#1160 64188 侧全量历史回填；${BIZDAY} 参数化）'],
  ['lemeng.client.expense.backfill.64188', '回填专用（#1160 64188 侧全量历史回填；${BIZDAY} 参数化）'],
  // （#729）forms 的那条旧豁免已**删除**：期望集改成「按**域**判」后，无后缀的
  // `forms.submission.l0` 不再被当乐檬共享族塞给 3120/64188，豁免失去存在理由。
  // forms 的排班随它自己的 console/workspace 落地登记进 `schedules/forms.json`（M1.4 阶段 E）。
])
/** @type {Map<string, Map<string, string>>} book →（管线名 → 理由） */
const EXEMPT_BY_BOOK = new Map([
  ['3120', new Map([
    ['lemeng.dim.item_price.l0', '3120 排 .3120 后缀版（R1 增量模型）；无后缀共享版只归 64188'],
  ])],
])

for (const f of scheduleFiles) {
  const book = stemOf(f)
  if (!/^[0-9]+$/.test(book)) continue // 结构问题已在上半段报过，不重复计
  const exemptBook = EXEMPT_BY_BOOK.get(book) ?? new Map()
  /** @type {Set<string>} 本 book 的排班覆盖集 */
  const covered = new Set(readJson(join(ROOT, 'schedules', f)).map((/** @type {{pipeline_id?: unknown}} */ e) => String(e.pipeline_id)))
  for (const [name, suffix] of capability) {
    if (domainOf(name) !== bookDomain(book)) continue // 非本域，本 book 不期望（#729）
    if (suffix !== '' && suffix !== book) continue // 非本账套族，本 book 不期望
    if (EXEMPT_GLOBAL.has(name) || exemptBook.has(name)) continue
    if (!covered.has(name)) {
      violations.push(`book=${book} 管线 ${name} 无排班条目（期望采集集缺员，#630 完整性方向；豁免须登记进 EXEMPT_*）`)
    }
  }
}

if (violations.length > 0) {
  for (const v of violations) console.error(`SCHEDULE_INTEGRITY_FAILED: ${v}`)
  process.exit(1)
}
console.log(`check-console-schedules: OK（${scheduleFiles.length} 本排班 / ${entryTotal} 条目 / 能力集 ${capability.size} 管线）`)
