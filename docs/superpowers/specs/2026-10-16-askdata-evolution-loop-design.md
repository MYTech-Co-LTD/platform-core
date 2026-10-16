# 智能问数全链条演进回路 —— 设计（spec）

> 日期 2026-10-16 · issue #741 · 状态：**待评审**（P1 设计；P2/P3 只定骨架）
> 上游取证：本 spec §2 的每条「已验」都有 2026-10-16 的一手实测支撑，出处见各条。

## §0 问题

问数 bot（openclaw 通道 C）撞墙时，今天**看不见**：

- 服务端 `data.query_audit` 每次查询落一行（`verdict` / `reason` / `row_count`），但那是**孤立行**——
  看不到「一轮对话内第 1 次撞、第 2 次又撞、第 3 次才对」的**序列**，也看不到两次之间模型改了什么。
- 模型**为什么**撞（思考里的推理）从未被采集。企微那套思考流（#580/#585/#596）只做**渲染**，不落盘。
- 于是「该补哪个环节」只能靠人拍脑袋；`SKILL.md` 的 v2 方法论与工具描述是**手写、离散、改一次算一次**的产物，**没有回路**。

## §1 目标与判据

**目标**：把「撞墙」从看不见变成 **看得见 → 归得准 → 改得动 → 验得了**。

| 段 | 判据（可机器判） |
|---|---|
| **看得见** | 任取一条真实历史会话，在平台里**完整重放**一轮：问 → 思考 → 工具调用序列（含参数）→ 回包 → 答 |
| **归得准** | 对人工标注的 N 条撞墙，判据命中；**漏判/误判逐条记录**（不追求一次到位的准确率，追求**误差可见**） |
| **改得动** | 软层：候选指令改动 + 卡门；硬层：报告 → issue → PR（人审） |
| **验得了** | 真实对话统计看趋势；改指令前用**回放集**卡门 |

**验收口径**：P1 的验收 = 前两段。后两段是 P2/P3 的目标，P1 只保证它们**有数据可用**。

## §2 现状取证（已验 / 未验）

### 2.1 采集面：思考是落盘的 ✅ 已验（生产容器 OpenClaw **2026.9.9** bcfc888）

会话库 `/home/node/.openclaw/agents/<agent>/agent/openclaw-agent.sqlite` → 表 `transcript_events`（`session_id` / `seq` / `event_json` / `created_at`）。

实测（`main` agent，近 4 天）：**9 个会话 / 407 个事件**。

| 维度 | 实测值 |
|---|---|
| 事件类型 | `session` 9 · **`message` 303** · `model_change` 8 · `thinking_level_change` 13 · `custom` 65 · `custom_message` 7 · `reset` 2 |
| 消息内容类型 | **`assistant/thinking` 132** · `assistant/text` 71 · **`assistant/toolCall` 88** · `toolResult/text` 56 |

⇒ **思考正文逐字落盘**，在 `message.content[].thinking` 里（中文原文实测抓到）。
同库另有 `session_transcript_fts`（全文索引）、`message_tool_run_outcomes`（含 `session_key` / `run_id` / `run_status`）。

**关键约束**：通用插件钩子**不带**思考正文——`llm_output` 载荷只有 `reasoningEffort`（档位字符串）。
思考的两个真实落点是 **① 通道侧回调** `replyOptions.onReasoningStream`（企微思考流补丁已接在这，但目前只用于渲染）
与 **② 会话 transcript**（本节）。

### 2.2 导出面：openclaw 原生 OTel，OO 已验通 ✅ 已验

**openclaw 侧**（源码 + 生产容器核实）：`diagnostics.otel.*` 全套（`enabled` / `endpoint`·`tracesEndpoint` /
`protocol` / `headers` / `serviceName` / `traces` / `sampleRate` / `flushIntervalMs`），以及
**`captureContent`（默认 off）**。⚠️ **订正（2026-10-16 写计划时查源码）**：它**不是逐字段可配**——
`resolveDiagnosticModelContentCapturePolicy` 只认布尔，`true` 命中即套**一组固定预设**：
`inputMessages` / `outputMessages` / `toolInputs` / `toolOutputs` / `toolDefinitions` 全开、
**`systemPrompt` 关**（源码 2026.8.1 读出的形状）。部署版字节码是 `captureContent !== void 0` 形态
（与 8.1 的 `=== true` 不同）⇒ **是否也接受对象形（逐字段）待 T0 核**；T0 一律先用布尔 `true`。
`protocol` **只接受 `http/protobuf`**。生产当前**一个都没配**。

**部署产物 span 属性词表**（`/app` 实测）：`gen_ai.input.messages` · **`gen_ai.output.messages`** ·
`gen_ai.tool.call.arguments|result|id` · `gen_ai.conversation.id` · `gen_ai.agent.name|id` ·
`openclaw.outcome|reason|errorCategory`。

**OO 摄取**（全链实测）：

| 探测 | 结果 |
|---|---|
| `POST {OO_BASE}/api/{org}/otlp_probe/_json`（对照） | 200 · `successful:1 failed:0` |
| `POST {OO_BASE}/api/{org}/v1/traces`（OTLP/**JSON**） | **200** · `{"partialSuccess":null}` |
| `POST {OO_BASE}/api/{org}/v1/traces`（OTLP/**protobuf**，107B 自造载荷） | **200** |
| 回读 span | `trace_id` / `service_name=otlp-probe` / 2 spans **落库** ✅ |
| openclaw 容器 → OO `healthz` | **200 / 46ms** |
| openclaw 容器 → `/v1/traces` 无凭据 | **401**（端点存在、要求鉴权） |

OO 环境：**v1.0.4**，容器 `openship-openobserve-openobserve`（宿主 `127.0.0.1:20002`），s3 + postgres meta + nats；
traces 落 stream **`default`**（type=traces）；**OO 原生认 GenAI 语义约定**（回包里直接给 `gen_ai_input_messages` / `gen_ai_usage_*`）。

### 2.3 未验（P1 的前置，**不许当已知**）

| # | 待验 | 为什么必须验 | 代价 |
|---|---|---|---|
| U1 | 开 `captureContent` 后**思考是否原样落进 `gen_ai.output.messages`**、有无截断 | 静态推断「会」（策略抓响应消息 + 该消息含 thinking），但**无真机证据** | 改 `openclaw.json` + 重启容器，实测一次切换约 **18 分钟通道中断** |
| U2 | traces 流的**保留期**（现读得 `data_retention: 0`，实际天数未定） | 循环要「持续演进」，保留不够就白搭 | 读/改流设置 |
| U3 | 生产 org / stream 的**权限面与投放目标** | 开 `captureContent` = 业务正文 + 思考全文进 OO | 裁决（见 §6） |

## §3 架构

```
[采集]  openclaw ──OTel(http/protobuf)──▶ OpenObserve(traces 流)
   │                                          │
   └─(兜底/回捞历史)─ 会话库 sqlite ───────────┤
                                              ▼
[归因]  读 OO（OO MCP）→ 撞墙识别 → 归因到层 → 轨迹/撞墙事件落库
                                              │
[动作]  软层：候选指令改动 → 回放卡门 → 采纳/回滚（P2）
        硬层：报告 → issue → PR（人审）（P3）
        人的面：报告（P2/P3）
```

**三条已定的取舍**（原设计里的「轨迹存哪」「导出怎么触发」两条因 §2.2 取证而**作废**）：

1. **采集主通道 = OO OTLP**，不自建平台端点、不写导出插件（openclaw 原生支持）。
2. **会话库退为兜底与历史回捞**——它保真度最高（思考/工具调用/回包逐字、按 `seq` 有序）且**能捞历史**，
   但需要自建导出机制；OO 只能从现在起。**P1 先做 OO 通道；会话库回捞列为 P1 的可选加分项。**
3. **服务端 `data.query_audit` 退为交叉核对**（租户归属 / 口径 / 计数对账），**不再是骨**——
   轨迹侧已自带回包内容。⇒ **不必给审计表加 sessionKey 列**（原设计里的那块硬骨头随之消失）。

## §4 P1 详细设计

### T0 开箱验证（前置，动生产）

按 §2.3 U1：低峰期开最小子集（`traces: true` + `captureContent: true`——**它是布尔预设，没有更细的子集可分**，见 §2.2 订正），
发一条真机问数消息，**看 span 里到底有什么**。

- 验到 ⇒ 走 §4 T1 的 OO 主通道；
- 没验到（截断/缺失/不含思考）⇒ **退回会话库通道**（§2.1 已证可行），本 spec §4 的 T1 相应改写。

**T0 的产出 = 一张「span 实际内容」清单**，它是后面所有判据的输入，必须先有。

### T1 轨迹采集

- openclaw 侧：`diagnostics.otel` 指向 OO，`serviceName` 用稳定名（建议 `openclaw-askdata`），
  `headers` 带鉴权；配置落**状态卷**（注意：状态卷重建会回退，seed 步骤要含它——与既有 `tools.toolSearch` 同坑）。
- 落点：OO traces 流（按 §6 的隐私裁决选 org/stream）。
- **不新造存储**：轨迹的真身在 OO，平台侧只存**归因产物**（撞墙事件表）。

### T2 撞墙判据（P1 要钉的第一件事）

候选判据（**数值待 T0/T1 的真实数据标定，本 spec 不预先编**）：

| # | 形态 | 信号来源 |
|---|---|---|
| 1 | 同轮内**同类错误连续 ≥2 次** | toolResult 的 error reason |
| 2 | **同一工具调用原样重试**（纪律明令禁止） | toolCall 参数序列 |
| 3 | `truncated` 后**未收窄**就再查 | toolResult + 后续 toolCall |
| 4 | **行数超预算**（区间 >4 天裸拉明细） | toolCall args + 回包行数 |
| 5 | **触顶**（通道 A 的 `MAX_AGENT_TURNS`；通道 C 的轮内工具调用数异常） | 轮内 toolCall 计数 |
| 6 | **跨轮同模式复现**（用户追问 / 纠正） | 跨 session 的用户消息 |

### T3 归因到层（判据 → 环节的映射）

| 撞墙形态 | 归因到 |
|---|---|
| `BAD_PARAM`（键名 / 形状错） | 指令面（SKILL/工具描述没讲清）或 回包面（error detail 不够明确） |
| 词表外指标 / 权限不足 | 数据面（词表裁剪）或 人的面 |
| `truncated` 未收窄、行数超预算、同一调用原样重试 | 指令面（规则没被遵守 / 没写清） |
| 新鲜度字段误用（自己写 📅 行等） | 回包面 |
| 服务端 502 / `warehouse_transient` | 数据面（基础设施），**不是模型的问题** |

### T4 真实统计面

从撞墙事件表出：首答即中率 / 同轮重试次数 / 超预算查询数 / 触顶次数，**按指标分组**。

### T5 非目标（P1 明确不做）

不改 `SKILL.md`、不改任何工具描述、不自动改任何东西、不建回放集（P2）、不动服务端审计表结构。

## §5 验收

| 判据 | 怎么验 |
|---|---|
| **看得见** | 任取一条真实历史会话（T0/T1 之后产生的），在平台里完整重放一轮 |
| **归得准** | 人工标注 5~10 条已知撞墙 → 跑判据 → **漏判/误判逐条记录**（误差可见即达标，不设准确率门槛） |
| **不碰生产** | 导出是只读 + 出站推送；**真机发一条问数消息，确认 bot 回复不变** |

## §6 风险与待裁决

| # | 事项 | 性质 |
|---|---|---|
| R1 | **隐私面**：开 `captureContent` = 业务正文 + 思考全文进 OO ⇒ OO 侧 **org/stream 权限**与**保留期**（U2）要一并定 | **待裁决** |
| R2 | **动生产**：改 `openclaw.json` + 重启容器，实测一次切换约 18 分钟通道中断 | 须挑低峰 |
| R3 | **配置落状态卷**：卷重建会回退 ⇒ seed/初始化步骤必须含它 | 已知坑 |
| R4 | **OO 保留期**若短于演进周期，轨迹会被清掉 ⇒ 要么调保留期，要么把归因产物落平台 PG（**归因产物落库是 P1 的一部分**，与轨迹分开） | 设计已规避 |
| R5 | **版本漂移**：openclaw 升级可能改钩子/属性名/会话库 schema；OO 升级可能改端点 | 巡检项 |

## §7 拆解与顺序

```
P1 采集与归因（本 spec 主体）  ──▶  P2 软层自动演进（指令面 + 回放卡门）  ──▶  P3 硬层人审（回包面/代码）
```

**P2 的 spec 必须在 P1 之后写**——回放集怎么建、卡门判据怎么定，要拿 P1 的真实数据说话（YAGNI）。

## §8 关联

- issue #741（本 spec 的伞）
- 既有面：#583（思考流式验收）、#542（OO 告警腿治本）、#538（监控职责分工）
- 经验库：《OpenObserve 接入手册》§3.11（OTLP traces 接入实测）、《OpenClaw 钩子面与「思考过程」落点》
- 相关正典：`docs/data-platform-handbook.md`（采集正典，本回路是**读侧观测**，不改采集链路）
