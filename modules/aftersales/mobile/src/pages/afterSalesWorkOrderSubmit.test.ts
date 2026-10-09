// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TDesign, { Select } from 'tdesign-vue-next'

/**
 * ⚠️ `vi.mock` 的工厂会被提升到文件顶部 ⇒ 工厂里引用的外部变量**必须**一起 `vi.hoisted`，
 * 否则报 `Cannot access 'X' before initialization`。计划 Task 6 的订正表第 5 条已实证过这一点，
 * 而 Task 8 的测试初稿同样缺这一步 —— 这里按订正执行。
 */
const { replace, back, success, warning, woCreate, empQuery, storeQuery, settlementOrdersQuery } = vi.hoisted(() => ({
  replace: vi.fn(),
  back: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  woCreate: vi.fn(),
  empQuery: vi.fn(),
  storeQuery: vi.fn(),
  settlementOrdersQuery: vi.fn(),
}))

vi.mock('vue-router', () => ({ useRouter: () => ({ replace, back }), useRoute: () => ({ query: {} }) }))
vi.mock('@/shims/wuji-data', () => ({
  employee_info: { query: (...a: unknown[]) => empQuery(...a) },
  store_info: { query: (...a: unknown[]) => storeQuery(...a) },
  after_sales_work_order: {
    create: (...a: unknown[]) => woCreate(...a),
    settlementOrders: (...a: unknown[]) => settlementOrdersQuery(...a),
  },
}))
// F2 的用例要**真**走一次上传失败（失败件留在列表里正是 F2 的前提），所以上传 shim 在这里
// 换成可控替身——其余用例不碰上传，不受影响。
vi.mock('@/shims/wuji-upload', () => ({ uploadImage: vi.fn(), uploadFile: vi.fn() }))
vi.mock('@wujibase/wuji', () => ({
  Message: { success, warning, error: vi.fn(), info: vi.fn() },
  Confirm: vi.fn(() => ({ hide: vi.fn() })),
}))

import { uploadImage } from '@/shims/wuji-upload'
import Submit from './afterSalesWorkOrderSubmit.vue'

const up = vi.mocked(uploadImage)

/** 登记者快照（shim 的形状：`employee_info.query` 回的是**行数组**，未登记回空数组） */
const REGISTERED = {
  id: 1,
  employee_name: '张三',
  employee_phonenumber: '13800000000',
  store_info: '103',
  status: '通过',
  _ctime: '',
  _mtime: '',
}

/** 门店行（shim 的 `StoreRow` 形状，#476 起 `id` = dim_branch.code 自然键） */
const STORE = { id: '103', store_name: '城东店', store_number: '103', is_enabled: '1' }

/** 结算单行（shim 的 `SettlementOrderRow` 形状，#500 段③：金额依据 = 所选行的结算价） */
const ORDER = {
  orderNo: 'MO3120992607050085',
  source: 'transfer' as const,
  bizday: '2026-10-07',
  createTime: '2026-10-07 11:07:31',
  lines: [{ itemCode: 'I001', itemName: '苹果', lineKey: '0', quantity: 30, priceMinor: 500 }],
}

// TDesign 组件要显式装上，否则 `<t-select>` / `<t-card>` 不渲染成真元素。
// ⚠️ **不要**加 `stubs`（Task 6 订正表第 6 条：`false` 是破坏性 no-op stub，会吞掉整棵子树）。
const global = { plugins: [TDesign] }

beforeEach(() => {
  replace.mockClear()
  back.mockClear()
  success.mockClear()
  warning.mockClear()
  woCreate.mockReset().mockResolvedValue({ id: 1 })
  // `uploadImage` 的解析值是 `UploadResult = { id, objectKey }`（wuji-upload.ts）——**没有**
  // `uploadUrl` / `expiresIn`：那两个是**预签名响应**（`PresignResponse`）的键，属于 shim 内部
  // 从 `/guest/attachments` 拿到的那一层，从不外泄。旧 fixture 多带了它们 = 测试替身比真机宽
  // （issue #68 同款漂移，Step 3 收口时被 typecheck 抓出）。
  up.mockReset().mockResolvedValue({ id: 42, objectKey: 'k' })
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:local-preview')
  globalThis.URL.revokeObjectURL = vi.fn()
  empQuery.mockReset()
  storeQuery.mockReset().mockResolvedValue([STORE])
  settlementOrdersQuery.mockReset().mockResolvedValue([ORDER])
  ;(globalThis as unknown as { defineWujiPageMeta?: unknown }).defineWujiPageMeta = vi.fn()
})

describe('afterSalesWorkOrderSubmit 页面', () => {
  it('未登记 ⇒ 提示 + 跳登记页，且**不发**门店/结算单请求（闸门）', async () => {
    empQuery.mockResolvedValue([])
    mount(Submit, { global })
    await flushPromises()

    expect(warning).toHaveBeenCalledWith('请先完成员工登记')
    expect(replace).toHaveBeenCalledWith({ name: 'register' })
    // 闸门的**第二半**才是它的重点：未登记的人不该看到可选门店 ⇒ 后续请求一个都不发。
    // 只断言 replace 的话，「跳了但还是把门店列表拉回来了」这条漏网。
    expect(storeQuery).not.toHaveBeenCalled()
    expect(settlementOrdersQuery).not.toHaveBeenCalled()
  })

  it('已登记 ⇒ 闸门放行：不跳转，门店加载一次；结算单**选店后才拉**（不是进页就拉）', async () => {
    empQuery.mockResolvedValue([REGISTERED])
    const w = mount(Submit, { global })
    await flushPromises()

    expect(replace).not.toHaveBeenCalled()
    // 放行的**行为凭据**：主表单渲染出来了（不是停在「正在验证员工信息」那一屏）
    expect(w.text()).toContain('选择门店')
    expect(w.text()).toContain('选择结算单')
    expect(storeQuery).toHaveBeenCalledTimes(1)
    // #500 段③：结算单按店拉取——没选店之前一个请求都不发
    expect(settlementOrdersQuery).not.toHaveBeenCalled()
  })

  it('选店 ⇒ 按店拉结算单；选单选行 ⇒ 报损数量上界取**选中行**的数量', async () => {
    empQuery.mockResolvedValue([REGISTERED])
    const w = mount(Submit, { global })
    await flushPromises()

    // 未选行 ⇒ 占位符不写上界（行数量为空则不设上限）
    expect(w.find('input[placeholder*="报损数量"]').attributes('placeholder')).toBe('请输入报损数量')

    // 页面里的 Select 顺序：门店 → 结算单 → 商品行。`<t-option>` 在 TDesign 里**不挂载**
    // （Select 从 slot 读 vnode 注册选项），点选这条路走不通，只能自己喂 v-model；
    // `@change` 处理器（拉结算单/清行）也要显式 emit——编程式 v-model 不触发 TDesign 的 change。
    // ⚠️ 行下拉带 `v-if="selectedOrder"` ⇒ **选单之后才挂载**，必须重新查询组件树再喂。
    let selects = w.findAllComponents(Select)
    await selects[0]!.vm.$emit('update:modelValue', STORE.id)
    await selects[0]!.vm.$emit('change', STORE.id)
    await flushPromises()
    expect(settlementOrdersQuery).toHaveBeenCalledWith('103')

    await selects[1]!.vm.$emit('update:modelValue', ORDER)
    await selects[1]!.vm.$emit('change', ORDER)
    await flushPromises()

    // 选行（页面的选中形状 = 行 + 所属单号——提交侧的四键之一）
    selects = w.findAllComponents(Select)
    await selects[2]!.vm.$emit('update:modelValue', { ...ORDER.lines[0]!, orderNo: ORDER.orderNo })
    await flushPromises()
    expect(w.find('input[placeholder*="报损数量"]').attributes('placeholder')).toContain('该行数量 30')
  })

  /**
   * F2 回归（独立评审）：**列表里有一条附件 ≠ 有一条可提交的附件**。
   *
   * 旧闸门数的是 `attachments.length`（列表长度），而发送侧按 `uploadStatus === 'completed'`
   * 过滤（`useWorkOrderSubmit`）。上传失败的行**留在列表里**（`useFileUpload` 的 failed 分支
   * 不删行）⇒ 闸门放行、过滤后 0 条 ⇒ `wuji-data` 的 `attachmentIds.length > 0 ? … : {}`
   * **不发** attachmentIds ⇒ 服务端 201 建单、**零附件**落库，而页面文案是「请至少上传一个附件」。
   */
  it('F2：列表里只有一条**上传失败**的附件 ⇒ 闸门拦住提交（与发送同口径）', async () => {
    empQuery.mockResolvedValue([REGISTERED])
    const w = mount(Submit, { global })
    await flushPromises()

    // ① 造一条**真**的失败件：驱动文件输入，让上传 reject。失败行按实现留在列表里。
    up.mockRejectedValue(new Error('boom'))
    const input = w.find('input[type="file"]')
    Object.defineProperty(input.element, 'files', {
      value: [new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' })],
      configurable: true,
    })
    await input.trigger('change')
    await flushPromises()

    // ② 其余必填项填满——不填的话闸门会被**别的**校验先拦下，这条用例就测不到附件闸门。
    //    门店/结算单/行下拉直接喂 v-model + change（`<t-option>` 不挂载，点选走不通，见上一条用例注）。
    //    行下拉带 v-if ⇒ 选单后重查组件树（同上一条用例）。
    let selects = w.findAllComponents(Select)
    await selects[0]!.vm.$emit('update:modelValue', STORE.id)
    await selects[0]!.vm.$emit('change', STORE.id)
    await flushPromises()
    await selects[1]!.vm.$emit('update:modelValue', ORDER)
    await selects[1]!.vm.$emit('change', ORDER)
    await flushPromises()
    selects = w.findAllComponents(Select)
    await selects[2]!.vm.$emit('update:modelValue', { ...ORDER.lines[0]!, orderNo: ORDER.orderNo })
    await w.find('input[placeholder*="报损数量"]').setValue('2')
    await w.find('textarea').setValue('外包装破损')
    await flushPromises()

    // ③ 点提交
    //    点之前的这条断言是本用例的**质量闸门**：`warning` 一律出自页面的必填校验 ⇒
    //    它一次没响过，等于「门店/单行/数量/原因都填合格了」。少了它，本用例可能因为
    //    「前面某个校验先响了」而红——那是红得不是地方，修好附件闸门它也不会变绿。
    expect(warning).not.toHaveBeenCalled()

    const submit = w.findAll('button').find((b) => b.text().includes('提交工单'))!
    await submit.trigger('click')
    await flushPromises()

    // 闸门必须拦住：一条 failed 的附件**不是**「至少一个附件」。
    // 先断 `woCreate`：它一旦被调用，就说明闸门**放行**了（失败信息里带调用次数，
    // 一眼能分辨「闸门没拦住」与「某个前置校验提前拦下」这两种红）。
    expect(woCreate).not.toHaveBeenCalled()
    expect(warning).toHaveBeenCalledWith('请至少上传一个附件')
  })

  it('源码里没有旧商品选择 / 订单明细 / 前端 OAuth / 附件的死 url 残留', async () => {
    // ⚠️ 走 vite 的 `?raw` 而**不是** `readFileSync(new URL(…, import.meta.url))`：happy-dom 环境下
    // `import.meta.url` 不是 file: 协议，Node 的 readFileSync 会抛 `The URL must be of scheme file`
    // （实测；计划 Task 8 初稿就是那个写法）。`?raw` 是 vitest 一等公民，Task 6 已用它跑绿。
    const src = (await import('./afterSalesWorkOrderSubmit.vue?raw')).default as string

    // ② 旧订单明细块与旧商品下拉都已退役（#500 段③：换「选店 → 选结算单 → 选行」三级）
    expect(src).not.toContain('currentOrder')
    expect(src).not.toContain('outbound_detail')
    expect(src).not.toContain('generateOrderNumber')
    expect(src).not.toContain('selectedProduct')
    expect(src).not.toContain(':value="product"')
    // 新选择面的绑定形状：行值摊上所属单号（提交侧四键之一），价格随单冻结的提示在场
    expect(src).toContain(':value="{ ...line, orderNo: selectedOrder.orderNo }"')
    expect(src).toContain('随单冻结')
    // ④ 页内前端微信 OAuth 是**整体删除**，不是被条件分支藏起来
    expect(src).not.toContain('open.weixin.qq.com')
    expect(src).not.toContain('wechat_openid')
    expect(src).not.toContain('window.w')
    // ⑥ 已完成附件的渲染必须走 previewUrl：域侧附件行上没有可读 url，
    //    留着 `.url` 那两处的症状是「附件上传成功但缩略图空白」。
    expect(src).not.toContain('attachment.url')
    expect(src).toContain('attachment.previewUrl')
  })
})
