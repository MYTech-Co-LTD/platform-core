# wecom-plugin-patch —— 官方企微插件「思考流」构建期补丁

给官方插件 `@wecom/wecom-openclaw-plugin` 补上 WS 路径缺失的 `onReasoningStream` 桥，
把模型思考按「折叠帧契约」流式呈现。设计正典：
`docs/superpowers/specs/2026-10-12-shanhai-openclaw-reasoning-stream-design.md`（issue #580 / #596）。

- `apply.mjs` — 构建期改官方插件源码，注入 5 个锚点（顶层 import / `replyOptions` 回调 /
  占位常量 / 终帧投递 / finish 帧）；锚点不唯一即失败退出（**不静默降级**）。
- `reasoning-bridge.mjs` — 独立实现文件：帧组装（§2.4 帧契约）+ 300ms 节流 +
  20480 字节上限下正文优先截断。
- `*.test.mjs` — `node --test` 直跑，不依赖 openclaw（`deploy/openclaw/**` 不在 CI
  覆盖内，见 issue #583）。

## 插件升级时的动作清单（定案 2026-10-12，每次升级必走）

每次升级官方企微插件版本，按**三态**走：

1. **bump 版本 → 构建**。`apply.mjs` 自动判：
   - 官方**已实现**（monitor 源码已含 `onReasoningStream`）⇒ 补丁**自动退出、一字不改**
     ⇒ 用官方；可顺手删掉 Dockerfile 里的补丁步骤；
   - 官方未实现、锚点全命中 ⇒ 补丁照打；
   - **锚点漂移 ⇒ 构建失败**（设计行为，别静默跳过）⇒ 人工核对该版本：官方自带思考流
     → 删补丁步骤；没有 → 按新版源码修 `apply.mjs` 锚点（锚点必须验唯一，改完跑
     `node --test apply.test.mjs reasoning-bridge.test.mjs`）。
2. **部署后真机验一轮折叠**（企微真机发一条、等它思考；CLI 轮不走通道，验不出）。
   判三点：思考中动画、终帧折叠成条、点开可见思考文本。
3. **警惕自跳过的盲区**：判据只认「源码含 `onReasoningStream`」，**不验帧形态**——
   官方实现了但发帧形态不符折叠契约（如中间帧闭合 ⇒ 文本态）时，跳过反而丢折叠。
   真机验挂了就恢复补丁步骤，并对照设计稿 §2.4 帧契约核查官方帧形态。

归因实证（「折叠每一环都是补丁产物」的帧序列证据）与协议定案记录见 WeKnora
研发运维经验库条目 `23fb20ff`（§9）。
