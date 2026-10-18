# modules/notify/novu —— 通知文案正典与播种

**这里存的是 notify 通知层的 Novu 文案正典**（`workflows.ts` 的 `WORKFLOW_COPIES`）；Novu 侧是它的投影。

## 为什么文案在 platform-core，而不是与工单的文案合在一处

2026-10-18 架构决策（选项 B）：**文案随事件语义走，由生产者自持。**

- 共享注册表 = 跨产品爆炸半径 + 测试耦合。直接证据：工单的 `WORKFLOW_COPIES` 测试断言
  「**所有**文案必须含 `{{ticketId}}`」——platform-core 的条目挤进同一张表就得削弱别人产品的守卫。
- 机制重复（播种约 60 行）是这里**较小的恶**。抽公共工具记为演进项，**触发条件：出现第三个生产者**。

## 交付路径（不可跳步）

```
① 改 workflows.ts（文案唯一事实源）
② Dev 播种：NOVU_API_BASE=… NOVU_API_KEY=… pnpm exec tsx modules/notify/novu/cli.ts
③ 人审线上渲染（§2.6 门禁分层：文案 = 低频 × 大，外发不可撤回）
④ sync 到生产（Novu 生产建 workflow 一律 401，只能 Dev 建再 sync）
```

## 两条硬纪律（本目录测试守着）

1. **变量一律摊平**——不得写 `{{payload.X}}`（Novu 3.19 的 `getCompilePayload` 会摊平 payload，
   写它渲染为空）。
2. **markdown 链接必须闭合**——`]({{link}})` 不能漏右括号。issue #44 实测：存量 9 条漏括号，
   企微把尾部链接渲染成字面文本。

## ⚠️ 已知边界（交付时须标注）

播种是 **create-if-absent**——**改文案不会收敛存量**（dashboard 或早期手工建的条目会与 repo 漂移）。
我们这批是新名字，create 路径够用；但**将来改文案要收敛，必须走「比 content → 漂移即 PUT」的
deliver 路径**（本仓暂未实现；同类问题见 `data-platform-scaffold` issue #44）。
