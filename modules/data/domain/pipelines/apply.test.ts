// apply.test.ts —— apply_pipeline_proposal 的闸与映射：白名单、重校验、seam、outcome→payload。
// W3 Task 2 起，白名单四档（contracts/**.json、pipelines/**.json、l1_metrics.yml 精确单文件、
// dbt/tests/**.sql），YAML/SQL 两档各有内容重校验（比对基准 = repoRoot 注入的夹具现行文件）。
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { verdictOf } from '../../routes/mcp-pipeline-tools'
import { applyPipelineProposalImpl } from './apply'
import { createProposalApplier, type ProposalApplyOutcome } from './proposal-apply'
import { composeMetricDeclaration, SEMANTICS_YAML_REL } from './propose-metric'
import type { PipelineRoots } from './defs'
import type { PipelineDeps } from './types'

// 契约 piece 必须真的过得了 validateContractDraft（owner/layout/batch/非空 columns），
// 否则闸在重校验就拒了，seam 与 outcome 映射根本测不到（fixture 对齐 validate.test.ts 的 goodContract）。
const goodPiece = {
  path: 'contracts/common/x.y.json',
  content: '{"contractVersion":2,"id":"x.y","domain":"x","table":"y","owner":"data-platform","source":{"system":"s","layer":"raw"},"grain":[],"layout":{"prefix":"x/y","partitionStyle":"hive","partitionBy":["bizday"],"fileName":"all.parquet"},"batch":{"markerColumn":"batch_id","type":"varchar","unique":false},"columns":[{"name":"batch_id","type":"varchar","nullable":false}]}\n',
}

const proposal = {
  status: 'ok', title: '加字段', rationale: '需要新列', branch: 'proposal/jia-zi-duan',
  pieces: [goodPiece], downstream: [], validation: [],
}

const depsWith = (apply: PipelineDeps['apply'], roots: Partial<PipelineRoots> = {}): PipelineDeps =>
  ({ roots: { pipelinesRoot: '/nope', contractsRoot: '/nope', ...roots }, runs: null, env: {}, sandbox: null, apply })

/** 假 applier：回放 outcome 或断言「不该被调到」。 */
const applierOf = (outcome: ProposalApplyOutcome) => {
  let calls = 0
  const applier = { apply: async () => { calls += 1; return outcome } }
  return { applier: applier as unknown as PipelineDeps['apply'], calls: () => calls }
}

describe('apply_pipeline_proposal', () => {
  it('PAT 未配（apply 缺省）⇒ not_executed/proposal_apply_unconfigured，零网络', async () => {
    const out = await applyPipelineProposalImpl(depsWith(undefined), { proposal })
    expect(out.payload).toMatchObject({ status: 'not_executed', reason: 'proposal_apply_unconfigured' })
    expect(out.isError).toBe(false)
    expect(verdictOf(out.payload as Record<string, unknown>, out.isError)).toEqual({ verdict: 'ok', reason: 'proposal_apply_unconfigured' })
  })

  it('路径白名单：非允许前缀 / 含 .. / 非 .json / 以 / 开头 ⇒ refused/invalid_draft，applier 零调用', async () => {
    for (const bad of ['.github/workflows/x.yml', 'contracts/../secrets.json', 'contracts/common/x.json ', 'contracts/common/x.txt', '/contracts/x.json']) {
      const { applier, calls } = applierOf({ kind: 'applied', branch: 'b', prUrl: 'u', prNumber: 1, commitCount: 1, skipped: [] })
      const out = await applyPipelineProposalImpl(depsWith(applier), { proposal: { ...proposal, pieces: [{ path: bad, content: '{}\n' }] } })
      expect(out.payload).toMatchObject({ status: 'refused', reason: 'invalid_draft' })
      expect(calls()).toBe(0)
    }
  })

  it('内容重校验：管线草案删 position ⇒ refused/invalid_draft，零网络', async () => {
    const badPipelinePiece = { path: 'deploy/duckle/console/pipelines/lemeng.a.b.json', content: '{"name":"lemeng.a.b","nodes":[{"id":"s1","type":"source","data":{"label":"s"}}],"edges":[]}\n' }
    const { applier, calls } = applierOf({ kind: 'applied', branch: 'b', prUrl: 'u', prNumber: 1, commitCount: 1, skipped: [] })
    const out = await applyPipelineProposalImpl(depsWith(applier), { proposal: { ...proposal, pieces: [badPipelinePiece] } })
    expect(out.payload).toMatchObject({ status: 'refused', reason: 'invalid_draft' })
    expect(calls()).toBe(0)
  })

  it('outcome 映射：conflict ⇒ refused/proposal_conflict + 摘要；rejected ⇒ denied；unknown ⇒ unknown；nothing ⇒ ok', async () => {
    const cases: { outcome: ProposalApplyOutcome; payload: Record<string, unknown> }[] = [
      { outcome: { kind: 'conflict', path: goodPiece.path, currentSha256: 'abcdef0123456789' }, payload: { status: 'refused', reason: 'proposal_conflict', path: goodPiece.path, currentSha256: 'abcdef0123456789' } },
      { outcome: { kind: 'github_rejected', detail: 'HTTP 403' }, payload: { status: 'denied', reason: 'proposal_apply_rejected', detail: 'HTTP 403' } },
      { outcome: { kind: 'unknown', detail: 'HTTP 502', branch: 'proposal/x-abc123' }, payload: { status: 'unknown', reason: 'proposal_apply_unknown', detail: 'HTTP 502', branch: 'proposal/x-abc123' } },
      { outcome: { kind: 'nothing_to_apply', skipped: [goodPiece.path] }, payload: { status: 'ok', reason: 'nothing_to_apply' } },
      { outcome: { kind: 'applied', branch: 'proposal/x', prUrl: 'http://u/1', prNumber: 1, commitCount: 1, skipped: [] }, payload: { status: 'ok', prUrl: 'http://u/1', prNumber: 1, branch: 'proposal/x', commitCount: 1 } },
    ]
    for (const c of cases) {
      const { applier } = applierOf(c.outcome)
      const out = await applyPipelineProposalImpl(depsWith(applier), { proposal })
      expect(out.payload).toMatchObject(c.payload)
    }
  })
})

// ── W3 Task 2：白名单新两档 + YAML/SQL 内容重校验 ────────────────────────────────────────────
// 比对基准 = repoRoot 注入的夹具目录（生产是 rootsOf(env) → 仓根；测试注入 tmp 夹具，零网络）。

/** 现行 l1_metrics.yml 夹具：含一条**复合表达**既有条目——钉「未触碰条目不做形状检查」（复合表达
 *  不在提案侧闭集内，是人工维护的既有事实；只有新增/修改条目才逐条过 Task 1 同一套机检）。 */
const FIXTURE_YAML = `version: 1

entities:
  branch:
    label: 门店

domains:
  finished: "state = 'FINISHED'"

measures:
  sale_amount@order:
    expr: >-
      case when state = 'FINISHED' then 1 else 0 end

metrics:
  - name: 'lemeng:retail:sales'
    label: 销售额
    definition: >-
      零售销售侧金额，测试口径。
    expression: 'sum(fct_retail_sale.sale_amount)'
    grain: [system_book, bizday]
    owner: data-platform
    tier: certified
    source: lemeng
    freshness_sla_days: 1

  # 人工维护的复合表达既有条目（不在提案侧闭集内）：未触碰 ⇒ apply 重校验不得打回
  - name: 'lemeng:legacy:composite'
    label: 复合口径
    definition: >-
      既有复合表达（sum - sum），测试口径。
    expression: 'sum(fct_legacy.a) - sum(fct_legacy.b)'
    grain: [system_book]
    owner: data-platform
    tier: experimental
    source: lemeng
    freshness_sla_days: 2
`

/** repoRoot 夹具目录：dbt/semantics/l1_metrics.yml = 指定现行文件。 */
const fixtureRoot = (yaml: string = FIXTURE_YAML): string => {
  const root = mkdtempSync(join(tmpdir(), 'apply-fix-'))
  mkdirSync(join(root, 'dbt/semantics'), { recursive: true })
  writeFileSync(join(root, SEMANTICS_YAML_REL), yaml, 'utf8')
  return root
}

const NO_ROOTS = { pipelinesRoot: '/nope', contractsRoot: '/nope' }

/** 合法新增档（relation 取夹具现行文件里已用的 fct_retail_sale——B11 白名单基准是现行文件）。 */
const METRIC_INPUT = {
  name: 'lemeng:retail:net_amount',
  label: '净销售额',
  definition: '净销售额 = 零售销售侧金额合计。测试口径（apply 链路用）。',
  expression: 'sum(fct_retail_sale.return_money)',
  grain: ['system_book', 'bizday'],
  owner: 'data-platform',
  tier: 'experimental',
  source: 'lemeng',
  freshnessSlaDays: 1,
  auditSql: 'select system_book, bizday, sum(return_money) as value from x group by 1, 2\n',
  rationale: 'W3 apply 链路测试',
}

const compose = (input: Record<string, unknown>, currentYaml: string = FIXTURE_YAML) =>
  composeMetricDeclaration(NO_ROOTS, input as unknown as Parameters<typeof composeMetricDeclaration>[1], currentYaml)

/** 在夹具 metrics[] 末尾追加一条手写条目（夹具末条目在文件末尾 ⇒ 直接追加仍是合法 YAML）。 */
const withAdded = (entry: string): string => `${FIXTURE_YAML.trimEnd()}\n\n${entry}`

/** 手写条目造厂：全字段合法的底版 + 逐字段覆盖（只造「目标字段坏」的条目）。 */
const entryText = (over: Record<string, string> = {}): string => {
  const base: Record<string, string> = {
    name: `'lemeng:retail:extra'`,
    label: '附加指标',
    definition: '附加指标 = 测试口径。',
    expression: `'sum(fct_retail_sale.return_money)'`,
    grain: '[system_book, bizday]',
    owner: 'data-platform',
    tier: 'certified',
    source: 'lemeng',
    freshness_sla_days: '1',
  }
  const m = { ...base, ...over }
  return ['  - name: ' + m.name, '    label: ' + m.label, '    definition: ' + m.definition,
    '    expression: ' + m.expression, '    grain: ' + m.grain, '    owner: ' + m.owner,
    '    tier: ' + m.tier, '    source: ' + m.source, '    freshness_sla_days: ' + m.freshness_sla_days,
  ].join('\n') + '\n'
}

const appliedOutcome: ProposalApplyOutcome = { kind: 'applied', branch: 'b', prUrl: 'u', prNumber: 1, commitCount: 1, skipped: [] }

describe('apply_pipeline_proposal：白名单新两档（W3）', () => {
  it('近似路径全拒：语义声明只有精确单文件、dbt/tests 必须 .sql 后缀；applier 零调用', async () => {
    for (const bad of ['dbt/semantics/l1_metrics.yaml', 'dbt/semantics/other.yml', `dbt/semantics/x/${SEMANTICS_YAML_REL}`,
      'dbt/tests/note.md', 'dbt/tests/', 'dbt/tests/x.sql.bak', 'dbt/tests/x.SQL', `${SEMANTICS_YAML_REL} `]) {
      const { applier, calls } = applierOf(appliedOutcome)
      const out = await applyPipelineProposalImpl(depsWith(applier), { proposal: { ...proposal, pieces: [{ path: bad, content: 'x\n' }] } })
      expect(out.payload, bad).toMatchObject({ status: 'refused', reason: 'invalid_draft' })
      expect(calls(), bad).toBe(0)
    }
  })
})

describe('apply_pipeline_proposal：YAML piece 重校验（W3）', () => {
  it('compose 产出的合法草案（全量 YAML + audit SQL 两 piece）零网络直达 applier', async () => {
    const r = compose(METRIC_INPUT)
    if (!r.ok) throw new Error(`fixture 组装失败：${JSON.stringify(r.issues)}`)
    expect(r.pieces.map((p) => p.path)).toEqual([SEMANTICS_YAML_REL, expect.stringMatching(/^dbt\/tests\/lemeng\/audit_.*\.sql$/)])
    const { applier, calls } = applierOf(appliedOutcome)
    const out = await applyPipelineProposalImpl(depsWith(applier, { repoRoot: fixtureRoot() }), { proposal: { ...proposal, pieces: r.pieces } })
    expect(out.payload).toMatchObject({ status: 'ok' })
    expect(calls()).toBe(1)
  })

  it('修改模式同样放行（同名条目 diff 限定该条目，变更集过同一套机检）', async () => {
    const r = compose({ ...METRIC_INPUT, name: 'lemeng:retail:sales', definition: '口径修订：改为含退货冲减的净额。测试口径。', auditSql: undefined, rationale: '修订' })
    if (!r.ok) throw new Error(`fixture 组装失败：${JSON.stringify(r.issues)}`)
    expect(r.mode).toBe('modify')
    const { applier, calls } = applierOf(appliedOutcome)
    const out = await applyPipelineProposalImpl(depsWith(applier, { repoRoot: fixtureRoot() }), { proposal: { ...proposal, pieces: r.pieces } })
    expect(out.payload).toMatchObject({ status: 'ok' })
    expect(calls()).toBe(1)
  })

  it('未触碰的复合表达既有条目不做形状检查（夹具不动、只新增一条合法条目 ⇒ 放行）', async () => {
    const { applier, calls } = applierOf(appliedOutcome)
    const out = await applyPipelineProposalImpl(depsWith(applier, { repoRoot: fixtureRoot() }), { proposal: { ...proposal, pieces: [{ path: SEMANTICS_YAML_REL, content: withAdded(entryText()) }] } })
    expect(out.payload).toMatchObject({ status: 'ok' })
    expect(calls()).toBe(1)
  })

  it('变更集逐条过 Task 1 同一套机检：坏 name / B11 越界 relation / entity 未声明 / 坏 tier ⇒ refused', async () => {
    for (const [label, text] of [
      ['坏 name', entryText({ name: `'oops'` })],
      ['B11 自授权（现行文件没有的新 relation）', entryText({ expression: `'sum(fct_new_thing.col)'` })],
      ['entity 未声明', `  - name: 'lemeng:retail:extra'\n    label: 附加指标\n    definition: 附加指标 = 测试口径。\n    expression: 'sum(fct_retail_sale.return_money)'\n    grain: [system_book]\n    owner: data-platform\n    tier: certified\n    source: lemeng\n    freshness_sla_days: 1\n    entity: ghost\n`],
      ['坏 tier', entryText({ tier: 'beta' })],
      ['坏 grain（含连字符）', entryText({ grain: '[system-book]' })],
    ] as const) {
      const { applier, calls } = applierOf(appliedOutcome)
      const out = await applyPipelineProposalImpl(depsWith(applier, { repoRoot: fixtureRoot() }), { proposal: { ...proposal, pieces: [{ path: SEMANTICS_YAML_REL, content: withAdded(text) }] } })
      expect(out.payload, label).toMatchObject({ status: 'refused', reason: 'invalid_draft' })
      expect(calls(), label).toBe(0)
    }
  })

  it('未触碰条目一旦被改动也要过机检：复合表达条目的修改被闭集打回（提案通路不收复合表达）', async () => {
    const text = FIXTURE_YAML.replace("label: 复合口径", "label: 复合口径（改了个 label）")
    const { applier, calls } = applierOf(appliedOutcome)
    const out = await applyPipelineProposalImpl(depsWith(applier, { repoRoot: fixtureRoot() }), { proposal: { ...proposal, pieces: [{ path: SEMANTICS_YAML_REL, content: text }] } })
    expect(out.payload).toMatchObject({ status: 'refused', reason: 'invalid_draft' })
    expect(calls()).toBe(0)
  })

  it('diff 只许落在 metrics[]：顶层键改/增/删、删现行条目、非法 YAML ⇒ refused', async () => {
    for (const [label, text, path] of [
      ['改 domains 值', FIXTURE_YAML.replace(`finished: "state = 'FINISHED'"`, `finished: "state = 'X'"`), 'domains'],
      ['新增顶层键', `${FIXTURE_YAML.trimEnd()}\nextra: 1\n`, 'extra'],
      ['删 version 键', FIXTURE_YAML.replace('version: 1\n\n', ''), 'version'],
      ['删现行条目', FIXTURE_YAML.replace(/  # 人工维护的复合表达既有条目[\s\S]*$/, ''), 'metrics'],
      ['非法 YAML', 'metrics: [oops\n', 'content'],
    ] as const) {
      const { applier, calls } = applierOf(appliedOutcome)
      const out = await applyPipelineProposalImpl(depsWith(applier, { repoRoot: fixtureRoot() }), { proposal: { ...proposal, pieces: [{ path: SEMANTICS_YAML_REL, content: text }] } })
      expect(out.payload, label).toMatchObject({ status: 'refused', reason: 'invalid_draft' })
      const issues = (out.payload as { issues?: { path: string }[] }).issues ?? []
      expect(issues.some((x) => x.path.includes(path)), `${label} 的 issue 应点名 ${path}`).toBe(true)
      expect(calls(), label).toBe(0)
    }
  })

  it('现行文件不可读（repoRoot 指空目录）⇒ unknown/semantics_unreadable，零网络（applier 零调用）', async () => {
    const r = compose(METRIC_INPUT)
    if (!r.ok) throw new Error('fixture 组装失败')
    const { applier, calls } = applierOf(appliedOutcome)
    const out = await applyPipelineProposalImpl(depsWith(applier, { repoRoot: mkdtempSync(join(tmpdir(), 'apply-empty-')) }), { proposal: { ...proposal, pieces: r.pieces } })
    expect(out.payload).toMatchObject({ status: 'unknown', reason: 'semantics_unreadable' })
    expect(out.isError).toBe(true)
    expect(calls()).toBe(0)
  })
})

describe('apply_pipeline_proposal：SQL piece 重校验（W3）', () => {
  const sqlPiece = (content: string) => ({ path: 'dbt/tests/lemeng/audit_x.sql', content })

  it('空文件 / 危险词 ⇒ refused（gate ⑦ 不旁路：只挡空壳与禁词，不深检复算逻辑）', async () => {
    for (const [label, content, word] of [
      ['空文件', '   \n', null],
      ['危险词 drop', 'drop table x\n', 'drop'],
      ['危险词 insert', 'insert into x values (1)\n', 'insert'],
    ] as const) {
      const { applier, calls } = applierOf(appliedOutcome)
      const out = await applyPipelineProposalImpl(depsWith(applier, { repoRoot: fixtureRoot() }), { proposal: { ...proposal, pieces: [sqlPiece(content)] } })
      expect(out.payload, label).toMatchObject({ status: 'refused', reason: 'invalid_draft' })
      const issues = (out.payload as { issues?: { message: string }[] }).issues ?? []
      if (word !== null) expect(issues.some((x) => x.message.includes(word)), label).toBe(true)
      expect(calls(), label).toBe(0)
    }
  })

  it('合法复算 select 直达 applier（单独 SQL piece 也收——随 PR 人工审）', async () => {
    const { applier, calls } = applierOf(appliedOutcome)
    const out = await applyPipelineProposalImpl(depsWith(applier, { repoRoot: fixtureRoot() }), { proposal: { ...proposal, pieces: [sqlPiece('select 1\n')] } })
    expect(out.payload).toMatchObject({ status: 'ok' })
    expect(calls()).toBe(1)
  })
})
