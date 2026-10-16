# 智能问数演进回路 P1 实施计划（阶段一：T0 开箱验证）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在生产 openclaw 上打开 OTel 导出指向 OO，发一条真机问数消息，产出一张**「span 里到底有什么」的内容清单**，据此判定 P1 的采集主通道走 OO 还是回退会话库。

**Architecture:** 只做**配置 + 取证**，不写业务代码。改 `openclaw.json`（状态卷）加 `diagnostics.otel` 段 → 重启容器 → 真机发消息 → 从 OO 读回 trace 并逐字段清点 → 把判定与依据落成清单文档。本阶段**产出的清单是 T1–T4 的唯一输入**，所以本计划只覆盖 T0。

**Tech Stack:** openship MCP（唯一通道：service exec / service restart）；OpenObserve `v1.0.4`（OTLP 摄取 + MCP 读）；OpenClaw `2026.9.9`。

## Global Constraints

以下数值一律**逐字**取自 spec（`docs/superpowers/specs/2026-10-16-askdata-evolution-loop-design.md`，已合 `1522cff`）：

- **动生产有中断代价**：改 `openclaw.json` + 重启容器，实测一次切换约 **18 分钟通道中断** ⇒ **必须挑低峰，且必须有用户明确点头（R2）**。没点头不许执行 Task 2。
- **隐私面必须先裁决（R1）**：`captureContent: true` 会把**业务正文 + 思考全文**送进 OO。R1 未决不许执行 Task 2。
- `captureContent` 是**布尔预设**，没有更细的子集可开（spec §2.2 订正）：命中 `true` 即 `inputMessages` / `outputMessages` / `toolInputs` / `toolOutputs` / `toolDefinitions` 全开、`systemPrompt` 关。
- OTLP **只接受 `http/protobuf`**（spec §2.2）。
- 配置落在**状态卷** `/home/node/.openclaw/openclaw.json`（服务 env `OPENCLAW_CONFIG_PATH`）——**卷重建会回退**，所以 Task 1 必须先备份。
- **密钥只写「在哪、怎么取」，不写明文**；取用只在同一个 shell 内完成，不许回显。
- 提交用 Conventional Commits；PR **`Refs #741`**（实现未完成，不写 Closes）。
- 一切运维走 **openship MCP**，不裸 SSH。

**关键坐标（本次已实测确认，可直接用）：**

| 项 | 值 |
|---|---|
| openclaw 服务 | project `proj_GLXUtN2bJ92DpPrS` / serviceId `svc_3R9wVrQSz__9nwgc` |
| OO 宿主 | server `3d5ed127-5f8c-440d-bb72-a97fb62a6432`（容器 `openship-openobserve-openobserve`） |
| OO OTLP 端点 | `https://observe.hookflow.cn/api/<org>/v1/traces` |
| 凭据取法 | OO 容器 env `ZO_ROOT_USER_EMAIL` / `ZO_ROOT_USER_PASSWORD`；`OO_AUTH` = base64(`email:password`) |

---

## File Structure

| 文件 | 责任 |
|---|---|
| `docs/superpowers/notes/2026-10-16-t0-span-inventory.md` | **本阶段唯一交付物**：span 内容清单 + 判定 + 依据（新建目录 `docs/superpowers/notes/`） |
| `docs/superpowers/specs/2026-10-16-askdata-evolution-loop-design.md` | 回填 §2.3 的 U1 结论（`—` → 实测值） |

无业务代码、无迁移、无新端点。

---

### Task 1: 开箱前基线（**只读**，不动生产）

**Files:**
- Create: `docs/superpowers/notes/2026-10-16-t0-span-inventory.md`（本节先落「基线」段）

**Interfaces:**
- Consumes: 无
- Produces: 备份文件的绝对路径 + 凭据取法（供 Task 2/3 引用，**不产生明文**）

- [ ] **Step 1: 确认 R1/R2 已裁决**

问用户两句话，**拿到明确答复再往下**：① 隐私面（业务正文 + 思考全文进 OO）认不认？② 挑哪个低峰时段？
R1/R2 任一未决 ⇒ **停在本步**，不要往下做。

- [ ] **Step 2: 备份 `openclaw.json`（卷重建/回滚都要它）**

openship MCP `post_projects_by_id_services_by_serviceId_exec`，参数：`id=proj_GLXUtN2bJ92DpPrS`、`serviceId=svc_3R9wVrQSz__9nwgc`：

```sh
cp -p /home/node/.openclaw/openclaw.json /home/node/.openclaw/openclaw.json.bak-t0-telemetry
ls -l /home/node/.openclaw/openclaw.json.bak-t0-telemetry
echo '--- 当前是否有 diagnostics 段（应为无匹配）---'
grep -c 'diagnostics' /home/node/.openclaw/openclaw.json || true
```

预期：文件存在、字节数 > 0；`diagnostics` 计数为 **0**（= 生产当前未配，与 spec §2.2 一致）。
**把备份路径与当前字节数逐字记进清单文档**。

- [ ] **Step 3: 记录开箱前的通道健康基线**

同一 exec：

```sh
echo '--- 容器健康 ---'
node -e "fetch('http://127.0.0.1:18789/healthz').then(r=>{console.log('healthz',r.status);process.exit(0)}).catch(e=>{console.log('healthz ERR',e.message);process.exit(0)})"
echo '--- 会话库规模（作为「开箱后新增」的对照）---'
ls -l /home/node/.openclaw/agents/main/agent/openclaw-agent.sqlite 2>/dev/null
echo '--- 出站可达 ---'
curl -sS -o /dev/null -w 'oo healthz %{http_code}\n' --max-time 10 https://observe.hookflow.cn/healthz
```

预期：`healthz 200`；OO `200`。
**把三项输出逐字记进清单文档的「基线」段。**

- [ ] **Step 4: 记下凭据取法（不取值）**

在清单文档写清：OO 凭据来自 OO 容器 env 的 `ZO_ROOT_USER_EMAIL` / `ZO_ROOT_USER_PASSWORD`，
`OO_AUTH` = 该二者的 base64；**Task 2 在同一个 shell 内取用并直接写进配置，不回显**。
（不要在文档里留任何明文或 base64 串。）

- [ ] **Step 5: 提交基线**

```bash
git add docs/superpowers/notes/2026-10-16-t0-span-inventory.md
git commit -m "docs(askdata): #741 T0 开箱前基线（备份路径 + 通道健康 + 凭据取法）"
```

---

### Task 2: 开 telemetry + 重启 + 验生效（**动生产：18 分钟中断**）

**Files:**
- Modify（生产卷内）：`/home/node/.openclaw/openclaw.json`
- Modify: `docs/superpowers/notes/2026-10-16-t0-span-inventory.md`（落「开箱」段）

**Interfaces:**
- Consumes: Task 1 的备份路径
- Produces: 生效的 `diagnostics.otel` 配置（供 Task 3 取数）；中断时长实测值

- [ ] **Step 1: 深合并写入 telemetry 段（**同一个 shell 内取凭据，不回显**）**

⚠️ 必须**深合并**而不是整体覆盖——`openclaw.json` 里已有用户在用的键（plugins / tools / gateway 等），整体覆盖会把 bot 写坏。

openship MCP `..._exec`：

```sh
cat > /tmp/add-otel.mjs <<'EOF'
import fs from 'node:fs'
const P = '/home/node/.openclaw/openclaw.json'
const cfg = JSON.parse(fs.readFileSync(P, 'utf8'))
const email = process.env.ZO_EMAIL, pass = process.env.ZO_PASS
if (!email || !pass) { console.error('NO_CREDS'); process.exit(1) }
const auth = 'Basic ' + Buffer.from(email + ':' + pass).toString('base64')
cfg.diagnostics = cfg.diagnostics ?? {}
cfg.diagnostics.enabled = true
cfg.diagnostics.otel = {
  ...(cfg.diagnostics.otel ?? {}),
  enabled: true,
  protocol: 'http/protobuf',
  traces: true,
  metrics: false,
  logs: false,
  tracesEndpoint: 'https://observe.hookflow.cn/api/<ORG>/v1/traces',
  headers: { Authorization: auth },
  serviceName: 'openclaw-askdata',
  captureContent: true,
}
fs.writeFileSync(P, JSON.stringify(cfg, null, 2) + '\n')
console.log('WROTE ok')
EOF
C=openship-openclaw-openclaw
E=$(docker inspect "$C" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep -E '^ZO_ROOT_USER_(EMAIL|PASSWORD)=')
ZO_EMAIL=$(printf '%s\n' "$E" | sed -n 's/^ZO_ROOT_USER_EMAIL=//p')
ZO_PASS=$(printf '%s\n' "$E" | sed -n 's/^ZO_ROOT_USER_PASSWORD=//p')
echo "creds: email=$([ -n "$ZO_EMAIL" ] && echo y || echo n) pass=$([ -n "$ZO_PASS" ] && echo y || echo n)"
```

⚠️**上一条命令是在 OO 宿主上跑的**（OO 容器在那里）。**写入 `openclaw.json` 的那条要在 openclaw 容器里跑**，
而凭据要从 OO 侧取——**两步分开执行，凭据经 openship env（isSecret）传递，或由执行者手工在同一 shell 内串联**；
**绝不把 base64 串写进仓、写进 PR、或回显到会话**。
`<ORG>` 用 OO 的 org 标识（默认流走 `default`；要独立流先按 spec §6 R1 决定）。

- [ ] **Step 2: 校验 JSON 合法 + 记录改动 diff**

```sh
node -e "JSON.parse(require('fs').readFileSync('/home/node/.openclaw/openclaw.json','utf8'));console.log('JSON ok')"
diff <(sed 's/\(Authorization":\s*"\)[^"]*/\1<REDACTED>/' /home/node/.openclaw/openclaw.json.bak-t0-telemetry) \
     <(sed 's/\(Authorization":\s*"\)[^"]*/\1<REDACTED>/' /home/node/.openclaw/openclaw.json) || true
```

预期：`JSON ok`；diff **只多出 `diagnostics` 段**，其余键逐字未变（这就是「深合并没写坏」的判据）。
**diff 脱敏后贴进清单文档。**

- [ ] **Step 3: 重启容器，记录中断起止**

记录重启前 UTC 时间 → 执行 openship MCP `post_projects_by_id_services_by_serviceId_restart`（`id`/`serviceId` 同上）→ 轮询 `healthz` 直到 200，记录恢复时间。

```sh
date -u +%FT%TZ   # 重启前
# — 执行 restart —
# 恢复后：
date -u +%FT%TZ
node -e "fetch('http://127.0.0.1:18789/healthz').then(r=>{console.log('healthz',r.status);process.exit(0)}).catch(e=>{console.log('ERR',e.message);process.exit(0)})"
```

预期：`healthz 200`。**把中断时长（恢复 − 重启）逐字记进清单文档**——它是 R2 代价的实测值。

- [ ] **Step 4: 验配置真的被吃进去（不是「写了就算」）**

```sh
grep -c '"diagnostics"' /home/node/.openclaw/openclaw.json
ls -l /home/node/.openclaw/logs/ 2>/dev/null
```

预期：`diagnostics` 计数 ≥1；日志目录有新写入。
⚠️ **「配置写了」≠「导出在跑」**——真正的判据在 Task 3 的 span 落库。本步只是排除「文件没写对」。

- [ ] **Step 5: 若任一步异常 → 立即回滚**

```sh
cp -p /home/node/.openclaw/openclaw.json.bak-t0-telemetry /home/node/.openclaw/openclaw.json
```

再走一次 restart，确认 `healthz 200`。回滚后**停在 Task 1**，把异常逐字记进清单文档并回报用户。

- [ ] **Step 6: 提交开箱记录**

```bash
git add docs/superpowers/notes/2026-10-16-t0-span-inventory.md
git commit -m "docs(askdata): #741 T0 开箱记录（配置 diff + 中断实测 + 回滚点）"
```

---

### Task 3: 取数 → 产出 span 内容清单 → 判定分支 → 收口

**Files:**
- Modify: `docs/superpowers/notes/2026-10-16-t0-span-inventory.md`（落「清单」与「判定」段）
- Modify: `docs/superpowers/specs/2026-10-16-askdata-evolution-loop-design.md`（§2.3 U1 回填）

**Interfaces:**
- Consumes: Task 2 生效的导出
- Produces: **span 内容清单**（字段名 → 有无内容 → 是否含思考正文）+ **通道判定**（OO 主通道 / 回退会话库）

- [ ] **Step 1: 真机发一条问数消息**

在企微里向问数 bot 发一条**会产生工具调用**的问题（例：「查一下昨天的净销售额」）。
⚠️ **CLI 轮不走通道**（知识库既有结论）——必须真机发。
记下发送时刻（UTC）。

- [ ] **Step 2: 从 OO 读回 trace**

用 openobserve MCP：`GetLatestTraces`（org=`default`、stream=`default`、时间窗=发送时刻前后 10 分钟）。
拿到 `trace_id` 后 `GetTraceDetails` 取全部 span。

预期：出现 `service_name=openclaw-askdata` 的 trace；span 数 ≥1。

- [ ] **Step 3: 逐字段清点，产出清单**

对 trace 的每个 span，**逐字段**记进清单文档的表格：字段名 / 有无值 / 值的形状（长度、是否被截断）/ 是否含**思考正文**。

必须回答的四个问题（spec §2.3 U1）：

| # | 问题 | 判据 |
|---|---|---|
| Q1 | `gen_ai.output.messages` 在不在？ | span 属性里该键存在且非空 |
| Q2 | 里面有没有**思考正文**？ | 能与企微里看到的思考对上（中文原文） |
| Q3 | 有没有**截断**？ | 与原始长度比对；注意 spec 提到的 20480 字节一类的上限 |
| Q4 | 工具调用序列在不在？ | `gen_ai.tool.call.arguments` / `.result` 是否有值、是否按序 |

- [ ] **Step 4: 判定分支（写进清单文档，二选一，不许含糊）**

- **Q1–Q4 全绿** ⇒ 判定 **OO 主通道**；P1 的 T1 按 spec §4 走，下一步补写 T1–T4 计划。
- **任一不绿**（尤其 Q2 思考缺失 / Q3 截断严重）⇒ 判定 **回退会话库通道**；
  清单文档要写清**是哪一条不绿、缺成什么样**，因为 T1 的形态要按它改写。

- [ ] **Step 5: 回填 spec §2.3 的 U1**

把 `docs/superpowers/specs/2026-10-16-askdata-evolution-loop-design.md` §2.3 表里 U1 那行的
「未验」改成实测结论（逐字带上证据：字段名 + 是否有思考 + 有无截断 + 判定）。

- [ ] **Step 6: 决定 telemetry 去留**

- 判定 OO 主通道 ⇒ **保留**（它已是生产采集面），并在清单文档记「配置在状态卷，卷重建会回退 ⇒ 需进 seed」。
- 判定回退 ⇒ 按用户意见决定保留（继续观察）或回滚（Step 5 的 `cp` 命令）。

- [ ] **Step 7: 提交 + 开 PR**

```bash
git add docs/superpowers/notes/2026-10-16-t0-span-inventory.md docs/superpowers/specs/2026-10-16-askdata-evolution-loop-design.md
git commit -m "docs(askdata): #741 T0 结论——span 内容清单 + 采集通道判定 + spec §2.3 回填"
git push -u origin docs/741-t0-span-inventory
gh pr create --base main --title "docs(askdata): #741 T0 开箱验证——span 内容清单与通道判定" \
  --body "Refs #741。T0 实测结论见 docs/superpowers/notes/2026-10-16-t0-span-inventory.md"
```

CI CLEAN 后合并。

---

## 本阶段不做（避免越界）

- 不写 T1–T4 的代码（撞墙判据 / 归因 / 统计面）——**它们的形态由 Task 3 的清单决定**，spec §4 已定此序；
- 不动服务端审计表；不改 `SKILL.md`；不建回放集（P2）。

## Self-Review

- **spec 覆盖**：本计划对应 spec §4 的 **T0**（前置）。T1–T4 刻意不在本计划——spec 明写「T0 的产出…必须先有」，
  在清单出来前写它们的代码 = 猜。
- **占位符扫描**：`<ORG>` 是需要执行者填的真实参数（spec §6 R1 决定后取值），已在 Step 1 就地说明取法，不是 TBD。
  Task 2 Step 1 里「凭据跨容器传递」的做法写明了两种可接受路径，不是「以后再说」。
- **类型一致性**：本计划无代码接口；配置键名 `diagnostics.enabled` / `diagnostics.otel.{enabled,protocol,traces,metrics,logs,tracesEndpoint,headers,serviceName,captureContent}`
  均逐字取自 openclaw schema help 与源码，Task 1 Step 2 的基线判据（`diagnostics` 计数为 0）与 Task 2 Step 4 的验证判据（计数 ≥1）成对。
