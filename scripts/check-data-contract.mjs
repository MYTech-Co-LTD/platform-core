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
//
// ⚠️ 取列 / 解析契约 / 找生产者 / 找投影节点这五件事的实现已搬到 `scripts/lib/data-contract.mjs`
// ——门禁与 `scripts/gen-data-projection.mjs`（契约生成器）共用**同一份**，避免判据分叉。
// 本文件保留旧公开名（`maskSqlComments` / `extractPipelineAliases` / `extractStagingAliases` /
// `INJECTED_STAGING_COLUMNS`）原样 re-export，故既有测试与调用方一字不改。

import { existsSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import {
  CONTRACT_DIR,
  INJECTED_STAGING_COLUMNS,
  NON_CONTRACT,
  collectJson,
  extractPipelineAliases,
  extractStagingAliases,
  findProducerPipelines,
  findProjectionNode,
  maskSqlComments,
  readContractDoc,
} from './lib/data-contract.mjs'

/** 脚本名（输出前缀）。 */
export const SCRIPT_NAME = 'check-data-contract'

// 旧公开名原样 re-export —— `scripts/check-data-contract.test.ts` 直接 import 这三个，不许改它。
export { extractPipelineAliases, extractStagingAliases, INJECTED_STAGING_COLUMNS, maskSqlComments }

/**
 * @typedef {{ file: string, message: string }} Violation
 */

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

  for (const rel of contractFiles) {
    const c = readContractDoc(rootDir, rel)
    if (c === null) {
      violations.push({ file: rel, message: '契约不是合法 JSON —— 无法核对' })
      continue
    }
    const where = `${c.domain}/${c.table}`
    /** 契约列名序列——本门禁通篇按「名」比对（`readContractDoc` 的列是单形状对象，故取 `.name`）。 */
    const colNames = c.columns.map((x) => x.name)

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
    const producers = findProducerPipelines(rootDir, c.prefix)
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
      // 命中数由**调用方**复算（`findProjectionNode` 只回单个/ null，而报错文案要点名 0/≥2 命中）。
      const hits = projections.filter((x) => x.aliases.join('\u0000') === colNames.join('\u0000'))
      const proj = findProjectionNode(doc, colNames)
      if (hits.length !== 1) {
        violations.push({
          file: p,
          message:
            `作为 \`${where}\` 的生产者，必须**恰好一个** \`code.sql\` 节点的输出列与契约逐列同序；` +
            `实测命中 ${hits.length} 个（候选列数：${projections.map((x) => x.aliases.length).join('/') || '无'}，契约 ${colNames.length} 列）`,
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
        message: `consumerVersion(${cv}) > schemaVersion(${svNum}) —— 消费者读的版本还不存在`,
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
      const isPrefixOfContract = aliases.every((a, i) => colNames[i] === a) && aliases.length <= colNames.length
      if (!isPrefixOfContract) {
        const missing = colNames.filter((x) => !aliases.includes(x))
        const extra = aliases.filter((x) => !colNames.includes(x))
        violations.push({
          file: stgRel,
          message:
            `staging 投影必须是契约列的**同序前缀**（新列一律追加在末尾——见 docs/architecture.md §5.2）。` +
            `契约有而 staging 缺：${missing.join(', ') || '无'}；staging 有而契约无：${extra.join(', ') || '无'}；` +
            `列数 ${aliases.length} vs ${colNames.length}`,
        })
      } else if (typeof cv === 'number' && svNum !== null && cv === svNum && aliases.length !== colNames.length) {
        violations.push({
          file: stgRel,
          message:
            `consumerVersion == schemaVersion(${svNum}) 声明消费者已跟上，但 staging 只有 ${aliases.length}/${colNames.length} 列` +
            `（缺 ${colNames.slice(aliases.length).join(', ')}）—— 迁移没做完就改版本号`,
        })
      } else if (typeof cv === 'number' && svNum !== null && cv < svNum) {
        // 展开期：不是红，但**也不沉默**
        console.log(
          `${SCRIPT_NAME}: 展开期中 ${where} —— 生产者 v${svNum}、消费者 v${cv}（staging 落后 ${colNames.length - aliases.length} 列：${colNames
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
