// approval-parse.test.ts — 企微审批状态变更回调（inner XML）解析（OA P2 Task 3）
//
// 真实回调的双形标签以 T1 抓包为准；T1 未完成前，两种写法都要认（大小写 + 下划线）：
//   SpNo|sp_no、SpStatus|sp_status、TemplateId|template_id、ApplyTime|apply_time、
//   FromUserName|from_user_name、AgentID|AgentId|agent_id、Event|event。
// 未知事件返回 null（由调用方落 attention，不静默吞掉）。
import { describe, expect, it } from 'vitest'
import { parseApprovalChange } from './approval-parse'

/** 按企微文档 sys_approval_change 形状构造的样本（合成数据，非真实抓包）。 */
const CAMEL_XML = `\
<xml>
  <ToUserName><![CDATA[ww0123456789abcdef]]></ToUserName>
  <FromUserName><![CDATA[sys]]></FromUserName>
  <CreateTime>1700000000</CreateTime>
  <MsgType><![CDATA[event]]></MsgType>
  <Event><![CDATA[sys_approval_change]]></Event>
  <AgentID>1000011</AgentID>
  <ApprovalInfo>
    <SpNo><![CDATA[SP20261116001]]></SpNo>
    <SpName><![CDATA[差旅报销]]></SpName>
    <SpStatus>1</SpStatus>
    <TemplateId><![CDATA[tpl-001]]></TemplateId>
    <ApplyTime>1700000010</ApplyTime>
    <Applyer>
      <UserId><![CDATA[zhangsan]]></UserId>
      <Party><![CDATA[1]]></Party>
    </Applyer>
  </ApprovalInfo>
</xml>`

/** 同一事件的下划线写法（双形兼容）。 */
const SNAKE_XML = `\
<xml>
  <event>sys_approval_change</event>
  <agent_id>1000011</agent_id>
  <sp_no>SP20261116001</sp_no>
  <sp_status>1</sp_status>
  <template_id>tpl-001</template_id>
  <apply_time>1700000010</apply_time>
  <from_user_name>zhangsan</from_user_name>
</xml>`

describe('parseApprovalChange', () => {
  it('CamelCase 真实形状：字段全取到', () => {
    expect(parseApprovalChange(CAMEL_XML)).toEqual({
      event: 'sys_approval_change',
      spNo: 'SP20261116001',
      spStatus: 1,
      templateId: 'tpl-001',
      applyTime: 1700000010,
      requester: 'zhangsan',
      agentId: 1000011,
    })
  })

  it('下划线写法：与 CamelCase 结果一致（双形标签都认）', () => {
    expect(parseApprovalChange(SNAKE_XML)).toEqual({
      event: 'sys_approval_change',
      spNo: 'SP20261116001',
      spStatus: 1,
      templateId: 'tpl-001',
      applyTime: 1700000010,
      requester: 'zhangsan',
      agentId: 1000011,
    })
  })

  it('大小写混写（AgentId / SpNo / EVENT）也认', () => {
    const xml = '<xml><EVENT>sys_approval_change</EVENT><SpNo>SP1</SpNo><AgentId>7</AgentId></xml>'
    expect(parseApprovalChange(xml)).toMatchObject({ event: 'sys_approval_change', spNo: 'SP1', agentId: 7 })
  })

  it('open_approval_change 也是已知事件（T1 确认前两者都收）', () => {
    const xml = '<xml><Event><![CDATA[open_approval_change]]></Event><SpNo>SP2</SpNo><SpStatus>2</SpStatus></xml>'
    expect(parseApprovalChange(xml)).toMatchObject({ event: 'open_approval_change', spNo: 'SP2', spStatus: 2 })
  })

  it('发起人优先取 ApprovalInfo/Applyer/UserId（FromUserName=sys 不是发起人）', () => {
    expect(parseApprovalChange(CAMEL_XML)?.requester).toBe('zhangsan')
  })

  it('无 Applyer 时回落 FromUserName/from_user_name', () => {
    const xml = '<xml><Event>sys_approval_change</Event><FromUserName><![CDATA[lisi]]></FromUserName></xml>'
    expect(parseApprovalChange(xml)?.requester).toBe('lisi')
  })

  it('可选字段缺失 ⇒ undefined，不抛（由调用方决定 attention/补数）', () => {
    const e = parseApprovalChange('<xml><Event>sys_approval_change</Event></xml>')
    expect(e).toEqual({
      event: 'sys_approval_change',
      spNo: undefined,
      spStatus: undefined,
      templateId: undefined,
      applyTime: undefined,
      requester: undefined,
      agentId: undefined,
    })
  })

  it('数值字段非数字 ⇒ undefined（不产出 NaN）', () => {
    const xml = '<xml><Event>sys_approval_change</Event><SpNo>SP3</SpNo><SpStatus>x</SpStatus><ApplyTime>--</ApplyTime><AgentID>n/a</AgentID></xml>'
    expect(parseApprovalChange(xml)).toMatchObject({
      spNo: 'SP3', spStatus: undefined, applyTime: undefined, agentId: undefined,
    })
  })

  it('未知事件 / 缺 Event / 非 XML ⇒ null（不静默当已知事件）', () => {
    expect(parseApprovalChange('<xml><Event>click</Event><SpNo>SP1</SpNo></xml>')).toBeNull()
    expect(parseApprovalChange('<xml><SpNo>SP1</SpNo></xml>')).toBeNull()
    expect(parseApprovalChange('not xml at all')).toBeNull()
    expect(parseApprovalChange('')).toBeNull()
  })

  it('XSS-ish 值原样返回（解析层不做 HTML 解码或转义）', () => {
    const xml = '<xml><Event>sys_approval_change</Event><SpNo><![CDATA[<script>]]></SpNo></xml>'
    expect(parseApprovalChange(xml)?.spNo).toBe('<script>')
  })

  // T1 真实样本见 approval-crypto.test.ts 末尾的显式 skip；解析侧的 known-answer
  // 将在同一 fixture 落地后补在这里。
})
