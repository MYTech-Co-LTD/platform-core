# 问数三通道设计（系统内会话 / 系统外个人 Key / 企微 OpenClaw）

> 日期：2026-09-21 · 状态：设计稿（待评审后进实施计划）
> 前置：`2026-09-21-data-platform-layered-design.md`（七层架构、§10 fork #3 本文裁决）
> 实测基线：2026-09-21 本机真环境验证——平台 MCP 授权核心 11/11（词表裁剪/主体钉死/fail-closed/
> 回包带主体可审计）、直连无隔离证明（同一 pg_duckdb 连接跨主体聚合无拦截）、Metabase OSS
> SSO=付费墙而静态嵌入可用、Casdoor OIDC 发现端点在线。

---

## 0 一句话

**三条消费通道、一个授权核心**：问数权限只有一个强制点（平台问数服务内的授权核心），
三条通道只是三种「身份怎么带进来」的方式——系统内靠 Casdoor 会话，系统外靠个人 Key，
企微靠服务凭证 + 企微 userid 反查关联用户。分层设计 §10 fork #3（智能问数入口）据此裁决为
**平台 MCP/API 入口**，Metabase 定位收敛为「平台签名的嵌入图表」（页门，另文）。

## 1 总架构

```
┌─ 通道A 系统内 ─────────┐ ┌─ 通道B 系统外 ─────────┐ ┌─ 通道C 企微 ──────────────┐
│ console 对话面板        │ │ 外部 agent（Claude Code │ │ 企微 → OpenClaw Gateway    │
│ Casdoor 会话（cookie）  │ │ 等）+ 个人 Key           │ │ native plugin（服务凭证 +  │
│         │              │ │ Authorization: Bearer    │ │ 企微 userid）              │
└─────────┼──────────────┘ └──────────┼──────────────┘ └──────────┬────────────────┘
          ▼                           ▼                           ▼
┌──────────────────────── 平台问数 API（data-stack 模块挂载）─────────────────────────┐
│  鉴权中间件：session │ PAT │ 渠道凭证+userid → 统一解析成「请求者身份+实时 scopes」    │
│  ┌────────────────── 授权核心（单实现，2026-09-21 实测 11/11）──────────────────┐   │
│  │ 词表裁剪（scopes 外指标不可见）· 主体钉死（org 只来自身份解析）·              │   │
│  │ fail-closed（无身份/未授权/未声明一律拒）· 审计（身份/通道/指标/参数/行数/裁决）│   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│  LLM 编排（通道A 内置；通道B/C 的 LLM 在客户端/OpenClaw 侧）                      │
└───────────────────────────────┬─────────────────────────────────────────────────┘
                                ▼ 内网
                     pg_duckdb（物化层，连接跨主体——这正是授权核心必须在平台的原因）
```

**为什么三通道共用核心**：授权语义写两遍 = 第二套权限状态，必然漂移（对齐 data-analysis
权限架构长文对 fail-open/fail-close 混用的批判）。通道差别只允许存在于鉴权中间件一层。

## 2 设计一：系统内问数（登录人权限自动生效）

- **入口**：console 对话面板（data-stack 模块页面，模块 manifest 声明 scope，宿主门卫 fail-closed——既有机制）。
- **身份**：Casdoor OIDC 会话，既有登录闭环，零新增。
- **LLM 编排在平台后端**（已拍板）：前端只做对话 UI；问数服务在后端跑 LLM agent loop，
  工具即授权核心暴露的 `list_metrics` / `query_metric`（词表已按人裁剪）。
  理由：LLM key 在服务端 env 不落浏览器；审计集中；权限单点强制。
- **交付形态**：v1 流式文本+表格；图表渲染后置。
- **用户无感点**：进来就能问，能问什么 = 当前账号 scopes，改权限即时生效（裁决不进 token，
  对齐 data-analysis 长文「token 变薄」方向）。

## 3 设计二：系统外问数（个人 Key + MCP/skill）

- **Key 管理**（console 个人页新增「问数 Key」）：
  生成（32B 随机、仅展示一次、库内只存 SHA-256）/ 命名 / 吊销 / 最近使用时间。
- **权限语义**（已拍板）：**key = 身份凭证，权限实时跟随该用户**——与系统内同源同语义，
  不造第二套权限状态。审计按 `key_id` 区分人机。v2 可选：按 key 收窄 scope 子集。
- **平台 MCP server**：streamable HTTP，挂 data-stack 模块路由（`/api/modules/<data>/mcp`），
  `Authorization: Bearer <PAT>` → 解析用户 → 同一授权核心 → 同一对工具。
  该路由在 manifest 里声明（声明即授权，fail-closed 不豁免）。
- **消费方**：Claude Code / 任意 MCP client 配置一次即可问数；skill 文档作为补充形态（待沉淀）。
- **防护**：per-key 限速（防 agent 循环问数打爆 pg_duckdb，阈值实施期定）；吊销即时生效。

## 4 设计三：企微 × OpenClaw（对话识别身份，走系统内权限）

- **身份模型采 data-analysis 生产方案**（其 OpenClaw 机器人 2026-09-04 起在山海生产运行）：
  企微 userid 即身份，**不建绑定码子系统**。理由：内部人员身份的真相源就是企微
  （入职=企微同步），绑定码是多余且会漂移的第二份身份状态。
- **「绑定」动作 = 一次企微扫码登录**：platform-core 已有企微扫码登录闭环（WeKnora 山海实测：
  三参轮换/可信域名/可信IP），登录那一刻 Casdoor 落企微↔账号关联。此后该企微号的消息
  自动按关联用户执行。
- **链路**（⚠️ 硬约束：**必须 native plugin，不能直连远程 MCP**——data-analysis 实测：
  OpenClaw core 只给 native plugin 注入 `toolContext.requesterSenderId`，不透传给 `mcp.servers`）：

  ```
  企微消息（回调验签）→ OpenClaw Gateway
    → native plugin 读 requesterSenderId（可信 userid）
    → POST 平台问数 API { 渠道服务凭证, wecom_userid }
    → 平台：认证凭证 → Casdoor 按 userid 反查关联用户 → 实时权限 → 授权核心
  ```

- **未关联用户**：fail-closed 拒绝 + 回复扫码登录指引（关联即解锁，无需任何绑定开发）。
- **服务凭证**：渠道级 machine credential，openship env（isSecret），不进 LLM/用户上下文。
- **OpenClaw 侧 LLM**：客户部署自配（data-analysis 先例： wishub/DeepSeek 协议兼容）。

## 5 硬约束清单

1. **授权核心单实现**，三通道共用；任何通道不得自建权限判定。
2. **主体钉死**：org/主体值只来自平台身份解析；请求参数里出现即拒（`subject_pinned_by_platform`）。
3. **词表外指标对工具面不可见**——是「看不见」，不是「报错」。
4. **fail-closed**：无身份 / 企微未关联 / scope 不足，一律拒绝并给出可解释 reason。
5. **PAT 只存哈希**；服务凭证与 LLM key 只在服务端 env；任何 key 不进聊天记录/LLM 上下文。
6. **通道C 走问数 API 不走 MCP**（requesterSenderId 约束）；MCP 端点仅供通道B；通道A 用的是同核心的内部工具调用，不经 MCP 协议。
7. **审计三通道统一**：`(身份, 通道, key_id?, 指标, 参数, 行数, 裁决+reason, ts)`——出问题能回答
   「谁在哪个通道问了什么、为什么被拒」。
8. 回包**带钉死主体**（可审计性——实测中踩过的教训：投影不含 org 则客户端无法独立验证）。

## 6 待核实 / 待沉淀（不装绿）

| # | 项 | 状态 |
|---|---|---|
| 1 | Casdoor 按 wecom userid 反查关联用户的 API 形状 | **已核实**：就是 `casdoor.getUser(userid)`——企微 userid 即 Casdoor name（`apps/server/src/routes/auth-wecom.ts` 注释的既有语义），无需绑定表。T5 中间件按此实现，T10 e2e 用例 4 在真装配（MockCasdoor + 真 admin 会话）下端到端验证通过 |
| 2 | OpenClaw `requesterSenderId` 注入行为跨版本稳定性（以 data-analysis 实测为准） | 待核实（不影响本实现：通道 C 走问数 API `/query` 不经 `mcp.servers`，`requesterSenderId` 不在本链路上） |
| 3 | per-key 限速阈值、LLM 选型与成本（通道A 后端编排引入平台级 LLM key） | **已定**：per-key 限速默认 **60 次/分钟**（`DATA_QUERY_RATE_PER_MIN`，`config.ts` 缺省值；固定窗口按 keyId 分桶）；LLM 走 OpenAI 兼容端点（`DATA_LLM_BASE_URL` / `DATA_LLM_API_KEY` / `DATA_LLM_MODEL`，见根 `.env.example`），具体模型部署期配 |
| 4 | Metabase 锁参页门（per-requester locked param 嵌入） | 另文（BI 页门设计） |
| 5 | 通道B skill 文档形态 | 待沉淀 |

## 7 与既有文档的关系

- **落实** `2026-09-21-data-platform-layered-design.md` §10 fork #3 → 裁决：平台 MCP/API 入口；
  Metabase MCP（fork 关联项）仅限报表制作面（`2026-09-20-data-stack-module-design.md` M2），
  不承载问数身份。
- **采** data-analysis 生产先例：身份模型（企微 userid 即身份 + 服务凭证）；
  **不采**其 SQL 白名单模式——那是允许 LLM 写 SQL 的前提，本设计问数面只有已声明的指标工具，面更窄。
- 授权核心语义 = 2026-09-21 实测原型（`/tmp/iam-lab/`，11/11）的产品化。
