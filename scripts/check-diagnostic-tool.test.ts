// scripts/check-diagnostic-tool.test.ts — 只读诊断工具静态门禁（P7）的 fixtures 测试。
//
// **黑盒**：spawn 守卫 CLI（`node check-diagnostic-tool.mjs <rootDir>`）、断言退出码与输出
// （与 check-data-plane-lock.test.ts / check-duckle-catalog.test.ts 同形）。
//
// 为什么这条守卫必须有**能红**的证明：「守卫不红等于没有守卫」，而它最容易失效的地方正是
// **它声称盯住的那条耦合**（真的比了 RECON_PAGES 与管线节点数吗？还是只比了个空集合）。
// ⇒ 每个判据都配一个**只违反它一条**的反例夹具，证明红是那条判据打出来的。
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const GUARD = join(repoRoot, 'scripts/check-diagnostic-tool.mjs')

interface RunResult {
  status: number
  stdout: string
  stderr: string
}

const tmpRoots: string[] = []

afterAll(() => {
  for (const r of tmpRoots) rmSync(r, { recursive: true, force: true })
})

/** 跑守卫；`rootDir` 由 argv 传入（守卫默认仓根，测试一律传夹具）。 */
function guard(rootDir: string): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [GUARD, rootDir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

/** 诊断工具夹具源码：字段恒在（单形状），只有 opts 指到的那处不同。 */
function toolSrc(
  opts: { pages?: number; pageSize?: number; dropLiteral?: string; hive?: boolean } = {},
): string {
  const literals = [
    'RECON_OK',
    'RECON_FAILED:lake',
    'RECON_FAILED:gateway',
    'RECON_FAILED:rows',
    'RECON_FAILED:batches',
    'RECON_FAILED:hour',
    'RECON_FAILED:hour_open',
  ].filter((l) => l !== opts.dropLiteral)
  const gwBody =
    '\\"branch_nums\\": $BRANCH_NUMS, \\"date_from\\": \\"$2\\", \\"date_to\\": \\"$2\\", ' +
    '\\"time_from\\": \\"$3:00:00\\", \\"time_to\\": \\"$3:59:59\\", \\"page_number\\": $1, ' +
    `\\"page_size\\": ${opts.pageSize ?? 200}`
  return [
    '#!/bin/sh',
    `RECON_PAGES=${opts.pages ?? 12}`,
    `RECON_PAGE_SIZE=${opts.pageSize ?? 200}`,
    'lake_read_sql() {',
    `  printf "%s\\n" "SELECT count(*) FROM read_parquet('s3://b/lemeng/x/system_book=%s/bizday=%s/hour=%s/all.parquet')${opts.hive ? ', hive_partitioning=1' : ''};"`,
    '}',
    'recon_gw_page() {',
    `  curl -d "{${gwBody}}"`,
    '}',
    ...literals.map((l) => `echo "${l}"`),
    '',
  ].join('\n')
}

/** 管线夹具：N 个 src.rest 节点，body 与工具同源（唯一事实源）。 */
function pipelineSrc(opts: { nodes?: number; pageSize?: number } = {}): string {
  const nodes = opts.nodes ?? 12
  const pageSize = opts.pageSize ?? 200
  const list = []
  for (let i = 1; i <= nodes; i += 1) {
    const body =
      `{"branch_nums": \${ENV:BRANCH_NUMS}, "date_from": "\${ENV:BIZDAY}", "date_to": "\${ENV:BIZDAY}", ` +
      `"time_from": "\${ENV:HOUR_FROM}", "time_to": "\${ENV:HOUR_TO}", "page_number": ${i}, "page_size": ${pageSize}}`
    list.push({
      id: `p${i}`,
      data: { componentId: 'src.rest', properties: { body, responsePath: '/result', paginationType: 'none' } },
    })
  }
  return JSON.stringify({ name: 'lemeng.retail_order_line', nodes: list, edges: [] })
}

const MANIFEST = [
  '# 夹具清单',
  'deploy/data-compose.yml      ${REPO}/deploy/data-compose.yml      0644',
  'scripts/lemeng/diagnose.sh   /opt/lemeng-diagnose.sh               0755',
  '',
].join('\n')

/** 建夹具；`over` 覆盖任意一件工件的文本，或把它整个删掉。 */
function fixture(
  over: { tool?: string | null; pipeline?: string; manifest?: string } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), 'platform-guard-diag-'))
  tmpRoots.push(root)
  // ⚠️ 用 `in` 判「这处被覆盖了吗」，不用 `??`：`null ?? x` 会回落到 x，**代表"删掉它"的 null
  //    会被当成"没覆盖"** ⇒ 「工具不存在」那条用例会静默退化成「工具正常」，假绿。
  const files: Array<[string, string | null]> = [
    ['scripts/lemeng/diagnose.sh', 'tool' in over ? (over.tool ?? null) : toolSrc()],
    ['deploy/duckle/console/pipelines/lemeng.retail_order_line.window.json', 'pipeline' in over ? (over.pipeline ?? null) : pipelineSrc()],
    ['deploy/data-plane-manifest.txt', 'manifest' in over ? (over.manifest ?? null) : MANIFEST],
  ]
  for (const [rel, content] of files) {
    if (content === null) continue
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
    if (rel.endsWith('.sh')) chmodSync(abs, 0o755)
  }
  return root
}

describe('check-diagnostic-tool：静态门禁', () => {
  it('一致 ⇒ exit 0', () => {
    const r = guard(fixture())
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('check-diagnostic-tool: OK')
  })

  it('工具不存在 ⇒ 红（不是静默通过）', () => {
    const r = guard(fixture({ tool: null }))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('diagnose.sh')
  })

  it('P7 的核心：管线多了/少了一页、工具常量没跟 ⇒ 红（这条耦合今天没有任何门禁盯）', () => {
    const r = guard(fixture({ pipeline: pipelineSrc({ nodes: 11 }) }))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('RECON_PAGES')
  })

  it('page_size 不同源 ⇒ 红', () => {
    const r = guard(fixture({ pipeline: pipelineSrc({ pageSize: 100 }) }))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('RECON_PAGE_SIZE')
  })

  it('E6 字面量缺一个 ⇒ 红（退出码契约是执行单/巡检的实际依赖）', () => {
    const r = guard(fixture({ tool: toolSrc({ dropLiteral: 'RECON_FAILED:hour_open' }) }))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('RECON_FAILED:hour_open')
  })

  it('湖侧 SQL 用了 hive 分区列 ⇒ 红（hour 会被分区列遮蔽，E1 明文禁止）', () => {
    const r = guard(fixture({ tool: toolSrc({ hive: true }) }))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('hive_partitioning')
  })

  it('清单没登记（落地映射缺失）⇒ 红', () => {
    const r = guard(
      fixture({ manifest: MANIFEST.replace('scripts/lemeng/diagnose.sh   /opt/lemeng-diagnose.sh               0755\n', '') }),
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('data-plane-manifest.txt')
  })

  it('清单登记了但模式不是 0755 ⇒ 红（落了盘却不可执行 = 没有工具）', () => {
    const r = guard(fixture({ manifest: MANIFEST.replace('0755\n', '0644\n') }))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('0755')
  })

  it('真仓必须干净（机制落码了、仓里却是坏的 = 最坏的一种绿）', () => {
    const r = guard(repoRoot)
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })
})
