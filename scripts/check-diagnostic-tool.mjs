#!/usr/bin/env node
// scripts/check-diagnostic-tool.mjs — 只读诊断工具（`scripts/lemeng/diagnose.sh`）的**静态**门禁（P7 裁决）。
//
// 用法：`pnpm exec tsx scripts/check-diagnostic-tool.mjs [rootDir]`（rootDir 默认仓根，测试用夹具）。
// 纯静态：不连库、不取网络、不起容器。
// 契约：干净 → exit 0，stdout 一行 `check-diagnostic-tool: OK（…）`；
//       有违规 → exit 1，stderr 逐条点名（判据 + 怎么修）；
//       跑不起来（清单缺失/读不出）→ exit 2，响亮失败，绝不静默跳过。
//
// ── 它盯的是哪条**今天没有任何门禁**盯的耦合（P7 的原始动机）────────────────────
// `recon` 的容量闸 `RECON_PAGES=12` 与网关调用形状（URL / body 键 / `page_size`）**不是它的私有
// 常量**：事实源是**在用的** L1 子管线 `deploy/duckle/console/pipelines/lemeng.retail_order_line.window.json`
// 的 12 个 `src.rest` 节点（🔴 2026-09-29 改向：原先指 `duckle/common/lemeng.retail_order_line.json`——
// 那是**已退役**的内层重管线，指它会让「删退役件」与「门禁事实源」互相卡死）
// （`paginationType:none` + 12 节点硬扇出，每节点 body 里写死自己的 `page_number`/`page_size`）。
// ⇒ **管线分了 13 页、工具还按 12 页翻** ⇒ 末页守卫永不触发 ⇒ 网关侧**悄悄少算**一页的数据，
// 而工具会报一张看着很正常的 `RECON bizday=… lake_rows=… gateway_rows=…`。这是**静默错**：
// 退出码、字面量、人眼全都正常，只有数字错了。
//
// ── 判据（六条，各自独立）──────────────────────────────────────────────────────
//   ① 工具在场且**带可执行位**（`sh <path>` 之前先得能执行）；
//   ② `deploy/data-plane-manifest.txt` 有它的落地条目、且模式 **0755**
//      （没登记 ⇒ 永不投递到机器；登记成 0644 ⇒ 落了盘也不可执行 = 没有工具）；
//   ③ **E6 退出码契约字面量在场**（`RECON_OK` / `RECON_FAILED:…` 七个面）——
//      执行单与巡检 grep 的就是它们，改文案 = 悄悄打断依赖方；
//   ④ **E1 湖侧 SQL 形状**：点名单文件、写 `s3://`、**不得带 `hive_partitioning`**
//      （路径里的 `hour=NN` 与载荷列 `hour` 同名 ⇒ 分区列会遮蔽载荷列，口径就变了）；
//   ⑤ **容量闸同源**：`RECON_PAGES` == 管线 `src.rest` 节点数、`RECON_PAGE_SIZE` == 管线
//      每个 `src.rest` 的 `page_size`（且节点之间必须一致）；
//   ⑥ **网关 body 键集合同源**：工具那条 `curl -d` 模板的键集合必须与管线 body 模板**完全一致**
//      （多一个/少一个键 ⇒ 两侧问的不是同一件事，容差 0 的"0"就失去意义）。
//
// ⚠️ **不剥注释**（本仓 B9 的教训）：判据 ④ 按**行**判（只判含 `read_parquet(` 的代码行），
//    所以注释里出现 `hive_partitioning` 这个词**不会**误报；但**代码行**里出现即红。
//    这样既不放过真回归，也不把「解释为什么不能这么做」的注释当成违规。
// ⚠️ **覆盖边界**：只盯 `deploy/duckle/console/pipelines/lemeng.retail_order_line.window.json`**这一份**。
//    同一个 console 目录里还有**其它**管线（`lemeng.dim.*.l0` 等），本门禁**不**逐个比它们的形状；
//    观测面命名那一面由 `scripts/check-duckle-catalog.mjs` 守——两处都改才算改完，本门禁看不见后者。
//    ⚠️ 内层重管线 `duckle/common/*.json` 已**退役**（两账套均切 L0/L1）⇒ 本门禁**不再**以它为事实源。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { MANIFEST_PATH, parseManifest } from './lemeng/data-plane-lock.mjs'

/** 脚本名（输出前缀）。 */
export const SCRIPT_NAME = 'check-diagnostic-tool'
/** 工具的仓内路径（唯一事实源；改这里 = 改门禁的瞄准点）。 */
export const TOOL_PATH = 'scripts/lemeng/diagnose.sh'
/** 网关调用形状的事实源（管线定义）。 */
export const PIPELINE_PATH = 'deploy/duckle/console/pipelines/lemeng.retail_order_line.window.json'
/** E6：退出码契约里**必须逐字在场**的字面量（`RECON_FAILED:` 的七个失败面 + 通过面）。 */
export const E6_LITERALS = [
  'RECON_OK',
  'RECON_FAILED:lake',
  'RECON_FAILED:gateway',
  'RECON_FAILED:rows',
  'RECON_FAILED:batches',
  'RECON_FAILED:hour',
  'RECON_FAILED:hour_open',
]
/** 落地模式：可执行（`sh <path>`）。 */
const EXEC_MODE = '0755'

const PAGES_RE = /^RECON_PAGES=(\d+)/m
const PAGE_SIZE_RE = /^RECON_PAGE_SIZE=(\d+)/m
/** JSON 模板里的键名——两侧都带 `\"` 转义（shell 双引号串里），故转义可选。 */
const BODY_KEY_RE = /\\?"([a-z_]+)\\?"\s*:/g

/** 八进制显示（消息里给人看）。 @param {number} mode @returns {string} */
function oct(mode) {
  return `0${mode.toString(8)}`
}

/** 从一段 JSON 模板文本里抽出键名集合。 @param {string} text @returns {Set<string>} */
function keysOf(text) {
  const out = new Set()
  for (const m of text.matchAll(BODY_KEY_RE)) if (m[1] !== undefined) out.add(m[1])
  return out
}

/** `page_size` 数值；读不到 → null。 @param {string} body @returns {number | null} */
function pageSizeOf(body) {
  const m = /"page_size"\s*:\s*(\d+)/.exec(body)
  return m?.[1] === undefined ? null : Number(m[1])
}

/** `page_number` 数值；读不到 → null。 @param {string} body @returns {number | null} */
function pageNumberOf(body) {
  const m = /"page_number"\s*:\s*(\d+)/.exec(body)
  return m?.[1] === undefined ? null : Number(m[1])
}

/**
 * 跑全部判据，返回违规表（空 = 干净）。
 * @param {string} rootDir 仓根绝对路径
 * @returns {Array<{ file: string, message: string }>} 违规（单形状：字段恒在）
 */
export function findViolations(rootDir) {
  /** @type {Array<{ file: string, message: string }>} */
  const violations = []

  const toolAbs = join(rootDir, TOOL_PATH)
  if (!existsSync(toolAbs)) {
    return [
      {
        file: TOOL_PATH,
        message: '只读诊断工具不在场——P1 的落点就是它（`scripts/lemeng/diagnose.sh`）；删了它 = 删了 `recon` 的替代面',
      },
    ]
  }
  const tool = readFileSync(toolAbs, 'utf8')

  // 判据 ①：可执行位
  const mode = statSync(toolAbs).mode & 0o777
  if ((mode & 0o111) === 0) {
    violations.push({
      file: TOOL_PATH,
      message: `缺可执行位（当前 ${oct(mode)}）——机器上要能 \`sh <path>\` 直接跑；\`chmod +x\` 后提交（git 记录该位）`,
    })
  }

  // 判据 ②：清单落地条目 + 0755
  const manifestAbs = join(rootDir, MANIFEST_PATH)
  if (!existsSync(manifestAbs)) {
    return [{ file: MANIFEST_PATH, message: '清单不存在（SOP §E.3 ① 的正典落点就是它）' }]
  }
  /** @type {import('./lemeng/data-plane-lock.mjs').ManifestEntry[]} */
  let entries
  try {
    entries = parseManifest(readFileSync(manifestAbs, 'utf8'))
  } catch (err) {
    return [{ file: MANIFEST_PATH, message: err instanceof Error ? err.message : String(err) }]
  }
  const entry = entries.find((e) => e.repoPath === TOOL_PATH)
  if (entry === undefined) {
    violations.push({
      file: MANIFEST_PATH,
      message:
        `没有 ${TOOL_PATH} 的落地条目 ⇒ 这份工具**永远不会被投递到机器上**` +
        `（新增仓内工件必须登记：仓内路径 / 落地路径 / 模式 0755），改完重跑 data-plane-lock.mjs`,
    })
  } else if (entry.mode !== EXEC_MODE) {
    violations.push({
      file: MANIFEST_PATH,
      message: `${TOOL_PATH} 的落地模式是 ${entry.mode}，应为 ${EXEC_MODE}——落了盘却不可执行 = 没有工具`,
    })
  }

  // 判据 ③：E6 字面量在场
  const missingLiterals = E6_LITERALS.filter((l) => !tool.includes(l))
  if (missingLiterals.length > 0) {
    violations.push({
      file: TOOL_PATH,
      message:
        `退出码契约字面量缺失：${missingLiterals.join(' / ')}` +
        ` ——执行单与巡检 grep 的就是它们（E6：逐字保留），改文案等于悄悄打断依赖方`,
    })
  }

  // 判据 ④：E1 湖侧 SQL 形状（按**含 read_parquet( 的代码行**判，注释不误报）
  const sqlLines = tool
    .split('\n')
    .map((line, i) => /** @type {[number, string]} */ ([i + 1, line]))
    .filter(([, line]) => line.includes('read_parquet('))
  if (sqlLines.length === 0) {
    violations.push({ file: TOOL_PATH, message: '找不到任何 `read_parquet(` ——湖侧读法不见了？（E1）' })
  } else {
    if (!sqlLines.some(([, line]) => line.includes("'s3://"))) {
      violations.push({
        file: TOOL_PATH,
        message:
          "湖侧 SQL 没写 `s3://` ——`minio://` 是引擎的标签前缀、不是 DuckDB 认的 scheme，" +
          '照抄进 SQL 会被静默当路径模式（报 No files found）',
      })
    }
    for (const [lineNo, line] of sqlLines) {
      if (line.includes('hive_partitioning')) {
        violations.push({
          file: TOOL_PATH,
          message:
            `第 ${lineNo} 行的湖侧 SQL 带了 hive_partitioning ——路径里的 hour=NN 与载荷列 hour 同名，` +
            '分区列会遮蔽载荷列（E1 明文禁止；单文件精读才只来自载荷本身）',
        })
      }
    }
  }

  // 判据 ⑤⑥：与管线耦合——容量闸同数 + body 键集合同源
  const pagesM = PAGES_RE.exec(tool)
  const sizeM = PAGE_SIZE_RE.exec(tool)
  if (pagesM?.[1] === undefined) {
    violations.push({ file: TOOL_PATH, message: '读不到 `RECON_PAGES=<n>` ——容量闸常量不见了（判据 ⑤ 无从比）' })
  }
  if (sizeM?.[1] === undefined) {
    violations.push({ file: TOOL_PATH, message: '读不到 `RECON_PAGE_SIZE=<n>` ——分页大小常量不见了（判据 ⑤ 无从比）' })
  }

  const pipelineAbs = join(rootDir, PIPELINE_PATH)
  if (!existsSync(pipelineAbs)) {
    violations.push({ file: PIPELINE_PATH, message: '网关调用形状的事实源（管线定义）不在场——判据 ⑤⑥ 无从比' })
    return sortViolations(violations)
  }
  /** @type {{ nodes?: Array<{ data?: { componentId?: string, properties?: { body?: string } } }> }} */
  let doc
  try {
    doc = /** @type {typeof doc} */ (JSON.parse(readFileSync(pipelineAbs, 'utf8')))
  } catch (err) {
    violations.push({ file: PIPELINE_PATH, message: `不是合法 JSON：${err instanceof Error ? err.message : String(err)}` })
    return sortViolations(violations)
  }
  const restNodes = (doc.nodes ?? []).filter((n) => n.data?.componentId === 'src.rest')
  if (restNodes.length === 0) {
    violations.push({
      file: PIPELINE_PATH,
      message: '一个 `src.rest` 节点都没有——分页形状的事实源没了（判据 ⑤⑥ 比不了；是改名了还是搬走了？）',
    })
    return sortViolations(violations)
  }

  const bodies = restNodes.map((n) => n.data?.properties?.body ?? '')
  const sizes = new Set(bodies.map(pageSizeOf))
  if (sizes.has(null)) {
    violations.push({ file: PIPELINE_PATH, message: '有 `src.rest` 节点的 body 里读不到 `page_size` ——形状变了' })
  }
  if (sizes.size > 1) {
    violations.push({
      file: PIPELINE_PATH,
      message: `节点之间 \`page_size\` 不一致（${[...sizes].join(' / ')}）——容量闸口径就是 \`页数 × page_size\`，不一致则算不出来`,
    })
  }
  const pipelineSize = [...sizes][0] ?? null
  if (sizeM?.[1] !== undefined && pipelineSize !== null && Number(sizeM[1]) !== pipelineSize) {
    violations.push({
      file: TOOL_PATH,
      message:
        `RECON_PAGE_SIZE=${sizeM[1]} 与管线 page_size=${pipelineSize} **不同源**` +
        ' ——两侧必须在同一次改动里一起改（工具头注点名的耦合）',
    })
  }
  if (pagesM?.[1] !== undefined && Number(pagesM[1]) !== restNodes.length) {
    violations.push({
      file: TOOL_PATH,
      message:
        `RECON_PAGES=${pagesM[1]} 与管线 src.rest 节点数=${restNodes.length} **不同源**` +
        ' ——改了管线分页形状却忘了同步常量 ⇒ 末页容量守卫永不触发，网关侧悄悄少算；' +
        `两侧一起改（管线 ${PIPELINE_PATH} ↔ 工具 ${TOOL_PATH}）`,
    })
  }

  const pageNumbers = bodies.map(pageNumberOf)
  const dupOrGap =
    pageNumbers.some((p) => p === null) ||
    new Set(pageNumbers).size !== pageNumbers.length ||
    [...pageNumbers].sort((a, b) => /** @type {number} */ (a) - /** @type {number} */ (b)).some((p, i) => p !== i + 1)
  if (dupOrGap) {
    violations.push({
      file: PIPELINE_PATH,
      message: `src.rest 节点的 \`page_number\` 不是恰好 1..${restNodes.length}（实得 ${pageNumbers.join(',')}）——硬扇出的页序被改坏了`,
    })
  }

  // 判据 ⑥：body 键集合同源
  const pipeKeys = keysOf(bodies[0] ?? '')
  const gwLine = tool.split('\n').find((line) => line.includes('date_from') && line.includes('page_size'))
  if (gwLine === undefined) {
    violations.push({
      file: TOOL_PATH,
      message: '找不到网关 body 模板行（同时含 `date_from` 与 `page_size` 的那行）——判据 ⑥ 无从比',
    })
  } else {
    const toolKeys = keysOf(gwLine)
    const missing = [...pipeKeys].filter((k) => !toolKeys.has(k))
    const extra = [...toolKeys].filter((k) => !pipeKeys.has(k))
    if (missing.length > 0 || extra.length > 0) {
      violations.push({
        file: TOOL_PATH,
        message:
          `网关 body 键集合与管线不同源：缺 [${missing.join(', ')}]、多 [${extra.join(', ')}]` +
          ' ——两侧问的不是同一件事，「容差 0」的 0 就失去意义',
      })
    }
  }

  return sortViolations(violations)
}

/**
 * 稳定排序（同一文件内按消息）。
 * @param {Array<{ file: string, message: string }>} violations @returns {Array<{ file: string, message: string }>}
 */
function sortViolations(violations) {
  return violations.sort((a, b) =>
    a.file === b.file ? a.message.localeCompare(b.message) : a.file.localeCompare(b.file),
  )
}

/** CLI 入口。 @returns {void} */
function main() {
  const rootDir = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url))
  const violations = findViolations(rootDir)
  if (violations.length > 0) {
    console.error(`${SCRIPT_NAME}: ${violations.length} 处违规`)
    for (const v of violations) console.error(`  ${v.file}: ${v.message}`)
    process.exit(1)
  }
  console.log(`${SCRIPT_NAME}: OK（${TOOL_PATH} 与 ${PIPELINE_PATH} 的分页形状同源）`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
