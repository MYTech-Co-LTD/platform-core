// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { Window } from 'happy-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const push = vi.fn()
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({ push }) }))
vi.mock('@/shims/wuji-data', () => ({
  store_info: { query: vi.fn() },
  employee_info: { query: vi.fn() },
  employee_info_approve: { query: vi.fn(), create: vi.fn() },
}))
// ⚠️ `vi.mock` 的工厂会被提升到文件顶部 ⇒ 工厂里引用的外部变量必须也用 `vi.hoisted` 提升，
// 否则报 `Cannot access 'success' before initialization`（计划里的写法缺这一步）。
const { success } = vi.hoisted(() => ({ success: vi.fn() }))
vi.mock('@wujibase/wuji', () => ({
  Message: { success, warning: vi.fn(), error: vi.fn(), info: vi.fn() },
  Confirm: vi.fn(),
}))

import TDesign, { Select } from 'tdesign-vue-next'
import StoreEmployeeApproval from './storeEmployeeApproval.vue'
import { employee_info, employee_info_approve, store_info } from '@/shims/wuji-data'

const STORES = [
  { id: 3, store_name: '城东店', store_number: '3', is_enabled: '1' },
  { id: 5, store_name: '城西店', store_number: '5', is_enabled: '1' },
  { id: 7, store_name: '城南店', store_number: '7', is_enabled: '1' },
]

const REGISTERED = {
  id: 1,
  employee_name: '张三',
  employee_phonenumber: '13800000000',
  store_info: '3,5',
  status: '通过',
  _ctime: '',
  _mtime: '',
}

beforeEach(() => {
  success.mockClear()
  vi.mocked(store_info.query).mockReset().mockResolvedValue(STORES)
  vi.mocked(employee_info.query).mockReset().mockResolvedValue([])
  vi.mocked(employee_info_approve.query).mockReset().mockResolvedValue([])
  vi.mocked(employee_info_approve.create).mockReset().mockResolvedValue({ id: 1 })
  ;(globalThis as unknown as { defineWujiPageMeta?: unknown }).defineWujiPageMeta = vi.fn()
  // Node 22 自带一个实验性的 `localStorage` 全局（未开 `--localstorage-file` 时是 undefined），
  // 会把 happy-dom 的实现遮住 ⇒ 显式换回一个真的 Storage，让下面那条断言真的成立。
  Object.defineProperty(globalThis, 'localStorage', {
    value: new Window().localStorage,
    configurable: true,
    writable: true,
  })
})

// TDesign 组件要显式装上（计划 Step 8 的注里给了这条出口）；否则 `<t-input>` 不渲染成
// 真 `<input>`，靠 DOM 驱动的那条用例无从下手。
// ⚠️ **不要**加 `stubs: { 't-card': false }`（计划原稿有）：VTU 把 `false` 当 no-op stub，
// 会把整棵卡片子树吞掉 —— 实测 inputs 从 3 变 0，用例 3 直接无从下手。
const global = { plugins: [TDesign] }

describe('storeEmployeeApproval 页面', () => {
  it('挂载后拉一次档案（未登记 ⇒ 停在注册态）', async () => {
    const w = mount(StoreEmployeeApproval, { global })
    await flushPromises()
    expect(w.text()).toContain('注册')
    // 「停在注册态」的真凭据：表单标题是注册那一条，不是已登记的信息卡
    expect(w.text()).toContain('注册成为门店员工')
  })

  it('页面上**没有**任何微信 OAuth 残留（localStorage / open.weixin.qq.com 都不该出现）', async () => {
    mount(StoreEmployeeApproval, { global })
    await flushPromises()
    expect(window.localStorage.getItem('wechat_openid')).toBeNull()
    // 源码级断言：OAuth 块是整体删除，不是被条件分支藏起来
    const src = (await import('./storeEmployeeApproval.vue?raw')).default as string
    expect(src).not.toContain('open.weixin.qq.com')
    expect(src).not.toContain('wechat_openid')
    expect(src).not.toContain('window.w')
  })

  it('已登记 ⇒ 点「编辑信息」把档案连门店 id 串一起回填进表单（源侧 handleEdit 的职责）', async () => {
    vi.mocked(employee_info.query).mockResolvedValue([REGISTERED])
    const w = mount(StoreEmployeeApproval, { global })
    await flushPromises()

    await w.find('button').trigger('click')
    await flushPromises()

    const values = w.findAll('input').map((i) => i.element.value)
    expect(values[0]).toBe('张三')
    expect(values[1]).toBe('13800000000')
    // 门店 id 串 '3,5' ⇒ 表单里是数组 ['3','5']（这条断言原先误挂在 composable 测试里）
    expect(w.findComponent(Select).props('modelValue')).toEqual(['3', '5'])
  })

  it('提交成功 ⇒ Message.success 的文案是「注册已提交，等待审批」', async () => {
    const w = mount(StoreEmployeeApproval, { global })
    await flushPromises()
    // 姓名/电话走真实 DOM 输入；门店选择器驱动底层 v-model（TDesign 的下拉选项 portal 到
    // body、且搜索是 300ms 防抖，走 DOM 点选既慢又脆）。
    const inputs = w.findAll('input')
    await inputs[0]!.setValue('张三')
    await inputs[1]!.setValue('13800000000')
    w.findComponent(Select).vm.$emit('update:modelValue', ['3'])
    await flushPromises()

    await w.find('button').trigger('click')
    await flushPromises()

    expect(employee_info_approve.create).toHaveBeenCalledTimes(1)
    expect(success).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('注册已提交') }))
  })
})
