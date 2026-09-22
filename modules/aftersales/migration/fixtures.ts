// fixtures.ts — 迁移单测夹具。
// ⚠️ W1 版按 spec §3.3 实证表【编造】（编码已实证的字段行为，非真实数据）；
//    T3 拉样后以【脱敏真样本】替换/扩充（姓名/手机号/openid 换合成值，保字段名/类型/形状）。
//    编造依据逐条注明，替换时对照 SAMPLE-NOTES.md。

/** employee_info：openId 驼峰拼写 + store_info 逗号多门店串 + 审批态英文词表（§3.3：同一概念两种拼写） */
export const FIXTURE_EMPLOYEE = {
  _id: '591-001', name: '张三', phone: '13800000000', openId: 'oEMP001',
  approve_status: 'approved', store_info: 'S001，S002',
}
/** employee_info_approve：openid 全小写拼写 + 中文词表「通过」 + approveinfo 嵌套（全区唯一，展平） */
export const FIXTURE_EMPLOYEE_APPROVE = {
  _id: 214001, openid: 'oAPP001', approve_type: 'change', status: '通过',
  approveinfo: { old: { name: '旧名' }, new: { name: '新名' } },
  ctime: '2026-08-01 10:00:00', _ctime: '2026-08-01 10:00:01',
}
/** after_sales_rule：refund_ratio 实存小数（注释谎称 %）+ 类型漂移 int/num */
export const FIXTURE_RULE = { _id: 'rule-001', name: '默认规则', refund_ratio: 0.05, remark: '' }
/** after_sales_work_order：金额元带分精度（×100）+ 状态三态 + damage_images 数组/串混用（丢弃） */
export const FIXTURE_TICKET = {
  _id: 'wo-001', order_number: 'AS20260801001', openId: 'oSUB001',
  product_name: 'P001', store_selection: 'S001',
  damage_quantity: 20, basic_quantity: 10, basic_unit_price: 12.5,
  status: 'completed', after_sales_type: 'ratio', after_sales_amount: 200, after_sales_rate: 0.05,
  operator: '审批员A', remark: '历史工单', related_order: 'GB20260731001',
  damage_images: ['https://cos.example/p1.jpg', 'https://cos.example/p2.jpg'],
  create_time: '2026-08-01 11:00:00',
}
