# 企微问数 bot 流式展示「思考过程」设计（通道 C · WS 路径）

> 日期：2026-10-12 · 状态：设计定稿（人已同意开工）· issue：**#580**
> 前置：`2026-10-10-shanhai-openclaw-wecom-design.md`（通道 C 部署面）与其 issue #569/#577
> 诉求（用户原话）：「不降模型 think 档；我要的是**体感 agent 在工作**，把 think 内容也放出来……**但要明确区分 thinking 和正式内容**；有正式内容出来就只展示正式内容也行。」

---

## 0 一句话

给**官方企微插件**补上 WS 路径缺失的 `onReasoningStream` 桥，把模型思考以企微原生 `<think>…</think>` 流式呈现、与正文明确分离；补丁**自带退场判据**（上游做了就自动让路），并对 9 条质量判据逐条真机取证、与社区实现 A/B 对照。

## 1 现状与根因（源码级，2026-10-12 实测）

| 事实 | 证据 |
|---|---|
| core 只在通道**提供 `onReasoningStream`** 且 `turn.reasoningLane.stream` 为真时，才把 reasoning 回调给通道 | `/app/dist/agent-runner.runtime-*.mjs`：`onReasoningStream: turn.reasoningLane.stream ? (payload)=>… : turn.streamReasoningInProgressDraft ? …` |
| 官方插件 **未提供**该回调 | `@wecom/wecom-openclaw-plugin@2026.9.15` `dist/src/monitor.js`：`replyOptions` 里只有一条**注释掉**的 `onPartialReply` |
| 官方插件的 `<think>` 处理**只在 webhook 路径** | `dist/src/webhook/monitor.js:655` 有 `thinkRegex`；WS 路径 `dist/src/monitor.js` 无 |
| 官方插件 dist 全文 **0 处** `reasoning` | grep 结果 |
| 企微**支持**该能力 | 官方社区答复「用官方 SDK + 客户端最新版」；官方推荐做法「先回 `<think>…</think>`，再回正文」 |
| 社区已实现（可作参考与对照基线） | `@sunnoy/wecom@3.4.0`：`wecom/ws-monitor.js:2335` 提供 `onReasoningStream`；`buildWsStreamContent()` 拼 `<think>{reasoning}</think>\n{visible}`；`think-parser.js` 做标签归一与代码块豁免；另做 800ms 节流；`ensureDefaultSessionReasoningLevel()` 写会话 `reasoningLevel: "stream"` |

⇒ **官方插件功能缺口**，非平台限制；我们补的是它没做的那一块。

## 2 设计

### 2.1 三层可拆的补丁（核心：**能低成本退场**）

| 层 | 做法 | 退场成本 |
|---|---|---|
| ① **构建期 vendor** | 官方插件在**镜像构建期**装到 `/opt/plugins/wecom-openclaw-plugin`，再用 `openclaw plugins install -l /opt/plugins/wecom-openclaw-plugin` 注册（与 `deploy/openclaw/data-query-plugin` 同法）。**不再手装进 state 卷**（卷内手装不可复现、且会被卷遮蔽镜像内容） | 删一行 Dockerfile |
| ② **自跳过判据** | 补丁脚本先扫描目标源码：**若已含 `onReasoningStream` ⇒ 直接退出、不打补丁**，并打印「上游已支持，跳过我方补丁」 | **零**：上游发布后只改版本号，补丁自动失效 |
| ③ **配置闸门** | `channels.wecom.streaming.reasoning.enabled`（默认 `true`）；补丁另暴露必要参数（节流间隔等） | 一条 `config set` 关停，不动代码 |

> **不得**把补丁做成「散落多处的源码改动」——必须是**单一注入点 + 独立实现文件**，保证可读、可撤、可 rebase。

### 2.2 补丁内容（三块，参考实现已读全）

1. **桥接**：在插件 WS 路径的 `replyOptions` 注入 `onReasoningStream(payload) → state.reasoningText`。
2. **渲染**：`buildWsStreamContent({reasoningText, visibleText, finish})`
   - 未闭合态：`<think>{reasoning}`（配合活行，见判据 9）
   - 有正文或 `finish=true`：`<think>{reasoning}</think>\n{visible}`
3. **会话开关**：模仿 `ensureDefaultSessionReasoningLevel()`，为该会话写 `reasoningLevel: "stream"`（幂等、不清他值）。

### 2.3 与社区不同的**加严项**

- **判据 5（差异化重点）**：企微流内容上限 **20480 字节**，思考与正文**共用**该额度。本设计**正文优先**：接近上限时**截断思考**（保留正文完整），并在思考块内标注截断。社区源码未见明确处理抢位。

## 3 质量判据（9 条，逐条真机取证）

| # | 判据 | 取证 |
|---|---|---|
| 1 | reasoning **渐进**推送（含节流），非憋到最后 | 网关日志帧序列时间/长度 |
| 2 | `<think>` 在**正文出现或 finish 时闭合** | 帧内容含 `</think>` |
| 3 | **未闭合流式态**正确处理（收到一半标签不裸露） | 帧内容检查 |
| 4 | **代码块内 `<think>` 不误判** | 构造含代码的提问 |
| 5 | **20480 字节下正文优先、思考截断** | 构造长思考 + 长正文，验正文完整 |
| 6 | 6 分钟流窗口（`846608`）过期降级不被破坏 | 现有兜底不回归 |
| 7 | **有正文后不再往正文掺思考** | 帧内容检查（用户点名的要求） |
| 8 | 补丁出错**不影响正文投递**（保守退化） | 注入故障验证 |
| 9 | 思考未到前给「等待模型响应 Ns」活行（防静态沙漏） | 真机体感 + 帧内容 |

**A/B 对照**：同一 prompt、同一 bot，分别跑「我们补丁版」与「社区 `@sunnoy/wecom` 版」，比对**实际发出的流式帧序列**（`streamId=… finish=…` + 每帧长度）与**人体感**；差异写进验收报告，不平则改到平。

## 4 工作分期

| 期 | 内容 | 产出 | 门 |
|---|---|---|---|
| **0** | 本设计稿 + issue #580 | docs PR | ✅ 本文件 |
| **1** | 构建期 vendor + 补丁骨架 + **自跳过判据**（**不含功能**） | PR，**零行为变化** | 部署后一切照旧（现状不回归） |
| **2** | reasoning 桥：1/2/3/6/7/9 | PR | 真机可见思考流式 |
| **3** | 边界与加严：4/5/8 | PR | 判据 5 通过 |
| **4** | A/B 对照 + 真机体感验收 + **向腾讯提正式需求**（附实测证据） | 验收结论回帖 #580 | 9 条全过 + A/B 无劣化 |

## 5 风险与回退

| 风险 | 处置 |
|---|---|
| 补丁打不中（上游小版本改动） | 版本钉死 `2026.9.15`；打不中则**构建失败并告警**（不静默降级） |
| 思考流拖慢/挤掉正文 | 判据 5 加严 + 配置闸门即时关停 |
| 上游升级后补丁与官方实现**并存**（双写） | 自跳过判据按源码存在性判断；官方落地后**必须**删补丁步骤（写进本稿 §2.1） |
| 企微客户端版本导致思考不流式 | 现象与官方社区同源；先要求**客户端升到最新**再判（官方答复口径） |

## 6 明确不做

- **不降 `thinkingDefault`**（用户明示）。
- **不改用自建应用（Agent）模式**：该模式**无流式载体**，换过去等于放弃思考展示。
- **不给 `data-query` 插件塞通道职责**：思考渲染属通道面，保持工具插件纯净。
- 本期不引入 `@sunnoy/wecom` 作为运行时依赖（它只作**对照基线**）。
