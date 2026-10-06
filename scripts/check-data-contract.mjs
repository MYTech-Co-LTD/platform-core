// scripts/check-data-contract.mjs — 「湖的列集只有一个事实源」的门禁（architecture.md §5.2 ① / 不变量 B10）。
//
// ## 它防的是哪一类
//
// 加一列 / 改一列要同时改好几处：契约、写湖的管线 `code.sql` 投影、staging 投影。
// 在 2026-10-05 之前**这三处没有任何机检**：`check-data-models.mjs` 头注明写
// 「`duckle/` 与 `contracts/` **不在任何扫描面内**」——于是「漏改一处」只能靠人记得。
// 实测代价：`order_total_money` 那次补采（#430/#432）改动了 5 处，**没有任何门禁拦得住漏改**。
//
// 本门禁把契约钉成**唯一事实源**，其余两处机械核对：
//
//   ① **契约必须有 `schemaVersion`**（正整数）——它是「这套文件是哪一版」的对外名字，
//      封版标记（`_SCHEMA/v<N>.parquet`）与读侧断言都引用它。没有它 = 没登记。
//   ② **生产面**：凡**文本里出现该契约 `layout.prefix`** 的管线文件，都算这张表的**生产者**
//      （机械推导、不靠手登记 ⇒ 不会有"新管线忘了登记"这种漂移）。
//      每个生产者文件里必须**恰好一个** `code.sql` 节点的输出别名序列 == 契约列序列（同序）。
//      其余 `code.sql` 节点（`qa.contract` 前的守卫、回执等）不参与比对。
//   ③ **消费面**：`dbt/models/common/staging/stg_<domain>_<table>.sql` 的投影别名序列
//      （去掉 dbt 注入的 `org`）必须是契约列序列的**同序前缀**；再按 `consumerVersion` 定档：
//        · `consumerVersion == schemaVersion` ⇒ 前缀必须补齐成**完全相等**（迁移做完了）；
//        · `consumerVersion <  schemaVersion` ⇒ 前缀必须**严格更短**，且门禁**打印一行提示**
//          （展开期中、迁移未完成）——**不是红，但也不沉默**；
//        · `consumerVersion >  schemaVersion` ⇒ 红（消费者读的版本还不存在）。
//      ⚠️ 前缀这个形状有个前提：**新列一律追加在末尾**（见 docs/architecture.md §5.2）。
//      中间插列会让所有消费者的投影不再是前缀 ⇒ 必然红——这是有意的，插列本就该走「加新列 + 停用旧列」。
//
//   ④ **申报面**：投影里引用的 `<输入别名>.<字段>`，必须都在**喂它的那几路 `src.rest`** 的
//      `data.schema` 里逐条申报。🔴 为什么非有不可：**空响应时引擎按「申报」构造关系**
//      （非空响应才靠实际字段兜住）⇒ 没申报的字段会 `Binder Error`，而**平时完全看不出来**。
//      2026-10-05 实测（#432 的教训）：只改 flatten 的 SQL、没改申报 ⇒ 24 个窗口里
//      **只有空窗失败**（23 个照常成功），报 `Values list "o" does not have a column named …`。
//      ⚠️ 「喂它的那几路」= **`ctl.merge` 的直接 `src.rest` 父**——不能一把抓全部 src.rest（身份闸门
//      `w0` 也是投影的上游，但它是**控制父**，不喂数据 ⇒ 会误报），也不能取并集（一个节点漏申报就够了）。
//
// ## 为什么比「序列」而不是「集合」
//
// 同序也是有意义的：它让「按契约顺序读 parquet 的列位置」这种朴素写法不会在换列时静默错位。
// 且实测三张表现状都是同序的（见 scripts/check-data-contract.test.ts 的夹具）。
//
// ## 已知的取列形态与本门禁的适配
//
// - 管线侧：`CAST(...) AS col`、`'${VAR}' AS col`；`CAST(x AS JSON)`／`AS u(d)` 这类
//   **类型名与表别名**不是投影列，靠「只认小写标识符」+「别名后不许紧跟 `(`」两条排除。
// - staging 侧：`r['col'] as col`、`{{ subject_org() }} as org`。SQL 注释先掩掉再取
//   （注释里有大量英文散文，"as" 满天飞）。
//
// 用法：`pnpm exec tsx scripts/check-data-contract.mjs [rootDir]`（rootDir 默认仓根，测试用）。

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** 脚本名（输出前缀）。 */
export const SCRIPT_NAME = 'check-data-contract'

/** 契约目录（相对仓根）。 */
const CONTRACT_DIR = 'contracts'
/** 管线目录（相对仓根）——生产者的推导面。 */
const PIPELINE_DIRS = ['deploy/duckle/console/pipelines', 'duckle']
/** 契约里不是「真契约」的文件名（元 schema 与模板）。 */
const NON_CONTRACT = new Set(['_schema.schema.json', '_template.contract.json'])

/** dbt 在 staging 层注入的列（不属契约；见 dbt/macros/subject_org.sql）。 */
export const INJECTED_STAGING_COLUMNS = ['org']

/**
 * @typedef {{ file: string, message: string }} Violation
 */

/**
 * 掩掉 SQL 注释（`--` 行注释与块注释）。**不掩字符串**——取列正则只认小写标识符，
 * 字符串里的内容不会误命中。与 check-tenant-isolation / check-data-models 同一手法。
 *
 * @param {string} src
 * @returns {string}
 */
export function maskSqlComments(src) {
  let out = ''
  let state = 'code'
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const n = src[i + 1]
    if (state === 'code') {
      if (c === '-' && n === '-') {
        state = 'line'
        out += '  '
        i++
      } else if (c === '/' && n === '*') {
        state = 'block'
        out += '  '
        i++
      } else out += c
      continue
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code'
        out += c
      } else out += ' '
      continue
    }
    // block
    if (c === '*' && n === '/') {
      state = 'code'
      out += '  '
      i++
    } else out += c === '\n' ? '\n' : ' '
  }
  return out
}

/**
 * 从管线 `code.sql` 的 SQL 里取输出别名序列。
 *
 * 只认**小写**标识符（排除 `CAST(x AS JSON)` 这类大写类型名），且别名后**不许紧跟 `(`**
 * （排除 `CROSS JOIN UNNEST(...) AS u(d)` 那种表别名）。
 *
 * @param {string} sql
 * @returns {string[]}
 */
export function extractPipelineAliases(sql) {
  /** @type {string[]} */
  const out = []
  const re = /\bAS\s+([a-z][a-z0-9_]*)\b(?!\s*\()/g
  let m
  while ((m = re.exec(maskSqlComments(sql))) !== null) out.push(m[1])
  return out
}

/**
 * 从 staging 模型的 SQL 里取投影别名序列（先掩注释；`as` 一律小写是本仓写法）。
 *
 * @param {string} sql
 * @returns {string[]}
 */
export function extractStagingAliases(sql) {
  /** @type {string[]} */
  const out = []
  const re = /\bas\s+([a-z][a-z0-9_]*)\b/g
  let m
  const masked = maskSqlComments(sql)
  while ((m = re.exec(masked)) !== null) out.push(m[1])
  return out
}

/**
 * 递归收集目录下的 `.json` 文件（相对仓根的 posix 路径）。
 *
 * @param {string} root
 * @param {string} relDir
 * @returns {string[]}
 */
function collectJson(root, relDir) {
  const abs = join(root, relDir)
  if (!existsSync(abs)) return []
  /** @type {string[]} */
  const out = []
  for (const ent of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${relDir}/${ent.name}`
    if (ent.isDirectory()) out.push(...collectJson(root, rel))
    else if (ent.name.endsWith('.json')) out.push(rel)
  }
  return out
}

/**
 * 读取一份契约的关键字段（缺字段时返回 null 由调用方报违规）。
 *
 * @param {string} root
 * @param {string} rel
 * @returns {{ rel: string, domain: string, table: string, prefix: string, schemaVersion: unknown, consumerVersion: unknown, columns: string[] } | null}
 */
function readContract(root, rel) {
  /** @type {any} */
  let doc
  try {
    doc = JSON.parse(readFileSync(join(root, rel), 'utf8'))
  } catch (e) {
    return null
  }
  const layout = doc && typeof doc.layout === 'object' && doc.layout !== null ? doc.layout : {}
  const cols = Array.isArray(doc?.columns) ? doc.columns : []
  return {
    rel,
    domain: String(doc?.domain ?? ''),
    table: String(doc?.table ?? ''),
    prefix: String(layout.prefix ?? ''),
    schemaVersion: doc?.schemaVersion,
    consumerVersion: doc?.consumerVersion,
    columns: cols.map((/** @type {any} */ c) => String(c?.name ?? '')),
  }
}

/**
 * 跑全部门禁判据。
 *
 * @param {string} rootDir 仓根
 * @returns {Violation[]}
 */
export function checkDataContract(rootDir) {
  /** @type {Violation[]} */
  const violations = []
  const contractFiles = collectJson(rootDir, CONTRACT_DIR).filter(
    (p) => !NON_CONTRACT.has(p.split('/').pop() ?? ''),
  )
  const pipelines = PIPELINE_DIRS.flatMap((d) => collectJson(rootDir, d))

  for (const rel of contractFiles) {
    const c = readContract(rootDir, rel)
    if (c === null) {
      violations.push({ file: rel, message: '契约不是合法 JSON —— 无法核对' })
      continue
    }
    const where = `${c.domain}/${c.table}`

    // ① schemaVersion 必须登记
    const sv = c.schemaVersion
    if (typeof sv !== 'number' || !Number.isInteger(sv) || sv < 1) {
      violations.push({
        file: rel,
        message:
          `契约缺少合法的 schemaVersion（收到 ${JSON.stringify(sv)}）—— 它是「这套文件是哪一版」的对外名字，` +
          `封版标记（_SCHEMA/v<N>.parquet）与读侧断言都引用它。见 docs/architecture.md §5.2 ①`,
      })
    }
    /** 已收窄的 schemaVersion（非法时为 null）——下面各处比较都用它，避免 unknown 参与运算。 */
    const svNum = typeof sv === 'number' && Number.isInteger(sv) && sv >= 1 ? sv : null

    // ② 生产面：对该 prefix 有**写**（snk.* 节点属性里引用它）的管线 = 这张表的生产者。
    //    只在 src.*（读）里引用 prefix 的是**读者**（判据/对账类管线），不参与生产者比对。
    //    （2026-10-06 收窄：旧判定「文本含 prefix」会把读者误判成生产者——首个判据类管线
    //    lemeng.recon.preagg 只读湖不写湖，首撞。#447）
    const producers = pipelines.filter((p) => {
      try {
        /** @type {any} */
        const doc = JSON.parse(readFileSync(join(rootDir, p), 'utf8'))
        const nodes = Array.isArray(doc?.nodes) ? doc.nodes : []
        return nodes.some(
          /** @param {any} n */
          (n) =>
            typeof n?.data?.componentId === 'string' &&
            n.data.componentId.startsWith('snk.') &&
            JSON.stringify(n?.data?.properties ?? {}).includes(c.prefix),
        )
      } catch {
        return false
      }
    })
    if (producers.length === 0) {
      violations.push({
        file: rel,
        message: `找不到任何写着 \`${c.prefix}\` 的管线 —— 这张表没有生产者？契约 prefix 写错？`,
      })
    }
    for (const p of producers) {
      /** @type {any} */
      let doc
      try {
        doc = JSON.parse(readFileSync(join(rootDir, p), 'utf8'))
      } catch {
        violations.push({ file: p, message: '管线不是合法 JSON —— 无法核对' })
        continue
      }
      const nodes = Array.isArray(doc?.nodes) ? doc.nodes : []
      /** @type {{ id: string, aliases: string[], sql: string }[]} */
      const projections = []
      for (const n of nodes) {
        if (n?.data?.componentId !== 'code.sql') continue
        const sql = n?.data?.properties?.sql
        if (typeof sql !== 'string') continue
        const aliases = extractPipelineAliases(sql)
        if (aliases.length > 0) projections.push({ id: String(n?.id ?? ''), aliases, sql })
      }
      const hits = projections.filter((x) => x.aliases.join('\u0000') === c.columns.join('\u0000'))
      if (hits.length !== 1) {
        violations.push({
          file: p,
          message:
            `作为 \`${where}\` 的生产者，必须**恰好一个** \`code.sql\` 节点的输出列与契约逐列同序；` +
            `实测命中 ${hits.length} 个（候选列数：${projections.map((x) => x.aliases.length).join('/') || '无'}，契约 ${c.columns.length} 列）`,
        })
      } else {
        // ④ **申报面**：投影里引用的 `<输入别名>.<字段>` 必须都在 `src.rest` 节点的 `data.schema` 里。
        // 🔴 为什么这条非有不可：**空响应时引擎按「申报」构造关系**（非空响应才靠实际字段兜住）
        //    ⇒ 引用了没申报的字段会 `Binder Error`，而**平时完全看不出来**。
        //    2026-10-05 实测（#432 的教训）：只改了 flatten 的 SQL、没改申报 ⇒ 24 个窗口里
        //    **只有空窗失败**（23 个照常成功），报 `Values list "o" does not have a column named …`。
        // ⚠️ 判据是**逐个 src.rest 节点**，不是它们的并集：**任何一个**节点返回空，都会让引擎
        //    按**那个节点自己的申报**构造关系 ⇒ 只要有一个节点没申报，那条路就会 Binder Error。
        //    （第一版写成了并集，变异测试没变红——12 个节点只删一个，并集里还有，判据形同虚设。）
        const proj = hits[0]
        // ⚠️ 只查**投影真正吃的上游** `src.rest`（反向 BFS 沿 edges 走）。
        //    一把抓全部 src.rest 会误报：身份链上的 `w0`（whoami，申报只有 1 个字段）
        //    根本不喂投影，却被判「没申报」——2026-10-05 实测就是这么误报的两条维表管线。
        const edges = Array.isArray(doc?.edges) ? doc.edges : []
        /** @type {Map<string, string[]>} */
        const parents = new Map()
        for (const e of edges) {
          const t = String(e?.target ?? '')
          const sp = String(e?.source ?? '')
          if (!parents.has(t)) parents.set(t, [])
          parents.get(t)?.push(sp)
        }
        /** @type {Set<string>} */
        const anc = new Set()
        const stack = [...(parents.get(proj?.id ?? '') ?? [])]
        while (stack.length > 0) {
          const x = stack.pop() ?? ''
          if (anc.has(x)) continue
          anc.add(x)
          for (const y of parents.get(x) ?? []) stack.push(y)
        }
        // ⚠️ 但「上游」还不够：身份闸门是**控制父**（`dv → p1`，先证后采），它也在 ancestors 里，
        //    却根本不喂投影（`w0` = whoami，申报只有 1 个字段）。要点是**数据汇合点 `ctl.merge`**：
        //    只有它的直接父才是「喂给投影的那几路 REST」。2026-10-05 实测：不这么收会误报两条维表管线。
        const byId = new Map(nodes.map((/** @type {any} */ n) => [String(n?.id ?? ''), n]))
        /** @type {Set<string>} */
        const feederIds = new Set()
        for (const id of anc) {
          if (byId.get(id)?.data?.componentId !== 'ctl.merge') continue
          for (const sp of parents.get(id) ?? []) {
            if (byId.get(sp)?.data?.componentId === 'src.rest') feederIds.add(sp)
          }
        }
        const srcNodes = nodes.filter((/** @type {any} */ n) => feederIds.has(String(n?.id ?? '')))
        if (srcNodes.length > 0 && proj) {
          const m = /\bFROM\s+input\s+([a-z][a-z0-9_]*)\b/i.exec(proj.sql)
          const alias = m?.[1] ?? 'o'
          /** @type {Set<string>} */
          const refs = new Set()
          const re = new RegExp(`\\b${alias}\\.([a-z_][a-z0-9_]*)`, 'g')
          let mm
          while ((mm = re.exec(maskSqlComments(proj.sql))) !== null) refs.add(mm[1])
          /** @type {string[]} */
          const badNodes = []
          /** @type {Set<string>} */
          const missing = new Set()
          for (const sn of srcNodes) {
            const names = new Set((sn?.data?.schema ?? []).map((/** @type {any} */ f) => String(f?.name ?? '')))
            const und = [...refs].filter((f) => !names.has(f))
            if (und.length > 0) {
              badNodes.push(String(sn?.id ?? '?'))
              for (const f of und) missing.add(f)
            }
          }
          if (badNodes.length > 0) {
            violations.push({
              file: p,
              message:
                `投影节点引用 \`${alias}.<字段>\`，但有 ${badNodes.length}/${srcNodes.length} 个 \`src.rest\` 节点的 ` +
                `\`data.schema\` **没申报**：${[...missing].sort().join(', ')}（节点：${badNodes.slice(0, 6).join(', ')}${badNodes.length > 6 ? ' …' : ''}）` +
                ` ⇒ **空响应时**引擎按申报构造关系 ⇒ \`Binder Error\`；而**非空窗口照常成功**（实测 #432：24 窗只有空窗失败）。` +
                `修法：把缺的字段补进该文件**每一个** \`src.rest\` 节点。`,
            })
          }
        }
      }
    }

    // ③ 消费面：staging 投影（去掉注入列）必须是契约的**同序前缀**，并按 consumerVersion 定档
    const cv = c.consumerVersion
    if (typeof cv !== 'number' || !Number.isInteger(cv) || cv < 1) {
      violations.push({
        file: rel,
        message: `契约缺少合法的 consumerVersion（收到 ${JSON.stringify(cv)}）—— 它是「消费者已采纳到哪一版」，展开期靠它区分「还没迁移」与「漏改」。见 docs/architecture.md §5.2`,
      })
    } else if (svNum !== null && cv > svNum) {
      violations.push({
        file: rel,
        message: `consumerVersion(${cv}) > schemaVersion(${sv}) —— 消费者读的版本还不存在`,
      })
    }

    const stgRel = `dbt/models/common/staging/stg_${c.domain}_${c.table}.sql`
    if (!existsSync(join(rootDir, stgRel))) {
      violations.push({
        file: rel,
        message: `找不到对应 staging 模型 \`${stgRel}\` —— ③ 层是唯一碰原始类型的地方，不许跳过`,
      })
    } else {
      const aliases = extractStagingAliases(readFileSync(join(rootDir, stgRel), 'utf8')).filter(
        (a) => !INJECTED_STAGING_COLUMNS.includes(a),
      )
      const isPrefixOfContract = aliases.every((a, i) => c.columns[i] === a) && aliases.length <= c.columns.length
      if (!isPrefixOfContract) {
        const missing = c.columns.filter((x) => !aliases.includes(x))
        const extra = aliases.filter((x) => !c.columns.includes(x))
        violations.push({
          file: stgRel,
          message:
            `staging 投影必须是契约列的**同序前缀**（新列一律追加在末尾——见 docs/architecture.md §5.2）。` +
            `契约有而 staging 缺：${missing.join(', ') || '无'}；staging 有而契约无：${extra.join(', ') || '无'}；` +
            `列数 ${aliases.length} vs ${c.columns.length}`,
        })
      } else if (typeof cv === 'number' && svNum !== null && cv === svNum && aliases.length !== c.columns.length) {
        violations.push({
          file: stgRel,
          message:
            `consumerVersion == schemaVersion(${svNum}) 声明消费者已跟上，但 staging 只有 ${aliases.length}/${c.columns.length} 列` +
            `（缺 ${c.columns.slice(aliases.length).join(', ')}）—— 迁移没做完就改版本号`,
        })
      } else if (typeof cv === 'number' && svNum !== null && cv < svNum) {
        // 展开期：不是红，但**也不沉默**
        console.log(
          `${SCRIPT_NAME}: 展开期中 ${where} —— 生产者 v${svNum}、消费者 v${cv}（staging 落后 ${c.columns.length - aliases.length} 列：${c.columns
            .slice(aliases.length)
            .join(', ')}）；迁移（§5.2 的 migrate 步）未完成`,
        )
      }
    }
  }

  return violations
}

/**
 * CLI 入口。
 *
 * @param {string[]} argv
 * @returns {number} 退出码
 */
export function main(argv) {
  const root = argv[2] ?? process.cwd()
  const violations = checkDataContract(root)
  if (violations.length > 0) {
    console.error(`${SCRIPT_NAME}: 发现 ${violations.length} 条违规`)
    for (const v of violations) console.error(`  ✗ ${v.file}\n      ${v.message}`)
    console.error(
      '\n修法：以 contracts/**/*.json 为准，改齐管线的 `code.sql` 投影与 staging 投影；' +
        '口径与顺序见 docs/architecture.md §5.2。',
    )
    return 1
  }
  console.log(`${SCRIPT_NAME}: OK（契约 = 湖列集的唯一事实源；生产者与 staging 均已对齐）`)
  return 0
}

const invoked = process.argv[1] ? relative(process.cwd(), process.argv[1]).split(sep).join('/') : ''
if (invoked.endsWith(`scripts/${SCRIPT_NAME}.mjs`)) {
  process.exit(main(process.argv))
}
