// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TDesign, { Select } from 'tdesign-vue-next'

/**
 * ⚠️ `vi.mock` 的工厂会被提升到文件顶部 ⇒ 工厂里引用的外部变量**必须**一起 `vi.hoisted`，
 * 否则报 `Cannot access 'X' before initialization`。计划 Task 6 的订正表第 5 条已实证过这一点，
 * 而 Task 8 的测试初稿同样缺这一步 —— 这里按订正执行。
 */
const { replace, back, success, warning, woCreate, empQuery, storeQuery, productQuery } = vi.hoisted(() => ({
  replace: vi.fn(),
  back: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  woCreate: vi.fn(),
  empQuery: vi.fn(),
  storeQuery: vi.fn(),
  productQuery: vi.fn(),
}))

vi.mock('vue-router', () => ({ useRouter: () => ({ replace, back }), useRoute: () => ({ query: {} }) }))
vi.mock('@/shims/wuji-data', () => ({
  employee_info: { query: (...a: unknown[]) => empQuery(...a) },
  store_info: { query: (...a: unknown[]) => storeQuery(...a) },
  product_archive: { query: (...a: unknown[]) => productQuery(...a) },
  after_sales_work_order: { create: (...a: unknown[]) => woCreate(...a) },
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
  store_info: '3',
  status: '通过',
  _ctime: '',
  _mtime: '',
}

/** 商品行（shim 的 `ProductRow` 形状）——② 的报损数量上界就取它的 `basic_quantity` */
const PRODUCT = { id: 7, product_name: '苹果', basic_quantity: 100, basic_unit_price_minor: 500 }

// TDesign 组件要显式装上，否则 `<t-select>` / `<t-card>` 不渲染成真元素。
// ⚠️ **不要**加 `stubs`（Task 6 订正表第 6 条：`false` 是破坏性 no-op stub，会吞掉整棵子树）。
const global = { plugins: [TDesign] }

beforeEach(() => {
  replace.mockClear()
  back.mockClear()
  success.mockClear()
  warning.mockClear()
  woCreate.mockReset().mockResolvedValue({ id: 1 })
  up.mockReset().mockResolvedValue({ id: 42, objectKey: 'k', uploadUrl: 'u', expiresIn: 60 })
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:local-preview')
  globalThis.URL.revokeObjectURL = vi.fn()
  empQuery.mockReset()
  storeQuery.mockReset().mockResolvedValue([])
  productQuery.mockReset().mockResolvedValue([])
  ;(globalThis as unknown as { defineWujiPageMeta?: unknown }).defineWujiPageMeta = vi.fn()
})

describe('afterSalesWorkOrderSubmit 页面', () => {
  it('未登记 ⇒ 提示 + 跳登记页，且**不发**门店/商品请求（闸门）', async () => {
    empQuery.mockResolvedValue([])
    mount(Submit, { global })
    await flushPromises()

    expect(warning).toHaveBeenCalledWith('请先完成员工登记')
    expect(replace).toHaveBeenCalledWith({ name: 'register' })
    // 闸门的**第二半**才是它的重点：未登记的人不该看到可选门店 ⇒ 后续两句请求一个都不发。
    // 只断言 replace 的话，「跳了但还是把门店列表拉回来了」这条漏网。
    expect(storeQuery).not.toHaveBeenCalled()
    expect(productQuery).not.toHaveBeenCalled()
  })

  it('已登记 ⇒ 闸门放行：不跳转，门店/商品各加载一次，表单出来', async () => {
    empQuery.mockResolvedValue([REGISTERED])
    const w = mount(Submit, { global })
    await flushPromises()

    expect(replace).not.toHaveBeenCalled()
    // 放行的**行为凭据**：主表单渲染出来了（不是停在「正在验证员工信息」那一屏）
    expect(w.text()).toContain('商品名称')
    expect(storeQuery).toHaveBeenCalledTimes(1)
    expect(productQuery).toHaveBeenCalledTimes(1)
  })

  it('报损数量的上界取自**选中的商品**（商品下拉绑的是行对象，不是主键）', async () => {
    empQuery.mockResolvedValue([REGISTERED])
    productQuery.mockResolvedValue([PRODUCT])
    const w = mount(Submit, { global })
    await flushPromises()

    // 未选商品 ⇒ 上界 0
    expect(w.find('input[placeholder*="报损数量"]').attributes('placeholder')).toContain('最大0')

    // 商品下拉是页面里的**第一个** Select（商品卡在门店卡之前）。
    // 直接驱动它的 v-model：`<t-option>` 在 TDesign 里**不挂载**（Select 从 slot 读 vnode 注册选项，
    // 不渲染成组件），实测 `findAllComponents({name:'TOption'})` 恒为 0、选项面板也不在树里
    // ⇒ 点选这条路走不通，只能自己喂 v-model。
    await w.findAllComponents(Select)[0]!.vm.$emit('update:modelValue', PRODUCT)
    await flushPromises()

    // 上界变成**商品的** basic_quantity。
    // ⚠️ 这条钉的是**消费侧**（报损数量上界取的是 `selectedProduct` 的 `basic_quantity`，即
    // 选中项得是个**行对象**）；它**不能**证明模板的 `:value` 绑的是行对象还是主键——喂进来的是
    // 什么它就只能验什么（实测：把模板改回 `:value="product.id"` 这条照样绿）。
    // 绑定的那一半由下面第 3 条用例的源码级断言（`:value="product"`）兜住。
    expect(w.find('input[placeholder*="报损数量"]').attributes('placeholder')).toContain('最大100')
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
    productQuery.mockResolvedValue([PRODUCT])
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
    //    商品/门店下拉直接喂 v-model（`<t-option>` 不挂载，点选走不通，见上一条用例注）。
    await w.findAllComponents(Select)[0]!.vm.$emit('update:modelValue', PRODUCT)
    await w.findAllComponents(Select)[1]!.vm.$emit('update:modelValue', 3)
    await w.find('input[placeholder*="报损数量"]').setValue('2')
    await w.find('textarea').setValue('外包装破损')
    await flushPromises()

    // ③ 点提交
    //    点之前的这条断言是本用例的**质量闸门**：`warning` 一律出自页面的必填校验 ⇒
    //    它一次没响过，等于「商品/门店/数量/原因都填合格了」。少了它，本用例可能因为
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

  it('源码里没有订单选择 / 前端 OAuth / 附件的死 url 残留', async () => {
    // ⚠️ 走 vite 的 `?raw` 而**不是** `readFileSync(new URL(…, import.meta.url))`：happy-dom 环境下
    // `import.meta.url` 不是 file: 协议，Node 的 readFileSync 会抛 `The URL must be of scheme file`
    // （实测；计划 Task 8 初稿就是那个写法）。`?raw` 是 vitest 一等公民，Task 6 已用它跑绿。
    const src = (await import('./afterSalesWorkOrderSubmit.vue?raw')).default as string

    // ② 订单块整块被商品块取代
    expect(src).not.toContain('currentOrder')
    expect(src).not.toContain('outbound_detail')
    expect(src).not.toContain('generateOrderNumber')
    // ② 的另一半：商品下拉必须绑**行对象**（`selectedProduct` 的终态），页面才读得到
    //    `basic_quantity`。绑成 `product.id` 的话上界恒为 0——页面上不报错，只是报损数量
    //    被静默压成 0，属于最难发现的一类回归，所以在这里把它钉住。
    expect(src).toContain(':value="product"')
    expect(src).not.toContain(':value="product.id"')
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
