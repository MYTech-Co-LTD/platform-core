// envelope.ts —— 信任信封（spec 2026-10-21 §4）：所有数值工具回包的外层。
// 纯函数：缺 section 就**缺席**（缺席 = 工具未升级，可辨；模型不得脑补）——
// 不做 `{}` 占位，不做默认值编造。
export interface EnvelopeInput {
  status?: 'ok'
  metric?: Record<string, unknown>
  subject?: Record<string, unknown>
  asOf?: Record<string, unknown>
  query?: Record<string, unknown>
  result?: Record<string, unknown>
  lineage?: Record<string, unknown>
  audit?: Record<string, unknown>
}

const SECTION_ORDER = ['metric', 'subject', 'asOf', 'query', 'result', 'lineage', 'audit'] as const

export function buildEnvelope(input: EnvelopeInput): Record<string, unknown> {
  const out: Record<string, unknown> = { status: input.status ?? 'ok' }
  for (const key of SECTION_ORDER) {
    const v = input[key]
    if (v !== undefined) out[key] = v
  }
  return out
}

export const ENVELOPE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ok'] },
    metric: { type: 'object', description: 'id/version/definitionHash/tier/owner/title' },
    subject: { type: 'object', description: 'org/source/adoptedSources——主体钉死的回声' },
    asOf: { type: 'object', description: 'dataThrough/freshnessLagSeconds/lastDbtRun/tests' },
    query: { type: 'object', description: 'sql/params/dimensions/rowLimit/queryId' },
    result: { type: 'object', description: 'columns/rows/rowCount/truncated/total?' },
    lineage: { type: 'object', description: 'model/upstream（源缺席时本节缺席）' },
    audit: { type: 'object', description: 'id/ts——可独立核对 data.query_audit' },
  },
  required: ['status'],
}
