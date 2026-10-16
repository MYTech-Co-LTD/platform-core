# data-query-plugin（问数通道 C 客户端）

OpenClaw native tool-plugin：把可信企微 userid（`toolContext.requesterSenderId`）+ 渠道凭证
转发到平台问数 API，权限由 platform-core 授权核心按人裁决（词表裁剪/主体钉死/fail-closed）。
本插件**零权限逻辑**。

设计：`docs/superpowers/specs/2026-10-10-shanhai-openclaw-wecom-design.md`。

## 工具

| 工具 | 作用 |
|---|---|
| `list_metrics` | `GET {DATA_API_BASE}/metrics`——当前用户可见词表（按人裁剪） |
| `query_data` | `POST {DATA_API_BASE}/query` `{metricId,args}`——查数，回包带 subject |

## message_sending 钩子：新鲜度行确定性附加（2026-10-16）

`query_data` 成功回包带 `freshness_line` 时按会话（`sessionKey`，拿不到落全局槽）捕获，
外发消息经 `message_sending` 钩子**先剥掉模型自己写的 📅 行、再把服务端正典行钉在末尾**
（strip-then-append 天然去重；TTL 10 分钟，过期/无捕获原样放行；钩子任何分支不 throw，fail-open）。
模型侧指令同步改为「系统自动附加，不要自己写 📅 行」（工具描述 + SKILL.md）。

**返回形状是硬契约**：要改写必须返回对象 `{ content: <新文本> }`——openclaw 主机读的是
`sendingResult.content`（`src/infra/outbound/deliver-hooks.ts` `applyMessageSendingHook`），
**裸字符串会被读成「未改写」**，行不会附上；不改写才返回 `undefined`。

纯逻辑在 `lib.js`（`createFreshnessStore` / `stripFreshnessLines` / `appendFreshnessLine` /
`makeFreshnessSendingHook`），`node --test lib.test.js` 直跑。

**真机首验判据 = 行确实出现在企微消息里**（不是「日志打了注册成功」就算过）：
发一条问数真机消息，看末尾是否恰有一行 📅 且等于服务端 `freshness_line`。

### 运行时门禁（订正 2026-10-16）

`message_sending` 是**消息/通道类**钩子，**不适用** `hooks.allowConversationAccess`
（该闸只对 conversation 类钩子生效——`src/plugins/hook-types.ts` 的 `CONVERSATION_HOOK_NAMES`
清单里没有 `message_sending`；zh-thinking 用 `before_prompt_build` 才需要它）。
**不要为本插件去开 `allowConversationAccess`**（那会多授一份更宽的权限）。行若没附上，
真因看返回形状（上）与捕获（TTL/会话键），不是这个闸。

### 已知边界：陈旧行窗口（≤ TTL）

捕获**不消费**（消费会被同轮先前的外发——如「先说一句要查什么」的进度消息——吃掉行），
代价是同会话内 ≤10 分钟内的**任意**后续外发都可能附上上一次查询的行（跨指标连问时该行属上一
指标；数据未变的同一指标观感无害）。收紧手段是 `runId`（两侧一致才附加），但**当前 openclaw
不给 `message_sending` 传 `runId`**（`hook-message.types.ts`："not yet plumbed through the
outbound delivery path"），工具 ctx 亦无 `runId` ⇒ 收紧**当前不生效**，恒走 sessionKey+TTL
回退。该窗口因此是**现状**而非边角，待上游接通 runId 后自动收窄。

## env 契约（容器注入）

| 键 | 说明 |
|---|---|
| `DATA_API_BASE` | 平台问数 API 基址；缺省 `http://server:13000/api/modules/data`（同 compose 网络服务名） |
| `DATA_WECOM_CHANNEL_KEY` | 渠道服务凭证；与 platform `server` 服务的同名 env **同值**（openship env isSecret） |

## 本地测试

```bash
node --test lib.test.js
```

## 部署

插件源码随仓分发：compose 把本目录只读挂载到容器 `/opt/plugins/data-query-plugin`，
容器内 `openclaw plugins install -l /opt/plugins/data-query-plugin` 一次性注册（写进 state 卷的
openclaw.json，跨部署持久）；部署更新代码后重启容器即生效。
初始化步骤见计划 Task 4（openship exec 操作）。
