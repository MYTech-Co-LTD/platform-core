# T0 开箱验证 —— span 内容清单

> 计划：`docs/superpowers/plans/2026-10-16-askdata-loop-p1-t0-openbox.md` · issue **#741** · 执行 2026-10-16
> 本文件由 T0 的三个 task 陆续写入：**Task 1 基线** / Task 2 开箱 / Task 3 清单与判定。

## 0. 裁决前提

| 项 | 裁决 |
|---|---|
| **R1 隐私面** | 用户裁决 **认**——`captureContent: true` 会把业务正文 + 思考全文送进 OO |
| **R2 时段** | 用户指定 **现在**（2026-10-16 ~15:50 UTC / 北京 23:50，天然低峰）；中断代价实测值见 §2.3 |

## 1. 基线（Task 1，**只读**）

### 1.1 备份与配置现状

| 项 | 值 |
|---|---|
| 备份路径 | `/var/lib/docker/volumes/openship-platform-core-shanhai-openclaw_state/_data/openclaw.json.bak-t0-telemetry`（4766 B，权限 600 / uid 1000，与源一致） |
| 当前 `openclaw.json` | **4766 字节**（宿主与容器两侧一致） |
| 上次修改 | 2026-10-16 13:36:14 +0800 |
| **`diagnostics` 计数** | **0** —— 生产未配，与 spec §2.2 一致 |
| 顶层键 | `agents, channels, commands, gateway, meta, models, plugins, skills, tools, wizard` |

> 顶层键清单是 Task 2「深合并没写坏」的对照基线：开箱后除新增 `diagnostics` 外，这些键必须逐字不变。

### 1.2 开箱前通道健康基线

| 判据 | 值 |
|---|---|
| openclaw 容器 `healthz` | **200** |
| 会话库 `agents/main/.../openclaw-agent.sqlite` | 10,158,080 B |
| 会话库 `agents/wecom-dm-zhangduo/.../openclaw-agent.sqlite` | 667,648 B |
| 容器 → OO `https://observe.hookflow.cn/healthz` | **200** |

> 会话库规模是 Task 3「开箱后有没有新会话写入」的对照。

### 1.3 凭据取法（**只写「在哪、怎么取」，不含值**）

| 项 | 内容 |
|---|---|
| 位置 | **openclaw 宿主**的 `/etc/openobserve-ingest.env`（root-only `600`） |
| 键 | `OO_BASE` / `OO_ORG` / `OO_AUTH` / `OO_TOKEN` |
| 头形态 | `Authorization: Basic $OO_AUTH`——`OO_AUTH` 是**裸 base64**（`base64("<空用户名>:<token>")`） |
| 口径 | 该文件头注：自 2026-09-18 起改用 **ingestion token**（只写、可按机器单独停用），**机器上不再放用户口令** |
| 用法 | 只在宿主 shell 内 `source` 后直接写盘；**不经任何容器、不进 exec 输出** |

（`OO_BASE` = `https://observe.hookflow.cn`；`OO_ORG` = `3IJ5tM4en3A06FzcJQhoHMTl4Xe`——两项都非密，仓内已有记载。）

### 1.4 执行期对计划的订正（一手实测，Task 2 按订正走）

计划 Task 2 Step 1 有**三处错**，Setup 期实测订正如下：

| # | 计划原文 | 实测订正 |
|---|---|---|
| 1 | 用 OO **root 账号**（容器 env `ZO_ROOT_USER_*`），需跨机传凭据 | 用 **openclaw 宿主**现成的 `/etc/openobserve-ingest.env`（**只写 ingestion token**，更合最小权限）；**不必跨机传凭据** |
| 2 | 头写 `Basic base64(email:password)` | `OO_AUTH` 是**裸 base64**（空用户名）⇒ 头写 `Authorization: Basic $OO_AUTH`；写成 `Authorization: $OO_AUTH` 会 **401** |
| 3 | 在容器内改配置（凭据要进容器） | 宿主**可直接写卷** `/var/lib/docker/volumes/openship-platform-core-shanhai-openclaw_state/_data/openclaw.json` ⇒ 在**宿主 shell 内** source 后深合并写盘，密钥永不进容器/exec 输出 |

**凭据射程实测**（宿主上跑，凭据未出 shell）：

| 探针 | 结果 |
|---|---|
| `POST $OO_BASE/api/$OO_ORG/otlp_probe/_json`（对照） | **200** |
| `POST $OO_BASE/api/$OO_ORG/v1/traces`（OTLP/JSON） | **206 partialSuccess**——仅因探针把 `startTimeUnixNano` 写成 `0`（1970、超出保留期）被拒 1 个 span ⇒ **端点与鉴权本身是好的** |
| 用 `Authorization: $OO_AUTH`（漏 `Basic ` 前缀） | **401** ⇒ 坐实订正 #2 |

## 2. 开箱（Task 2，**动生产**）

### 2.1 写入方式

在 **openclaw 宿主**上 `source /etc/openobserve-ingest.env`（凭据只在宿主 shell 内），
用 python3 对卷内 `openclaw.json` 做**深合并**（不是整体覆盖），写回后权限 600 / uid 1000 保持不变。

写入的 `diagnostics` 段（`Authorization` 脱敏）：

```json
"diagnostics": {
  "enabled": true,
  "otel": {
    "enabled": true,
    "protocol": "http/protobuf",
    "traces": true, "metrics": false, "logs": false,
    "tracesEndpoint": "https://observe.hookflow.cn/api/<org>/v1/traces",
    "headers": { "Authorization": "<REDACTED>" },
    "serviceName": "openclaw-askdata",
    "captureContent": true
  }
}
```

### 2.2 深合并没写坏的判据

| 判据 | 结果 |
|---|---|
| `JSON ok` | ✅ |
| 顶层键 | 开箱前 `agents,channels,commands,gateway,meta,models,plugins,skills,tools,wizard`（10）→ 开箱后 **加入 `diagnostics`**（11），**其余逐字未变** |
| 差异 diff（脱敏） | **只多出 `diagnostics` 块**（`242a243,258`）+ 文件末尾补了一个换行；无其它改动 |
| 文件字节数 | 4766 → **5238** |
| 容器视角 | 读到 5238 B、`diagnostics` 计数 1、otel 块逐字正确 |

### 2.3 重启与中断实测

| 事件 | 时间（UTC） |
|---|---|
| 重启前健康检查（宿主 `127.0.0.1:20001/healthz`） | `15:33:45Z` → **200** |
| 执行 restart（openship MCP `.../restart`） | `15:33:45Z` 后；新容器 `666b5220f5c2` |
| `healthz` 恢复 200 | **`15:34:36Z`** ⇒ 容器层中断 **≈ 24–51 秒** |
| `[gateway] ready` | `15:34:36Z` |
| `[wecom] WebSocket connected` → **`Authentication successful`** | `15:34:38Z` ⇒ **通道层中断 ≈ 1 分钟** |

⚠️ **订正一个既有口径**：仓内（与知识库）记的「一次切换造成约 **18 分钟**通道中断」是**切换通道插件**的代价；
**普通容器重启的实测代价是 ~1 分钟**（本例）。两者别混用。

### 2.4 两处观察（不作为本次判据）

1. **端口重映射**：openship service 配置里写的是 `127.0.0.1:18789:18789`，但**实际发布成 `127.0.0.1:20001->18789/tcp`**
   ⇒ 宿主侧健康检查要打 **20001**，打 18789 会 `000`（连接失败）。**别据此判「容器没起来」。**
2. **一条既存告警**（与本次改动无关）：启动日志里 `typed hook "before_prompt_build" blocked because
   non-bundled plugins must set plugins.entries.wecom-openclaw-plugin.hooks.allowConversationAccess=true`——
   是**企微插件**的钩子被闸挡，非本次新增；zh-thinking 自己的 `before_prompt_build` 注册成功（有独立日志行）。

### 2.5 回滚点

```sh
cp -p /var/lib/docker/volumes/openship-platform-core-shanhai-openclaw_state/_data/openclaw.json.bak-t0-telemetry \
      /var/lib/docker/volumes/openship-platform-core-shanhai-openclaw_state/_data/openclaw.json
# 再走一次 openship MCP restart
```

### 2.6 otel 导出是否真在跑？

**日志里没有任何 `otel`/`telemetry` 行**——既无报错也无确认。⇒ 本步只能排除「文件没写对」；
**真正的判据是 Task 3 有没有 span 落到 OO**（计划 Step 4 的原话）。


## 3. 清单与判定（Task 3）

### 3.1 第一次取证：**零 span** —— 根因是插件没装

按计划开完 telemetry 后，真机发消息（bot 确实跑了：会话库 717 → **722** 事件），但 OO 里
**traces 流数为 0**。逐层排查后定位根因：

| 排查 | 结论 |
|---|---|
| bot 有没有跑？ | ✅ 会话库新增 5 事件 |
| 日志有没有报错？ | ❌ 无，连 otel 相关行都没有（只有 `config change detected` / `requires gateway restart`） |
| **OTel SDK 在哪？** | `/app/extensions/diagnostics-otel/`（**是 openclaw 的扩展，不在核心**；`@openclaw/diagnostics-otel` v2026.9.9） |
| **插件启用了吗？** | ❌ **`openclaw plugins list` 显示 `diagnostics-otel` 状态 = disabled**；启动日志的插件表（17 个）里没有它 |

⇒ **根因：`diagnostics.otel` 的配置项写了也没人读——导出器插件未安装/未启用。**
其 README 原文：「Enable the plugin, set `diagnostics.otel.enabled` to `true`…」。
（spec §2.2 漏了这层，本段即订正。）

**处置**：`openclaw plugins enable diagnostics-otel`（写进 `plugins.entries.diagnostics-otel = {enabled:true}`）→ 重启。
重启后插件表 **18 个**，`diagnostics-otel` 在列 ✅。

### 3.2 第二次取证：**span 全通**（CLI 轮触发）

用 `openclaw agent --agent main -m "查一下昨天的净销售额"` 触发一轮（**CLI 轮不走渠道**，但足够产出 span）。

**span 树**（`service_name = openclaw-askdata`，主 trace 8 个 span，总时长 10.78 s）：

```
openclaw.harness.run (10.78s)
└─ openclaw.run (10.77s)
   ├─ openclaw.context.assembled
   ├─ openclaw.model.call (2.78s)  →  openclaw.tool.execution (6ms)
   ├─ openclaw.model.call (3.08s)  →  openclaw.tool.execution (1ms)
   └─ openclaw.model.call (2.64s)
```

⇒ **工具调用序列与回包逐次可辨、按序、带耗时**。

**属性词表**（实测出现）：

| 组 | 键 |
|---|---|
| GenAI 语义约定 | `gen_ai_input_messages` · **`gen_ai_output_messages`** · `gen_ai_tool_call_arguments` · `gen_ai_tool_call_result` · `gen_ai_tool_call_id` · `gen_ai_tool_name` · `gen_ai_tool_definitions` · `gen_ai_usage_*` · `gen_ai_provider_name` · `gen_ai_request_model` · `gen_ai_response_model` |
| openclaw 内容面 | `openclaw_content_input_messages` · **`openclaw_content_output_messages`** · `openclaw_content_tool_input` · `openclaw_content_tool_output` · `openclaw_content_tool_definitions` |
| openclaw 运行面 | `openclaw_outcome` · **`openclaw_errorcategory`** · `openclaw_channel` · `openclaw_trigger` · `openclaw_agent` · `openclaw_model_call_usage_reasoning_output_tokens` · `openclaw_model_call_time_to_first_byte_ms` · `openclaw_context_*` |

### 3.3 四个必答问题（spec §2.3 U1）

| # | 问题 | **答案** | 逐字证据 |
|---|---|---|---|
| **Q1** | `gen_ai.output.messages` 在不在？ | ✅ **在，且有内容** | 每个 `openclaw.model.call` 上都有；例：`[{"role":"assistant","parts":[{"type":"tool_call","name":"query_data","id":"call_00_FKXNS…","arguments":{"args":{"bizday":{"from":"2026-10-15","to":"2026-10-15"},"total":true},"metricId":"lemeng:retail:net_sales"}}],"finish_reason":"toolUse"}]` |
| **Q2** | 里面有没有**思考正文**？ | ❌ **没有——思考块在，但正文被抹掉** | `openclaw_content_output_messages` = `[{"role":"assistant","content":[{"type":"reasoning",`**`"redacted":true`**`},{"type":"toolCall",…}]}]`——**有 `reasoning` 块、无文本字段**。对照：`gen_ai_input_messages` 里 `thinking`/`reasoning` 关键词计数均为 **0**（parts 只有 `text`/`tool_call`/`tool_call_response`）。 |
| **Q3** | 有没有截断？ | ⚠️ **无法判**（无正文可截）；其余字段未见截断 | 输出消息 261–276 字符；`gen_ai_input_messages` 约 8 万字符、**完整**（`openclaw_context_*_chars` 与之一致） |
| **Q4** | 工具调用序列在不在？ | ✅ **在，且完整** | `openclaw.tool.execution` span ×2 + `gen_ai_tool_call_arguments/result/name/id` 均有值；两次调用**都失败**于同一原因，回包 `{"error":"无法识别请求者身份（requesterSenderId 缺失）…"}`——**这就是一条现成的「撞墙轨迹」** |

**旁证**：`openclaw_model_call_usage_reasoning_output_tokens` = **70 / 211 / 81** ⇒ 思考**确实产生了、也被计数**，
即**不是模型没输出思考**，而是 openclaw 的诊断序列化**主动把它标成 `redacted`**。
（对照：同一轮的**会话 transcript 里那句中文思考是有正文的**，见 spec §2.1。）

**redaction 有没有开关？** 已查：`diagnostics.otel` 配置面只有 `endpoint` / `logs.*` 等，
**没有** `redact*` 配置键；`redactSensitiveText` / `redactPatterns` 等 260+ 处全是内部函数。
且 redaction 针对的是 **reasoning part**，而 `captureContent` 的字段（`inputMessages`/`outputMessages`/
`toolInputs`/`toolOutputs`/`systemPrompt`/`toolDefinitions`）**没有任何一个控制 reasoning** ⇒ 换对象形也解不开。

### 3.4 判定（计划 Step 4 的二选一）

**Q2 不绿 ⇒ 判定：采集主通道回退「会话库」**（spec §2.1 那条，已实证可行、思考逐字、按 `seq` 有序）。

**但本次并非白开箱**——OO 侧仍然拿到了会话库**没有**的东西：

| OO 能给、会话库不能给 | 说明 |
|---|---|
| 工具调用的**耗时**与 **span 树** | `openclaw.model.call` 2.6–3.1 s × 3、`tool.execution` 毫秒级 |
| **token 用量**（含 cache 读写、reasoning tokens） | `gen_ai_usage_*` / `openclaw_model_call_usage_*` |
| **错误分类** | `openclaw_errorcategory`、`openclaw_outcome` |
| 首字节延迟、请求/响应字节数 | `openclaw_model_call_time_to_first_byte_ms` 等 |
| 与公司观测面天然同栈 | 告警/看板可直接建在 OO 上 |

⇒ **结论建议**：P1 的通道形态改为 **「会话库出思考与对话序列（主）+ OO 出运行面指标（辅）」**，
而不是二选一。**这条要用户裁决后才能改写 T1–T4。**

---

## 4. 阶段二 T1：轨迹导出（会话库 → OO）

### 4.1 轨迹字典（**实测，后续判据一律引用本表，不许再猜**）

库：`<卷根>/agents/<agent>/agent/openclaw-agent.sqlite` → 表 `transcript_events(session_id, seq, created_at, event_json)`

- `created_at` = **epoch 毫秒**
- `event_json.type` ∈ `session` / `message` / `model_change` / `thinking_level_change` / `custom` / `custom_message` / `reset`
- `message` 事件里：
  | role | part type | 形状 |
  |---|---|---|
  | assistant | `thinking` | `{type, thinking, thinkingSignature}` ← **思考正文在 `thinking`** |
  | assistant | `text` | `{type, text}` |
  | assistant | `toolCall` | `{type, id, name, arguments(dict)}` |
  | **toolResult** | **`text`** | `{type, text}`；**消息层**带 `toolCallId` / `toolName` / `details` / **`isError`** |
  | user | — | `content` **可能是字符串**，也可能是 `[{type:"text",...}]` |

### 4.2 两个实测坑（都是「回读 OO」才发现的，改前代码 13673 行→改后 566 行）

| # | 坑 | 后果 |
|---|---|---|
| 1 | **`content` 是字符串时按 list 迭代** | **逐字符**摊行：`"一"`/`"查"`/`"下"` 各占一行，668 个事件摊出 **13,244 条垃圾行** |
| 2 | **按 part type 判 toolResult** | toolResult 的 part type 是 `text`、**角色**才是 `toolResult` ⇒ **`tool_result` 一条都没有**，全落进 `text` |

⇒ 判据：**字符串整体一行；角色优先于 part type**。

### 4.3 另两个实测事实

- **OO 的 `_json` 批量端点遇到「流正在删除」会回 400**（`Error# stream [...] is being deleted`），且**墓碑会持续一段时间不让重建同名流**（实测 >2 分钟仍未释放）⇒ **删流后要换名重投**，别以为是自己 payload 的错。
  （我第一次 400 曾误归因给「字段值为 null」，**那是错的**；真实原因是删流竞态。丢 None 的改动本身无害，保留。）
- **流名最终定为 `askdata_conv`**（原计划写 `askdata_trace`——该名被删除墓碑占用，改用语义更准的 `askdata_conv`）。**计划文档中的 `askdata_trace` 一律按 `askdata_conv` 读。**

### 4.4 首投判据（T1 验收）

| 判据 | 实测 |
|---|---|
| 首投行数 | **566**（668 事件 × 多 part） |
| OO 回执 | `{"code":200,"status":[{"name":"askdata_conv","successful":566,"failed":0}]}` |
| **回读 OO 计数**（按 kind） | `thinking` **137** · `text` 113 · `tool_call` 91 · `custom` 69 · `user` 67 · `tool_result` 59 · `other` 30 |
| **幂等复跑** | `rows=0 watermark=668` ⇒ **不翻倍** ✅ |
| 思考正文可查 | ✅ 逐字（含 T0 那条 CLI 轮的真实轨迹） |

---

## 5. 阶段二 T2：撞墙判据（三条结构型）

### 5.1 设计订正：判据**读本机会话库**，不读 OO

计划原文说「从 OO 读 `askdata_trace` 再判」。**实测行不通**：宿主那份凭据是 **ingestion token（只写）**——
打 `_search` 直接 **401**（文件头注原话就写着「只写、可按机器单独停用」）。

⇒ 改为**读本机 sqlite**（思考的事实源本来就在那），只**写** OO。好处：宿主凭据保持只写（合最小权限），
且判据与导出共用**同一套 normalizer**（`attribute.py` 用 importlib 加载 `export-transcript.py`，避免两处口径漂移）。

### 5.2 三条规则与首轮命中

| rule | 判据（纯结构） | layer_hint | 首轮(ver1) | **修后(ver2)** |
|---|---|---|---|---|
| `same_tool_retry` | 同 session 内相邻两条 `tool_call` 的 `tool_name` 与 `tool_args` **全同** | 指令面 | 21 | **21** |
| `same_error_twice` | 相邻两条 `tool_result` 文本全同 **且 `is_error`** | 指令面/回包面 | 19 | **18** |
| `truncated_then_recall` | `tool_result` 含**真** `"truncated":true`，其后又有同名工具调用 | 指令面 | 8 | **0** |
| | | **合计** | 48 | **39** |

### 5.3 人工核对抓到的两类**误判**（计划的 Step 2 就要求记这个）

| # | 误判形态 | 根因 | 修法 |
|---|---|---|---|
| 1 | **两条相同的「成功」回包**被当成「同错两次」（实例：`{"status":"ok",…,"total":"3018431.77"}` 两条全同） | 规则只比文本，**没强制 `is_error`** | 加 `and cur[1]`（即 is_error 必须为真） |
| 2 | **成功回包里那句 `"truncated":false`** 被裸词 `truncated` 命中（8 条**全是**假阳性） | 裸子串匹配 | 只认 `"truncated":true` |

修后复核：被判中的 39 条逐条查过 `is_error`，**全部为 `true`** ⇒ 无残留假阳性；
`truncated_then_recall` 在本次窗口内**真命中为 0**（不是判据没跑，是这个数据里确实没有真截断）。

### 5.4 计划的硬性自检：**通过**

T0 那条现成的撞墙轨迹（CLI 轮里模型对同一 `query_data` 试了两次、两次同样失败于 `requesterSenderId 缺失`）
被**同时**两条规则命中：

| seq | rule | evidence |
|---|---|---|
| 665 | `same_tool_retry` | `a_seq=662, tool=query_data, args={"args":{"bizday":{"from":"2026-10-15","to":"2026-10-15"},"total":true},"metricId":"lemeng:retail:net_sales"}` |
| 666 | `same_error_twice` | `a_seq=663, text={"error":"无法识别请求者身份（requesterSenderId 缺失）…"}` |

### 5.5 已知边界（如实带走）

- **`askdata_stuck` 流会跨轮累积**：本轮先投了 ver1 的 48 条、再投 ver2 的 39 条，**没有去重或清理**
  （同名流删不掉——见 §4.3 的删除墓碑）。⇒ 消费方必须 `where rule_ver=2`；**P2 应加 run_id 并做幂等**。
- **判据只覆盖结构型三条**：需要阈值的（行数超预算、触顶 `MAX_AGENT_TURNS`）**未实现**，等真实分布出来再定。
- `same_tool_retry` 会把**内层调度工具**（`tool_name='tool_call'`）的重复也计入——它是不是「撞墙」待定，先如实留着。
