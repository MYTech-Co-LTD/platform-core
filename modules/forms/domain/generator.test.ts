import { describe, expect, it } from 'vitest'
import { buildMessages, generateDraft, parseDraft } from './generator'
import type { ChatMessage, ChatModel } from './llm'

// 生成器测试（#724）：**模型全程用假替身**，不绑真供应商——生成逻辑（解析/校验/repair 决策）
// 与「模型输出什么」解耦，这样才对「模型乱吐」这种最危险的失败形态有牙齿。

const OK_BODY = {
  assetId: 'site-check',
  schema: { type: 'object', properties: { name: { type: 'string', title: '姓名' } }, required: ['name'] },
  uiSchema: { name: { 'ui:placeholder': '请输入' } },
}

/** 按顺序回话的假模型；同时记录它收到的消息（供断言提示词/repair 内容）。 */
function fakeModel(replies: string[]): ChatModel & { seen: ChatMessage[][] } {
  let i = 0
  const seen: ChatMessage[][] = []
  return {
    seen,
    async complete(messages: ChatMessage[]) {
      seen.push(messages)
      const r = replies[Math.min(i, replies.length - 1)]
      i += 1
      return r
    },
  }
}

describe('parseDraft', () => {
  it('合法 JSON → {assetId, body}', () => {
    const d = parseDraft(JSON.stringify(OK_BODY))
    expect(d.assetId).toBe('site-check')
    expect(d.body.schema).toEqual(OK_BODY.schema)
    expect(d.body.uiSchema).toEqual(OK_BODY.uiSchema)
  })

  it('剥掉 Markdown 围栏（提示词禁止但模型实测仍会加）', () => {
    const d = parseDraft('```json\n' + JSON.stringify(OK_BODY) + '\n```')
    expect(d.assetId).toBe('site-check')
  })

  it('uiSchema 可省略（没有 UI 意图就不写）', () => {
    const d = parseDraft(JSON.stringify({ assetId: 'bare', schema: OK_BODY.schema }))
    expect(d.body.uiSchema).toBeUndefined()
  })

  it('assetId 不合规 / 缺 schema / 非对象 → 抛（形状闸）', () => {
    for (const bad of [
      { ...OK_BODY, assetId: 'Bad_Id' },
      { ...OK_BODY, assetId: '' },
      { assetId: 'x' },
      { assetId: 'x', schema: [] },
      'not-json',
    ]) {
      expect(() => parseDraft(typeof bad === 'string' ? bad : JSON.stringify(bad))).toThrow()
    }
  })
})

describe('buildMessages（提示词载体）', () => {
  it('system 段带物料清单，user 段带描述；清单覆盖四类硬约束（方言/条件字段/字典引用/控件白名单）', () => {
    const msgs = buildMessages('门店巡检登记')
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toContain('draft-07')
    expect(msgs[0].content).toContain('then.properties') // §12.7 条件字段位置
    expect(msgs[0].content).toContain('x-dict') // 本仓字典引用机制（非 PoC 的 ui:options.dictKey）
    // 未实现控件**可以**出现，但只能出现在「禁止使用」语境里（警告模型别用）
    for (const w of ['cascader', 'signature']) {
      for (const line of msgs[0].content.split('\n').filter((l) => l.includes(w))) {
        expect(line, `${w} 出现在非禁止语境：${line}`).toMatch(/不许|禁止|不认识/)
      }
    }
    expect(msgs[1]).toEqual({ role: 'user', content: expect.stringContaining('门店巡检登记') })
  })
})

describe('generateDraft', () => {
  it('首轮即合法 → ok，repairUsed=false，只调一次模型', async () => {
    const model = fakeModel([JSON.stringify(OK_BODY)])
    const r = await generateDraft({ model, description: '门店巡检' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.assetId).toBe('site-check')
      expect(r.repairUsed).toBe(false)
    }
    expect(model.seen.length).toBe(1)
  })

  it('首轮 JSON 坏 → repair 一轮后成功，repairUsed=true，且回喂了错误原文', async () => {
    const model = fakeModel(['{ 这不是 JSON', JSON.stringify(OK_BODY)])
    const r = await generateDraft({ model, description: '门店巡检' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.repairUsed).toBe(true)
    expect(model.seen.length).toBe(2)
    const repairTurn = model.seen[1]
    expect(repairTurn.length).toBe(4) // system + user + assistant(坏产出) + user(错误)
    expect(repairTurn[2].role).toBe('assistant')
    expect(repairTurn[3].content).toContain('没有通过平台校验')
  })

  it('★ 契约过不了闸（用了未实现控件）→ 进 repair；仍不过 ⇒ 失败且**不产出 draft**', async () => {
    const bad = JSON.stringify({
      assetId: 'bad',
      schema: { type: 'object', properties: { region: { type: 'string', title: '地区' } } },
      uiSchema: { region: { 'ui:widget': 'cascader' } }, // 渲染层不认识
    })
    const model = fakeModel([bad, bad])
    const r = await generateDraft({ model, description: '省市区三级联动' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('CONTRACT_REJECTED')
      expect(r.detail).toContain('UNSUPPORTED_WIDGET') // 错误原文回喂给人看
      expect(r.raw).toBe(bad) // 原文一并带上，人能看到模型到底吐了什么
    }
    expect(model.seen.length).toBe(2) // 恰好两次，不无限重试
  })

  it('★ 两轮都非 JSON → LLM_OUTPUT_UNPARSEABLE（与「契约被拒」分开归类）', async () => {
    const model = fakeModel(['乱码', '还是乱码'])
    const r = await generateDraft({ model, description: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('LLM_OUTPUT_UNPARSEABLE')
  })

  it('repair 方向正确：第二轮消息里带着第一轮的产出与具体错误码', async () => {
    const badCond = JSON.stringify({
      assetId: 'cond',
      schema: {
        type: 'object',
        properties: { t: { type: 'string', enum: ['a'] }, other: { type: 'string' } },
        if: { properties: { t: { const: 'a' } }, required: ['t'] },
        then: { properties: { other: { type: 'string' } } },
      },
    })
    const model = fakeModel([badCond, badCond])
    await generateDraft({ model, description: 'x' })
    expect(model.seen[1][3].content).toContain('CONDITIONAL_TOPLEVEL')
  })
})
