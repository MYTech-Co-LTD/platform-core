# 统一 skill 管理：平台 MCP 指令面 ↔ openclaw SKILL 设计

> 状态：**设计已确认（2026-11-09，用户逐项选定）**。
> 范围：把「平台 MCP 对外指令面」与「openclaw 插件 `SKILL.md`」收敛到同一份正典，按通道渲染分发。
> 实施计划：待本设计 review 后由 `superpowers:writing-plans` 产出。

## 1. 问题

同一套问数能力，目前有**三处独立手写的指令面**，只有一处有机检：

| 指令面 | 现状位置 | 谁消费 |
|---|---|---|
| MCP 工具描述 | `modules/data/domain/toolbox/registry.ts` 的 `ANALYST_TOOLS` | 三方 agent（通道 B，PAT） |
| MCP 工作流指南 | `modules/data/domain/toolbox/guide.ts` 的 `GUIDE_TEXT_BUILDER` | 三方 agent（`data_agent_guide`） |
| openclaw 工具描述 | `deploy/openclaw/data-query-plugin/index.js` 的 `*_DEF` | openclaw（通道 C，企微 userid） |
| openclaw skill 正文 | `deploy/openclaw/data-query-plugin/skills/data-query/SKILL.md` | openclaw |

现存事实：

- **F1**：`GUIDE_INVARIANTS` 四行硬约束是唯一有机检的同源内容（`scripts/check-guide-sync.mjs`，CI 已接线）。
- **F2**：同一个逻辑工具，平台侧叫 `query_metric`，openclaw 侧叫 `query_data`；两段 `description` 是各自独立的长文本。
- **F3**：openclaw 插件源码**构建期 COPY 进镜像**（`deploy/Dockerfile.openclaw:32`），不走上机 bind mount（`deploy/docker-compose.yml:171-175` 有实测根因）。因此构建期渲染可行。
- **F4**：prose 写进 JS 字符串已有真机事故：2026-11-09 一个未转义的 `["supplier_num"]` 让插件 `SyntaxError`、容器重启循环（`deploy/openclaw/data-query-plugin/contracts.test.js` 头注）。
- **F5**：平台 server 以 `tsx` 直接跑源码（`apps/server/package.json` 的 `start`），运行期读仓内文件有先例（`modules/data/domain/toolbox/health.ts` 读 dbt manifest）；`Dockerfile.server` 整目录 COPY `modules/`，md 文件会进镜像。
- **F6**：仓内文件路径解析**不要用** `new URL(rel, import.meta.url)`——happy-dom 会替换它（`modules/data/domain/pipelines/defs.ts:37` 的教训）；用 `node:path` + `fileURLToPath`。

**结论**：漂移面不是「有没有门禁」，而是**指令正文没有唯一事实源**。继续在两处手工同步，四行之外的内容必然再漂。

## 2. 目标与非目标

### 2.1 目标

1. **一份正典**：工具契约与指令正文各有一个唯一事实源；B/C 两侧只做「取视图 / 渲染」，不再手写第二份。
2. **按通道渲染**：通道差异（工具名、身份语义、传输层行为）显式建模，不靠人记忆。
3. **结构上防漂移**：openclaw 侧在镜像构建期渲染，仓库不提交生成物；平台侧编译期/运行期直接消费正典。
4. **行为不变**：首轮迁移只搬家、不改写；现有 agent 行为与 MCP 工具面保持逐字/语义一致。

### 2.2 非目标

- 不做 skill 管理服务、数据库、按租户动态下发或可视化编辑。
- 不改授权核心、路由、manifest、compose、部署形态。
- 不把整份 skill 塞进 MCP `initialize.instructions`（见 D4）。
- 不统一 wecom-app 这类**纯 openclaw 客户端能力**（平台无对应工具面；可复用同一渲染器，另案）。
- 不做工具名全量重命名（见 D7）。

## 3. 决定

| # | 决定 | 理由 |
|---|---|---|
| D1 | **两个正典 artifact**：`contract.json`（工具契约）+ `content/*.md`（指令正文） | 契约是结构化代码面，正文是 prose；格式各取所长，不混写 |
| D2 | **openclaw 侧构建期渲染，不提交生成物** | 插件本就构建期 COPY；结构上消除漂移，优于「生成 + 门禁」 |
| D3 | **平台 MCP 侧不生成文件**：`registry.ts` 直接读 `contract.json`，`guide.ts` 运行时读 `content/*.md` | 编译期/运行期同源，少一层产物 |
| D4 | **`initialize.instructions` 只放指针 + 四条硬约束** | MCP 规范里 instructions 是简洁提示，客户端可能忽略/截断；完整版走 `data_agent_guide` |
| D5 | **`content/local/` 只参与 openclaw 渲染** | 平台 MCP 是跨租户面，不能把山海/乐檬业务知识烤进通用指令 |
| D6 | **身份语义不进共享正典** | 统一的只是「怎么用能力」，不是「凭什么身份」；授权核心不动 |
| D7 | **工具名收敛延后**；`contract.json` 先显式记录通道名映射 | 改名是行为变更，首轮只搬家；映射集中后，后续可做 alias 收敛 |

## 4. 架构

### 4.1 文件落点

```
modules/data/skill/
  contract.json              # 唯一工具契约（所有静态工具）
  content/
    shared.md                # 通道中性：工作流、硬约束、回答纪律
    mcp.md                   # B 专属：PAT 身份、信封字段、审计口径
    openclaw.md              # C 专属：企微 userid、📅/📐 传输层附加、参数形状
    local/
      tenant-shanhai.md      # 部署/租户知识（乐檬指标 id、行数预算、默认口径）
  render.ts                  # 纯函数渲染器（平台侧 + 测试共用）
scripts/
  gen-openclaw-skill.mjs     # 无依赖 Node 脚本：读 contract.json + content/*.md，渲染 openclaw 产物
deploy/openclaw/data-query-plugin/
  index.js                   # 只留胶水：注册、HTTP 调用、新鲜度捕获
  generated/                 # 构建期生成，gitignore
    tools.js
  skills/data-query/
    SKILL.md                 # 构建期生成，gitignore
```

### 4.2 数据流

```
modules/data/skill/contract.json ─┬─→ registry.ts / guide.ts（平台 MCP，直接读）
                                  └─→ gen-openclaw-skill.mjs ─→ generated/tools.js
modules/data/skill/content/*.md ──┬─→ guide.ts（运行时读，renderSkill('mcp')）
                                  └─→ gen-openclaw-skill.mjs ─→ skills/data-query/SKILL.md
```

镜像构建：

```dockerfile
FROM node:22-alpine AS skillgen
WORKDIR /src
COPY modules/data/skill /src/modules/data/skill
COPY scripts/gen-openclaw-skill.mjs /src/scripts/
RUN node scripts/gen-openclaw-skill.mjs --out /out

FROM ghcr.io/openclaw/openclaw@sha256:<现有 digest 不变>
COPY deploy/openclaw/data-query-plugin /opt/plugins/data-query-plugin
COPY --from=skillgen /out/ /opt/plugins/data-query-plugin/
```

- builder stage 只用 Node 标准库，不装 tsx/依赖。
- 现有 `COPY` 顺序保持不变，生成物最后覆盖进去。
- 官方镜像的 USER / ENTRYPOINT / CMD / 健康检查语义不动。

## 5. 契约

### 5.1 `contract.json`

```json
{
  "version": 1,
  "tools": [
    {
      "id": "query",
      "group": "query",
      "title": "受治理查询",
      "requiredScope": "data:query",
      "mutating": false,
      "annotations": { "readOnlyHint": true },
      "channels": {
        "mcp": {
          "name": "query_metric",
          "description": "…",
          "inputSchema": { "type": "object", "properties": {} },
          "outputSchema": { "type": "object" }
        },
        "openclaw": {
          "name": "query_data",
          "description": "…",
          "inputSchema": { "type": "object", "properties": {} }
        }
      }
    }
  ]
}
```

约束：

- 每个工具至少声明一个通道；通道名在同一通道内唯一。
- `id` 是逻辑标识，仅用于正文占位符与测试；**不暴露给 agent**。
- 通道描述允许不同，但必须相邻在同一条目里——审查时一眼可见差异。
- 只存在于单一通道的工具（`data_agent_guide`、`preview_query`、`explore_*`、`list_metrics`…）只声明该通道。
- 动态工具（`legacyMetricTools` 按指标物化）**不进契约**，保持现状。

### 5.2 `content/*.md`

- 正文用 `{{tool:<id>}}` 引用逻辑工具，渲染器按通道替换为真实名字。
- **正文禁止硬编码通道工具名**；出现即视为违规（渲染器与测试都拦）。
- 共享节用 `GUIDE_INVARIANTS` 的四行硬约束原文；通道专属内容分别放 `mcp.md` / `openclaw.md`。
- `local/` 只在 openclaw 渲染时拼接，位置由 `openclaw.md` 的 `{{include:local/tenant-shanhai.md}}` 指定。

### 5.3 渲染器

构建期不能依赖 tsx（builder stage 只装 Node 标准库），因此渲染逻辑有两份实现，但**规则必须简单到可以逐字对齐**：

- `modules/data/skill/render.ts`：平台侧使用（`renderSkill('mcp')`、`contractView('mcp')`）。
- `scripts/gen-openclaw-skill.mjs`：构建期使用，**零依赖**，只做「读文件 → 替换占位符 → 拼接」。
- 两者不共享代码，但共享**同一组 golden fixture**：测试里用 Node 直接跑 `.mjs`，与 TS 渲染结果逐字节对比；任一规则变化未同步 ⇒ 测试红。
- 不在渲染器里引入模板引擎、条件表达式或运行时求值——规则越简单，两份实现越不可能漂。

渲染规则：

1. 读 `contract.json`，按通道过滤工具。
2. 读 `content/shared.md` + `content/<channel>.md`；openclaw 额外读 `local/`。
3. 替换 `{{tool:<id>}}` 为该通道的工具名；未解析的占位符 ⇒ 渲染失败（exit 1），不静默保留。
4. 输出确定性：同一输入两次结果逐字节相同。

## 6. 平台 MCP 侧

### 6.1 `registry.ts`

- `ANALYST_TOOLS` 改为从 `contract.json` 投影 `mcp` 视图。
- 保持文件**纯**：不 import pg/env/Hono/workspace 包；`check-mcp-toolface.mjs` 与跨租户 e2e 的 import 链不变。
- JSON 读取：优先 `resolveJsonModule` 静态 import（在 `tsconfig.base.json` 加一行）；若 tsx/vitest 任一环境不兼容，退化为 `readFileSync + JSON.parse` 的薄包装——**仍是同一份文件，不产生第二事实源**。

### 6.2 `guide.ts`

- `GUIDE_INVARIANTS` 迁入 `content/shared.md` 的固定节；`guide.ts` 保留 re-export 兼容层，现有 import 路径不破。
- `data_agent_guide` 返回 `renderSkill('mcp')` + 当天日期（`Asia/Shanghai`）。
- 读文件路径用 `node:path` + `fileURLToPath`，不用 `new URL(rel, import.meta.url)`（F6）。
- 文件读取结果进程内缓存；读取失败 ⇒ 工具返回可解释错误（不 500、不编造指南）。

### 6.3 `initialize.instructions`

- 内容：2–3 行指针（先调 `data_agent_guide`）+ 四条硬约束。
- 由 `render.ts` 从 `shared.md` 生成，不另写一份。
- 不改 `mcp-rpc.ts` 的协议壳结构；`McpToolSet` 增加可选 `instructions` 字段，`mcp.ts` 提供。

### 6.4 身份边界

- `contract.json` 与共享正文只写「身份由平台按会话/令牌裁决」。
- `mcp.md`：PAT/个人 Key 的适用范围与「词表按人裁剪」语义。
- `openclaw.md`：企微 `requesterSenderId`、缺身份如实告知、不得绕过的纪律。
- 授权核心（`domain/authz.ts`、`runQuery`、`callTool`）**一行不改**。

## 7. openclaw 侧

### 7.1 `index.js`

- 删除手写 `*_DEF`，改为从 `generated/tools.js` 取定义。
- 保留：`registerTool`、`callPlatform`、`normalizeParams`、`toToolResult`、新鲜度捕获钩子、`lastUserIdBySession`。
- 生成物缺失时，插件装载**明确报错**（提示 `pnpm gen:skill`），不静默降级成「没有工具」。

### 7.2 `openclaw.plugin.json`

- `contracts.tools` 由渲染器同步生成，或由测试断言与 `generated/tools.js` 的 `registerTool` 集合一致。
- 现有「注册了但没声明 ⇒ 网关拒载」的事故（#989）保持有测试覆盖。

### 7.3 本地开发

- `pnpm gen:skill`：写插件目录（`generated/` + `skills/data-query/SKILL.md`）。
- `node --test` 前必须先 `pnpm gen:skill`；`package.json` 的 `pretest` 接线。
- `.gitignore` 增加 `deploy/openclaw/data-query-plugin/generated/` 与 `skills/data-query/SKILL.md`。

## 8. 错误处理

| 场景 | 行为 |
|---|---|
| 渲染时占位符未解析 | 构建失败（exit 1），不产出半成品 |
| `contract.json` schema 非法 / 通道名重复 | 测试失败；构建期渲染失败 |
| 平台运行时读 `content/*.md` 失败 | `data_agent_guide` 返回 `isError:true` + 可解释原因；不影响其他工具 |
| openclaw 生成物缺失 | 插件装载报错并提示生成命令；不静默注册零工具 |
| 某通道没有某工具 | 契约层过滤；正文若引用不存在于该通道的工具 ⇒ 渲染失败 |

## 9. 测试与门禁

| 层 | 断言 |
|---|---|
| 契约单测 | schema 合法；通道名唯一；每个工具至少一个通道；必填字段齐全 |
| 渲染单测 | `{{tool:*}}` 全部可解析；`local/` 不进入 MCP 渲染；确定性（两次逐字节一致） |
| 快照 | `renderSkill('openclaw')` 与 `renderTools('openclaw')` 的快照入库（测试快照，不是发布产物）——内容变化在 PR 里显式可见 |
| 契约回归 | 生成的工具名集合 = `openclaw.plugin.json` 的 `contracts.tools`；`index.js` 不再出现手写 DEF |
| 构建链路 | 断言 `deploy/Dockerfile.openclaw` 含 `gen-openclaw-skill.mjs`（防删 build stage 后退回旧文件） |
| 平台兼容 | `check-mcp-toolface.mjs` 全绿；MCP `tools/list` 的名字/描述/schema 与迁移前一致 |
| 行为 | 首轮迁移用 golden 对比平台 `tools/list` 与 `data_agent_guide` 输出；后续 skill 变更接入 `scripts/askdata/dual-arm-eval.test.ts` |
| CI | 保留现有 gates；删除 `check-guide-sync.mjs` 及其测试（职责被契约 + 快照覆盖） |

## 10. 迁移顺序（每个 PR 行为不变）

1. **引入正典 + 平台消费**：新增 `contract.json`、`content/*.md`、`render.ts`；`registry.ts` / `guide.ts` 改为消费正典。**保留两侧现有描述原文**，只搬家不改写；golden 断言**各通道输出与各自现状逐字一致**（B 对 B、C 对 C）。
2. **openclaw 构建期渲染**：新增 `gen-openclaw-skill.mjs` 与 Dockerfile builder stage；`index.js` 改 import 生成物；更新 `contracts.test.js`；`.gitignore` 忽略生成物。
3. **收口**：加 `initialize.instructions` 指针；删除 `check-guide-sync.mjs`；接 `pnpm gen:skill` 到 `pretest`；补快照与构建链路测试。
4. **可选 P2**：MCP `resources/read` 暴露 `skill://data-query/SKILL.md`；工具名收敛（alias）；SKILL references 渐进披露（需先验证 openclaw 支持）。

## 11. 验收标准

- MCP `tools/list` 的工具名、描述、`inputSchema` 与迁移前**逐字一致**（首轮）。
- `data_agent_guide` 输出包含原七步工作流 + 四条硬约束 + 当天日期（语义一致）。
- `deploy/openclaw/data-query-plugin/index.js` 中不再有手写的工具 `description`。
- openclaw 镜像可构建；容器内 `skills/data-query/SKILL.md` 存在且内容 = 正典渲染结果。
- 本地 `pnpm gen:skill && node --test`（插件目录）全绿。
- `check-mcp-toolface.mjs`、跨租户 e2e、现有 CI gates 全绿。
- 无授权核心、路由、manifest、compose 改动。

## 12. 风险与开放问题

| # | 风险 / 问题 | 处置 |
|---|---|---|
| R1 | JSON 静态 import 在 tsx/vitest 下的兼容性未实测 | 实施第一步先写 10 行 spike；不通则用 `readFileSync + JSON.parse` 薄包装 |
| R2 | 两份渲染实现（TS 与 .mjs）可能漂移 | 用同一组 golden fixture 对比两者输出；渲染规则保持到「读文件 + 替换 + 拼接」级别 |
| R3 | openclaw 是否支持 `references/` 渐进披露未确认 | 不阻塞；SKILL 先保持单文件，验证后再拆 |
| R4 | 生成物不提交，贡献者本地跑测试前忘记 `pnpm gen:skill` | `pretest` 自动生成 + 插件装载明确报错 |
| R5 | 首轮若顺手改写描述，会引入行为变化 | 迁移顺序第 1 步只搬家；golden 逐字断言 |

## 13. 参考

- `docs/architecture.md` §1.5（三通道与 token 身份模型）
- `modules/data/domain/toolbox/guide.ts`（现有三通道同源落点）
- `scripts/check-guide-sync.mjs`（现有门禁）
- `deploy/openclaw/data-query-plugin/README.md`（通道 C 插件契约）
- `deploy/Dockerfile.openclaw`、`deploy/docker-compose.yml`（构建/挂载事实）
- `scripts/askdata/dual-arm-eval.test.ts`（行为评估入口）
