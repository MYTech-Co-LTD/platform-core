// scripts/check-console-alerts.test.ts — 告警覆盖门禁（#565）的 fixtures 测试。
//
// **全部黑盒**：spawn CLI、断言退出码与输出行（与 check-data-plane-lock.test.ts 同风格——
// 门禁的对外契约就是这两样），夹具落在系统临时目录，与真实仓库完全隔离。最后一组反过来钉住
// 「真实仓必须干净」（exit 0），防的是「机制落码了、规则集却是老形状」。
//
// 本文件里最要紧的一条是 **case「变异：pre-fix 规则集」**——它就是把 2026-10-10 那个静默
// （`lemeng.dim.item_price.l0.3120` 失败、群里一声不响）固化成的回归夹具：规则集退回补丁前，
// 门禁必须**点名那四条 `.3120` 管线**。没有这条，本门禁就只是个「看起来在检查」的摆设。
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const GUARD = join(repoRoot, 'scripts/check-console-alerts.mjs')

interface RunResult {
  status: number
  stdout: string
  stderr: string
}

const tmpRoots: string[] = []

/** 建一个临时夹具（files: 相对路径 → 内容）。 */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'platform-guard-alerts-'))
  tmpRoots.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

/** 跑守卫（纯 ESM，node 入口与 `tsx <x>.mjs` 同）。 */
function guard(root: string): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [GUARD, '--root', root], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

/** 一条真形状的规则（与 alerts.lemeng.json 的键集/顺序一致：match, on, cooldownMinutes, channel, url, headers）。 */
function rule(match: string, on?: string[]): Record<string, unknown> {
  const r: Record<string, unknown> = { match }
  if (on !== undefined) r.on = on
  r.cooldownMinutes = 15
  r.channel = 'webhook'
  r.url = '${ENV:OO_BASE}/api/${ENV:OO_ORG}/data_alerts/_json'
  r.headers = { Authorization: 'Basic ${ENV:OO_AUTH}' }
  return r
}

/** 管线文件（守卫只取文件名当 id；`name == stem` 归 #531 那条管，这里给个真形状即可）。 */
const pipeline = (stem: string): string => JSON.stringify({ name: stem, nodes: [], edges: [] })

const schedule = (ids: string[]): string =>
  JSON.stringify(ids.map((pipeline_id) => ({ id: `panel-${pipeline_id}`, pipeline_id, enabled: true })))

/** 基线夹具：**补丁后**的规则形状（含 `lemeng.*.l0.3120`），覆盖全部被调度管线。 */
const BASE_FILES: Record<string, string> = {
  'pipelines/lemeng.dim.branch.l0.json': pipeline('lemeng.dim.branch.l0'),
  'pipelines/lemeng.dim.item.l0.json': pipeline('lemeng.dim.item.l0'),
  'pipelines/lemeng.dim.item_price.l0.3120.json': pipeline('lemeng.dim.item_price.l0.3120'),
  'pipelines/lemeng.recon.preagg.json': pipeline('lemeng.recon.preagg'),
  'schedules/3120.json': schedule([
    'lemeng.dim.branch.l0',
    'lemeng.dim.item.l0',
    'lemeng.dim.item_price.l0.3120',
    'lemeng.recon.preagg',
  ]),
  'alerts.lemeng.json': JSON.stringify({
    rules: [
      rule('*', ['stale', 'refreshed']),
      rule('lemeng.dim.*.l0'),
      rule('lemeng.*.l0.3120'),
      rule('lemeng.recon.*'),
    ],
  }),
}

/** 在基线夹具上覆盖某个文件。 */
function withFile(base: Record<string, string>, rel: string, content: string): Record<string, string> {
  return { ...base, [rel]: content }
}

afterAll(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true })
})

describe('check-console-alerts：基线', () => {
  it('规则集覆盖全部被调度管线时干净（exit 0）', () => {
    const r = guard(fixture(BASE_FILES))
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('enabled 受检 4 条')
    expect(r.stdout).toContain('豁免 无')
  })

  it('**变异：pre-fix 规则集** ⇒ 必红，且点名那条出事的管线（本案回归夹具）', () => {
    // 去掉 `lemeng.*.l0.3120`（= PR #562 补的那条），退回事故当天凌晨的规则形状。
    const files = withFile(
      BASE_FILES,
      'alerts.lemeng.json',
      JSON.stringify({ rules: [rule('*', ['stale', 'refreshed']), rule('lemeng.dim.*.l0'), rule('lemeng.recon.*')] }),
    )
    const r = guard(fixture(files))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('ALERT_COVERAGE_FAILED:')
    expect(r.stderr).toContain('lemeng.dim.item_price.l0.3120')
    expect(r.stderr).toContain('无含 failure 的规则覆盖')
    // 反面：被 `lemeng.dim.*.l0` 覆盖的那两条不该被点名（门禁要精确，不是一红全红）。
    expect(r.stderr).not.toContain('管线 lemeng.dim.branch.l0')
    expect(r.stderr).not.toContain('管线 lemeng.dim.item.l0 ')
  })
})

describe('check-console-alerts：判据 A（文件完整性）', () => {
  it('规则缺 channel ⇒ 必红（整个文件作废，不是少一条）', () => {
    const bad = rule('lemeng.dim.*.l0')
    delete bad.channel
    const files = withFile(
      BASE_FILES,
      'alerts.lemeng.json',
      JSON.stringify({ rules: [bad, rule('lemeng.*.l0.3120'), rule('lemeng.recon.*')] }),
    )
    const r = guard(fixture(files))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('缺 channel')
    expect(r.stderr).toContain('整个文件作废')
  })

  it('on 里的事件名不在引擎事件集（如大写 Failure）⇒ 必红', () => {
    const files = withFile(
      BASE_FILES,
      'alerts.lemeng.json',
      JSON.stringify({
        rules: [rule('lemeng.dim.*.l0', ['Failure']), rule('lemeng.*.l0.3120'), rule('lemeng.recon.*')],
      }),
    )
    const r = guard(fixture(files))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('含未知事件')
  })
})

describe('check-console-alerts：判据 B/C（覆盖与死规则）', () => {
  it('排班引用的源没有 alerts.<源>.json ⇒ 必红（该源全线无告警）', () => {
    const files = {
      ...BASE_FILES,
      'pipelines/other.thing.l0.json': pipeline('other.thing.l0'),
      'schedules/3120.json': schedule([
        'lemeng.dim.branch.l0',
        'lemeng.dim.item.l0',
        'lemeng.dim.item_price.l0.3120',
        'lemeng.recon.preagg',
        'other.thing.l0',
      ]),
    }
    const r = guard(fixture(files))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('无同源告警文件 alerts.other.json')
  })

  it('死规则（match 拼错、命中不到任何已知管线 id）⇒ 必红', () => {
    const files = withFile(
      BASE_FILES,
      'alerts.lemeng.json',
      JSON.stringify({
        rules: [
          rule('*', ['stale', 'refreshed']),
          rule('lemeng.dim.*.l0'),
          rule('lemeng.*.l0.3120'),
          rule('lemeng.recon.*'),
          rule('lemeng.dim.typo.l9'),
        ],
      }),
    )
    const r = guard(fixture(files))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('命中不到任何已知管线 id')
    expect(r.stderr).toContain('lemeng.dim.typo.l9')
  })

  it('裸 `*`（on 不含 failure 的宽规则）不参与判据 C —— 它本来就该命中一切', () => {
    const files = withFile(
      BASE_FILES,
      'alerts.lemeng.json',
      JSON.stringify({
        rules: [rule('*', ['stale', 'refreshed']), rule('lemeng.dim.*.l0'), rule('lemeng.*.l0.3120'), rule('lemeng.recon.*')],
      }),
    )
    expect(guard(fixture(files)).status).toBe(0)
  })
})

describe('check-console-alerts：glob 语义（按引擎实测钉住）', () => {
  it('`*` 跨 `.`：四段的管线 id 被三段的 `lemeng.recon.*` 覆盖（引擎台账实证形状）', () => {
    const files = {
      'pipelines/lemeng.recon.preagg.item.json': pipeline('lemeng.recon.preagg.item'),
      'schedules/3120.json': schedule(['lemeng.recon.preagg.item']),
      'alerts.lemeng.json': JSON.stringify({ rules: [rule('lemeng.recon.*')] }),
    }
    const r = guard(fixture(files))
    expect(r.status).toBe(0)
  })

  it('`lemeng.dim.*.l0` 覆盖 `lemeng.dim.<任意段>.l0`，但覆盖不到带账套号后缀的 `.l0.3120`', () => {
    const files = {
      'pipelines/lemeng.dim.alerttest.l0.json': pipeline('lemeng.dim.alerttest.l0'),
      'pipelines/lemeng.dim.item_price.l0.3120.json': pipeline('lemeng.dim.item_price.l0.3120'),
      'schedules/3120.json': schedule(['lemeng.dim.alerttest.l0', 'lemeng.dim.item_price.l0.3120']),
      'alerts.lemeng.json': JSON.stringify({ rules: [rule('lemeng.dim.*.l0'), rule('lemeng.*.l0.3120')] }),
    }
    expect(guard(fixture(files)).status).toBe(0)

    // 同一夹具、只去掉 `.3120` 那条 ⇒ 恰好只剩后缀那条红（形态末段分组覆盖不到后缀 id 的本质）。
    const without = { ...files, 'alerts.lemeng.json': JSON.stringify({ rules: [rule('lemeng.dim.*.l0')] }) }
    const r = guard(fixture(without))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('lemeng.dim.item_price.l0.3120')
    expect(r.stderr).not.toContain('管线 lemeng.dim.alerttest.l0 ')
  })
})

describe('check-console-alerts：真实仓', () => {
  it('仓内正典 console（deploy/duckle/console）干净', () => {
    const r = guard(join(repoRoot, 'deploy/duckle/console'))
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('check-console-alerts: OK')
  })
})
