// DeclarationModal.tsx — 租户全额声明 / 覆盖平台口径的表单（W8，2026-11-09）。
//
// 与 L2 结构化表单分开：这里提交的是**声明条目**（与 L1 YAML 同形），SQL 由服务端唯一编译器
// 生成——UI 里没有地方写 SQL。服务端会按 contracts 的 sensitivity 自动给敏感列套默认掩码；
// 表单不展开掩码编辑器（避免把安全面搬到浏览器里猜）。
//
// 覆盖模式（mode='override'）下 `name` 与 `grain` **锁死**：名字必须等于被覆盖的 L1 id，
// grain 必须与 L1 同形（服务端也各有一道校验，这里提前消掉最常见的 400）。
import { useEffect, useState } from 'react'
import { Input, InputNumber, Modal, Select, Space, Switch, Typography } from 'antd'

export type DeclarationMode = 'create' | 'override'

export interface DeclarationSeed {
  id: string
  title: string
  description: string
  expression: string
  grain: string[]
}

interface Props {
  open: boolean
  mode: DeclarationMode
  seed: DeclarationSeed
  onCancel: () => void
  onSubmit: (declaration: Record<string, unknown>) => Promise<void>
}

interface FormState {
  name: string
  label: string
  definition: string
  owner: string
  source: string
  expression: string
  grain: string
  sla: number
  sources: string
  reads: string
  unit: string
  entity: string
  synonyms: string
  scopeNote: string
  additivity: 'flow' | 'stock' | 'non_additive'
  hasMasks: boolean
}

const empty = (seed: DeclarationSeed): FormState => ({
  name: seed.id, label: seed.title, definition: seed.description, owner: 'data-platform',
  source: 'lemeng', expression: seed.expression, grain: seed.grain.join(', '),
  sla: 2, sources: '', reads: '', unit: '', entity: '', synonyms: '', scopeNote: '',
  additivity: 'flow', hasMasks: false,
})

const splitList = (s: string): string[] => s.split(/[\n,]/).map((x) => x.trim()).filter((x) => x !== '')

export default function DeclarationModal({ open, mode, seed, onCancel, onSubmit }: Props) {
  const [f, setF] = useState<FormState>(() => empty(seed))
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) setF(empty(seed)) }, [open, seed])

  const set = <K extends keyof FormState>(k: K, v: FormState[K]): void => setF((cur) => ({ ...cur, [k]: v }))
  const locked = mode === 'override'

  const submit = async (): Promise<void> => {
    const declaration: Record<string, unknown> = {
      name: f.name.trim(),
      label: f.label.trim(),
      definition: f.definition.trim(),
      owner: f.owner.trim(),
      tier: 'experimental',
      source: f.source.trim(),
      expression: f.expression.trim(),
      grain: splitList(f.grain),
      freshness_sla_days: f.sla,
      sources: splitList(f.sources),
      reads: splitList(f.reads),
      additivity: f.additivity,
    }
    if (f.unit.trim() !== '') declaration.unit = f.unit.trim()
    if (f.entity.trim() !== '') declaration.entity = f.entity.trim()
    if (f.synonyms.trim() !== '') declaration.synonyms = splitList(f.synonyms)
    if (f.scopeNote.trim() !== '') declaration.scope_note = f.scopeNote.trim()
    setBusy(true)
    try { await onSubmit(declaration) } finally { setBusy(false) }
  }

  return (
    <Modal
      open={open}
      title={locked ? `覆盖平台口径：${seed.id}` : '新建全额声明（租户口径）'}
      onCancel={onCancel}
      onOk={() => { void submit() }}
      okText={locked ? '保存草稿（待确认）' : '创建'}
      cancelText="取消"
      confirmLoading={busy}
      width={720}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: '100%' }} size="small">
        <Typography.Text type="secondary">
          只填<strong>声明</strong>，SQL 由服务端生成；敏感契约列会按 contracts 自动套默认掩码。
          {locked ? ' 覆盖保存后是草稿，需在「本租户覆盖」里确认才生效。' : ' 创建后即时可用（草稿口径）。'}
        </Typography.Text>
        <Input addonBefore="指标 id" value={f.name} disabled={locked} maxLength={64}
               placeholder="如 lemeng:retail:gross_sales"
               onChange={(e) => set('name', e.target.value)} />
        <Input addonBefore="标题" value={f.label} maxLength={128} placeholder="必填：看数人看到的名字" onChange={(e) => set('label', e.target.value)} />
        <Input.TextArea rows={2} placeholder="口径定义（必填）" value={f.definition}
                        onChange={(e) => set('definition', e.target.value)} />
        <Space wrap>
          <Input addonBefore="负责人" value={f.owner} style={{ width: 260 }} onChange={(e) => set('owner', e.target.value)} />
          <Input addonBefore="源系统" value={f.source} style={{ width: 220 }} onChange={(e) => set('source', e.target.value)} />
          <span>
            <Typography.Text>SLA（天）</Typography.Text>
            <InputNumber min={1} max={30} value={f.sla} style={{ marginLeft: 8 }}
                         onChange={(v) => set('sla', typeof v === 'number' ? v : 2)} />
          </span>
        </Space>
        <Typography.Text type="secondary">
          表达式（只写聚合表达式，列用 <code>关系.列</code>；不要写 select/from）
        </Typography.Text>
        <Input.TextArea rows={3} value={f.expression} placeholder="sum(fct_retail_sale.sale_amount)"
                        onChange={(e) => set('expression', e.target.value)} />
        <Input addonBefore="粒度" value={f.grain} disabled={locked}
               placeholder="system_book, bizday（覆盖时必须与平台口径同形）"
               onChange={(e) => set('grain', e.target.value)} />
        <Typography.Text type="secondary">
          数据来源（湖路径，每行一个；决定新鲜度水位推导，可留空 = 无自动水位）
        </Typography.Text>
        <Input.TextArea rows={2} value={f.sources}
                        placeholder="s3://<bucket>/lemeng/retail_order_line/system_book=<账套>/bizday=<日期>/all.parquet"
                        onChange={(e) => set('sources', e.target.value)} />
        <Typography.Text type="secondary">
          读取的契约列（<code>域.表.列</code>，每行一个，必填；敏感列据此自动套默认掩码）
        </Typography.Text>
        <Input.TextArea rows={2} value={f.reads} placeholder="lemeng.retail_order_line.sale_amount"
                        onChange={(e) => set('reads', e.target.value)} />
        <Space wrap>
          <Input addonBefore="单位" value={f.unit} style={{ width: 200 }} onChange={(e) => set('unit', e.target.value)} />
          <Input addonBefore="实体" value={f.entity} style={{ width: 240 }} placeholder="可选，如 branch"
                 onChange={(e) => set('entity', e.target.value)} />
          <Input addonBefore="同义词" value={f.synonyms} style={{ width: 300 }} placeholder="逗号分隔"
                 onChange={(e) => set('synonyms', e.target.value)} />
        </Space>
        <Input.TextArea rows={2} value={f.scopeNote} placeholder="口径说明/边界（可选）"
                        onChange={(e) => set('scopeNote', e.target.value)} />
        <Space wrap>
          <span>
            <Typography.Text>可加性</Typography.Text>
            <Select style={{ width: 160, marginLeft: 8 }} value={f.additivity}
                    onChange={(v) => set('additivity', v)}
                    options={[
                      { value: 'flow', label: 'flow（可跨行合计）' },
                      { value: 'stock', label: 'stock（存量）' },
                      { value: 'non_additive', label: 'non_additive' },
                    ]} />
          </span>
          <Switch checked={f.hasMasks} disabled onChange={() => undefined} />
          <Typography.Text type="secondary">掩码由服务端按契约敏感度自动套（v1 不在页面里编辑）</Typography.Text>
        </Space>
      </Space>
    </Modal>
  )
}
