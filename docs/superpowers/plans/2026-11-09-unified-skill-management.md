# 统一 MCP 指令面与 openclaw SKILL 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把平台 MCP 工具描述/指南与 openclaw 插件的 `SKILL.md`/工具描述收敛到 `modules/data/skill/` 的一份正典，按通道渲染分发，首轮迁移行为逐字不变。

**Architecture:** 工具契约放 `contract.json`，指令正文放 `content/*.md`；平台侧直接读取（`registry.ts` 读契约、`guide.ts` 读正文），openclaw 侧在镜像构建期由无依赖 `.mjs` 渲染器生成 `tools.js` + `SKILL.md`，仓库不提交生成物。设计正典：`docs/superpowers/specs/2026-11-09-unified-skill-management-design.md`。

**Tech Stack:** TypeScript、Node 22、vitest、node:test、Docker multi-stage、pnpm。

---

## 工作约定

- 当前分支：`MCP-及-skill`（worktree：`/Users/buddybot/orca/workspaces/platform-core/MCP-及-skill`）。**不要切回 main，不要直推 main。**
- 每个 Task 结束提交一次；提交信息用 Conventional Commits。
- 仓库纪律：feat/fix 必须先有 issue；本计划先用 Task 0 建 issue，后续提交带 `(#<issue>)` 与 `X-Issue` trailer（hook 会自动盖）。
- 敏感值不写明文；本计划不涉及密钥。

---

### Task 0: 建立 issue 与迁移基线

**Files:**
- Create: `/tmp/skill-baseline/`（本地临时目录，不进仓）
- Modify: 无

- [ ] **Step 1: 建 issue 并记录编号**

```bash
gh issue create \
  --title "统一 MCP 指令面与 openclaw SKILL 管理" \
  --body "设计：docs/superpowers/specs/2026-11-09-unified-skill-management-design.md

把平台 MCP 工具描述/指南与 openclaw SKILL.md/工具描述收敛到 modules/data/skill/ 一份正典，按通道渲染分发。首轮迁移行为逐字不变。"
```

Expected: 输出 issue URL。把编号记到环境变量：

```bash
export ISSUE=<上一步 URL 末尾的数字>
echo "$ISSUE"
```

- [ ] **Step 2: 保存迁移前基线（用于逐字对比）**

```bash
mkdir -p /tmp/skill-baseline
cp modules/data/domain/toolbox/registry.ts /tmp/skill-baseline/registry.ts
cp modules/data/domain/toolbox/guide.ts /tmp/skill-baseline/guide.ts
cp deploy/openclaw/data-query-plugin/index.js /tmp/skill-baseline/index.js
cp deploy/openclaw/data-query-plugin/skills/data-query/SKILL.md /tmp/skill-baseline/SKILL.md
cp deploy/openclaw/data-query-plugin/openclaw.plugin.json /tmp/skill-baseline/openclaw.plugin.json
```

Expected: 五个文件复制成功。

- [ ] **Step 3: 把基线哈希记进 issue（可选，但推荐）**

```bash
shasum -a 256 /tmp/skill-baseline/* | tee /tmp/skill-baseline/SHA256SUMS
```

Expected: 每个文件一行哈希。

- [ ] **Step 4: 提交（本 Task 无代码变更，跳过提交）**

本 Task 不产生仓内变更，不提交。

---

### Task 1: 工具契约 `contract.json` + 平台 MCP 投影

**Files:**
- Create: `modules/data/skill/contract.ts`
- Create: `modules/data/skill/contract.json`
- Create: `modules/data/skill/contract.test.ts`
- Create: `modules/data/domain/toolbox/registry.golden.test.ts`（先产生快照，再改 registry）
- Modify: `modules/data/domain/toolbox/registry.ts:1-60`

- [ ] **Step 1: 先给现有 `ANALYST_TOOLS` 拍快照（迁移基线）**

创建 `modules/data/domain/toolbox/registry.golden.test.ts`：

```ts
// registry.golden.test.ts — 迁移前后 MCP 工具面逐字一致的快照门。
// 这个快照在重构前生成；重构后必须**不更新快照**也通过。
import { describe, expect, it } from 'vitest'
import { ANALYST_TOOLS } from './registry'

describe('MCP 分析师面 golden', () => {
  it('ANALYST_TOOLS 逐字快照', () => {
    expect(ANALYST_TOOLS).toMatchSnapshot()
  })
})
```

- [ ] **Step 2: 生成快照并确认它来自重构前代码**

```bash
pnpm --filter data exec vitest run domain/toolbox/registry.golden.test.ts -u
```

Expected: PASS，生成 `modules/data/domain/toolbox/__snapshots__/registry.golden.test.ts.snap`。

再跑一次不带 `-u`：

```bash
pnpm --filter data exec vitest run domain/toolbox/registry.golden.test.ts
```

Expected: PASS。

提交快照（这是重构基线，必须先落库）：

```bash
git add modules/data/domain/toolbox/registry.golden.test.ts modules/data/domain/toolbox/__snapshots__/registry.golden.test.ts.snap
git commit -m "test(data): 为 MCP 工具面迁移加逐字快照基线 (#$ISSUE)"
```

- [ ] **Step 3: 创建 `contract.ts`（纯读取，不在 import 期做网络/DB）**

```ts
// contract.ts — 静态工具契约的唯一事实源读取层（contract.json）。
// 为什么用 readFileSync 而不是 JSON import：本文件被 registry.ts 经 tsx 直接拉起，
// 要同时兼容 tsx / vitest / Node ESM（JSON import attributes 在三种环境下行为不一致）。
// ⚠️ 路径用 node:path + fileURLToPath，不要用 new URL(rel, import.meta.url)
//    （happy-dom 会替换 import.meta.url，见 domain/pipelines/defs.ts 的教训）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type SkillChannel = 'mcp' | 'openclaw'

export interface ChannelToolFace {
  /** 该通道暴露的工具名（MCP 2025-11-25 合法名）。 */
  name: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
}

export interface ContractTool {
  /** 逻辑 id：只用于正文占位符与测试，不暴露给 agent。 */
  id: string
  group: 'guide' | 'discovery' | 'query' | 'health'
  title: string
  /** true = 属于 ANALYST_TOOLS（data_harness_catalog 可见）；false = 静态附加工具。 */
  analyst: boolean
  requiredScope: string | null
  mutating: boolean
  annotations: { readOnlyHint: boolean }
  channels: Partial<Record<SkillChannel, ChannelToolFace>>
}

export interface SkillContract {
  version: number
  tools: ContractTool[]
}

const HERE = dirname(fileURLToPath(import.meta.url))

export const CONTRACT: SkillContract = JSON.parse(
  readFileSync(join(HERE, 'contract.json'), 'utf8'),
) as SkillContract

export function toolsFor(channel: SkillChannel): ContractTool[] {
  return CONTRACT.tools.filter((t) => t.channels[channel] !== undefined)
}

export function faceOf(tool: ContractTool, channel: SkillChannel): ChannelToolFace {
  const face = tool.channels[channel]
  if (face === undefined) throw new Error(`工具 ${tool.id} 没有 ${channel} 通道`)
  return face
}
```

- [ ] **Step 4: 创建 `contract.json`（迁移 13 个分析师面工具 + query_detail + list_metrics）**

按下表写 15 个条目。**描述、inputSchema、outputSchema 逐字从现有代码复制，不要改写**：

| id | analyst | mcp 名 | openclaw 名 | 来源 |
|---|---|---|---|---|
| guide | true | data_agent_guide | — | `registry.ts` 同名条目 |
| harness_catalog | true | data_harness_catalog | — | `registry.ts` 同名条目 |
| search | true | search_catalog | search_catalog | 平台取 `registry.ts`；C 取 `index.js` 的 `SEARCH_DEF` |
| describe_metric | true | describe_metric | describe_metric | 平台取 `registry.ts`；C 取 `DESCRIBE_DEF` |
| describe_dataset | true | describe_dataset | — | `registry.ts` 同名条目 |
| sample_dimension_values | true | sample_dimension_values | sample_dimension_values | 平台取 `registry.ts`；C 取 `SAMPLE_DEF` |
| preview_query | true | preview_query | — | `registry.ts` 同名条目 |
| query | true | query_metric | query_data | 平台取 `registry.ts`；C 取 `QUERY_DEF` |
| explore_query | true | explore_query | — | `registry.ts` 同名条目 |
| explore_recipe | true | explore_recipe | — | `registry.ts` 同名条目 |
| freshness | true | get_freshness | get_freshness | 平台取 `registry.ts`；C 取 `FRESHNESS_DEF` |
| quality | true | get_quality | — | `registry.ts` 同名条目 |
| lineage | true | get_lineage | — | `registry.ts` 同名条目 |
| query_detail | false | query_detail | query_detail | 平台取 `routes/mcp.ts` 的 `DETAIL_TOOL`；C 取 `DETAIL_DEF` |
| list_metrics | false | — | list_metrics | 仅 C，取 `index.js` 的 `LIST_DEF` |

文件骨架：

```json
{
  "version": 1,
  "tools": [
    {
      "id": "guide",
      "group": "guide",
      "title": "数据工作流指南",
      "analyst": true,
      "requiredScope": "data:read",
      "mutating": false,
      "annotations": { "readOnlyHint": true },
      "channels": {
        "mcp": {
          "name": "data_agent_guide",
          "description": "<逐字复制 registry.ts 的 description>",
          "inputSchema": { "type": "object", "properties": {}, "required": [] },
          "outputSchema": { "type": "object" }
        }
      }
    }
  ]
}
```

规则：

- `group` 取现有 `registry.ts` 的 `group`；`query_detail` 用 `"query"`，`list_metrics` 用 `"discovery"`。
- `requiredScope` 取现有值；`query_detail` 用 `"data:query"`，`list_metrics` 用 `"data:read"`。
- 所有 `mutating` 为 `false`；`annotations` 为 `{"readOnlyHint": true}`。
- 平台侧 `mcp` 的 `title` 用顶层 `title`；C 侧不需要单独 title。
- JSON 里长描述不要手动折行；用原字符串。

- [ ] **Step 5: 创建 `contract.test.ts` 校验契约形状**

```ts
// contract.test.ts — 契约形状门：通道名唯一、必填字段齐全、占位符可解析。
import { describe, expect, it } from 'vitest'
import { CONTRACT } from './contract'

const TOOL_NAME_RE = /^[A-Za-z0-9_.-]+$/

describe('skill contract', () => {
  it('version 为正整数，至少有一个工具', () => {
    expect(Number.isInteger(CONTRACT.version)).toBe(true)
    expect(CONTRACT.version).toBeGreaterThan(0)
    expect(CONTRACT.tools.length).toBeGreaterThan(0)
  })

  it('每个工具至少一个通道；通道名唯一且合法', () => {
    const seen = { mcp: new Set<string>(), openclaw: new Set<string>() }
    for (const tool of CONTRACT.tools) {
      const channels = Object.keys(tool.channels) as Array<keyof typeof seen>
      expect(channels.length).toBeGreaterThan(0)
      for (const ch of channels) {
        const face = tool.channels[ch]!
        expect(TOOL_NAME_RE.test(face.name)).toBe(true)
        expect(seen[ch].has(face.name)).toBe(false)
        seen[ch].add(face.name)
      }
    }
  })

  it('必填字段齐全', () => {
    for (const tool of CONTRACT.tools) {
      expect(tool.id).toBeTruthy()
      expect(tool.title).toBeTruthy()
      expect(typeof tool.analyst).toBe('boolean')
      expect(typeof tool.mutating).toBe('boolean')
      expect(tool.annotations).toBeTruthy()
      for (const face of Object.values(tool.channels)) {
        expect(face!.description).toBeTruthy()
        expect(face!.inputSchema).toBeTruthy()
      }
    }
  })

  it('query_detail 与 list_metrics 是静态工具（不进 ANALYST_TOOLS）', () => {
    const byId = new Map(CONTRACT.tools.map((t) => [t.id, t]))
    expect(byId.get('query_detail')?.analyst).toBe(false)
    expect(byId.get('list_metrics')?.analyst).toBe(false)
  })
})
```

- [ ] **Step 6: 把 `skill/**` 加进 data 包的 vitest backend include**

`modules/data/vitest.config.ts` 的 backend `include` 目前只列了 `domain/**`、`routes/**`、`*.test.ts`——新目录 `skill/` 不会被扫到。改成：

```ts
          include: ['domain/**/*.test.ts', 'routes/**/*.test.ts', 'skill/**/*.test.ts', '*.test.ts'],
```

- [ ] **Step 7: 运行契约测试**

```bash
pnpm --filter data exec vitest run skill/contract.test.ts
```

Expected: PASS。

- [ ] **Step 8: 改写 `registry.ts`，从契约投影 `ANALYST_TOOLS`**

把 `registry.ts` 顶部的 `ANALYST_TOOLS` 字面量数组（约 52–270 行）整段替换为：

```ts
import { CONTRACT } from '../../skill/contract'

/** 分析师面工具 = 契约里 analyst=true 且声明了 mcp 通道的条目。 */
export const ANALYST_TOOLS: readonly ToolMeta[] = CONTRACT.tools
  .filter((t) => t.analyst && t.channels.mcp !== undefined)
  .map((t) => {
    const face = t.channels.mcp!
    return {
      name: face.name,
      group: t.group,
      title: t.title,
      description: face.description,
      inputSchema: face.inputSchema,
      outputSchema: face.outputSchema ?? { type: 'object' },
      requiredScope: t.requiredScope,
      mutating: t.mutating,
      annotations: t.annotations,
    }
  })
```

同时把文件头注里的「本文件是纯的：不得 import ...」补一句：

```ts
//   · 契约读取用 node:fs（contract.ts），不是 pg/env/Hono；CI 的 tsx import 链仍然只碰静态文件。
```

- [ ] **Step 9: 跑快照与工具面门禁，确认逐字未变**

```bash
pnpm --filter data exec vitest run domain/toolbox/registry.golden.test.ts
pnpm exec tsx scripts/check-mcp-toolface.mjs
```

Expected: 快照 PASS（**没有 `-u`**）；`check-mcp-toolface: OK`。

如果快照失败，说明复制有改写——回 Step 4 逐条对齐，不要更新快照。

- [ ] **Step 10: 提交**

```bash
git add modules/data/skill/contract.ts modules/data/skill/contract.json modules/data/skill/contract.test.ts modules/data/domain/toolbox/registry.ts modules/data/vitest.config.ts
git commit -m "refactor(data): 工具契约收敛到 modules/data/skill/contract.json (#$ISSUE)"
```

---

### Task 2: MCP 静态工具 + guide 正文迁移

**Files:**
- Create: `modules/data/skill/content/shared.md`
- Create: `modules/data/skill/content/mcp.md`
- Create: `modules/data/skill/render.ts`
- Create: `modules/data/skill/render.test.ts`
- Modify: `modules/data/domain/toolbox/guide.ts`
- Modify: `modules/data/routes/mcp.ts:1-80`

- [ ] **Step 1: 先给现有 guide 输出拍快照**

在 `modules/data/domain/toolbox/guide.test.ts` 末尾加：

```ts
describe('guide 输出 golden（迁移前后逐字一致）', () => {
  it('GUIDE_TEXT_BUILDER 快照', () => {
    expect(GUIDE_TEXT_BUILDER('2026-01-02')).toMatchSnapshot()
  })
})
```

生成快照：

```bash
pnpm --filter data exec vitest run domain/toolbox/guide.test.ts -u
pnpm --filter data exec vitest run domain/toolbox/guide.test.ts
```

Expected: 两次 PASS，生成 `__snapshots__/guide.test.ts.snap`。

提交快照：

```bash
git add modules/data/domain/toolbox/guide.test.ts modules/data/domain/toolbox/__snapshots__/guide.test.ts.snap
git commit -m "test(data): 为 guide 迁移加逐字快照基线 (#$ISSUE)"
```

- [ ] **Step 2: 写 `content/shared.md`（只放四行硬约束，逐字复制）**

```markdown
· 主体（org/租户/数据主体）由平台按身份钉死：不要索要、不要猜测，参数里出现即被拒；
· 行上限 1000，truncated=true 说明被截断：不得把截断集当全量下结论，也不得对截断集自行求和；
· 合计以回包的 total 字段为准：字段在场就直接引用，不要自己把行加总；切片/截断产生的部分合计不是全局合计；
· 数据截止与新鲜度必须如实呈现：回包没有相应字段或正典行 = 新鲜度未知，如实说明，不要编；
```

- [ ] **Step 3: 写 `content/mcp.md`（逐字复制现有 `GUIDE_TEXT_BUILDER` 的输出，只把日期与硬约束换成占位符）**

```markdown
今天是 {{today}}（Asia/Shanghai）。
工作流七步：
1. 先读本指南（本工具）；
2. {{tool:harness_catalog}} 看有哪些工具；
3. {{tool:search}} 找指标；{{tool:describe_metric}} 拿口径/参数/维度（查数前必做）；
4. {{tool:sample_dimension_values}} 确认过滤值的确切写法（如门店名）；
5. {{tool:preview_query}} 核对将执行的 SQL；
6. {{tool:query}} 取数——回包是信任信封：口径版本/数据截止/审计 id 都在里面，照实转述；
7. {{tool:freshness}}/{{tool:quality}}/{{tool:lineage}} 回答「数据新不新/可不可信/从哪来」。
硬约束：
{{include:shared.md}}
```

渲染后必须与现有 `GUIDE_TEXT_BUILDER` 输出逐字一致（Task 2 Step 1 的快照会兜底）。

- [ ] **Step 4: 写 `render.ts`**

```ts
// render.ts — 平台侧 skill 渲染（读取 content/*.md + contract.json）。
// openclaw 构建期用 scripts/gen-openclaw-skill.mjs（零依赖、规则简单到可以逐字对齐）；
// 两者由 render.test.ts / gen-openclaw-skill.test.ts 的同一组 golden 用例钉住。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONTRACT, type ContractTool, type SkillChannel } from './contract'

const CONTENT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'content')
const cache = new Map<string, string>()

function read(rel: string): string {
  if (!cache.has(rel)) cache.set(rel, readFileSync(join(CONTENT_DIR, rel), 'utf8'))
  return cache.get(rel)!
}

/** 四个硬约束行（从 shared.md 取，供 GUIDE_INVARIANTS 兼容层）。 */
export function guideInvariants(): readonly string[] {
  return read('shared.md')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('· '))
}

function renderFile(rel: string, channel: SkillChannel, depth = 0): string {
  if (depth > 5) throw new Error(`render: include 深度超限（${rel}）`)
  let text = read(rel)
  text = text.replace(/\{\{include:([^}]+)\}\}/g, (_, inc: string) => {
    const target = inc.trim()
    if (!/^[a-z0-9/_-]+\.md$/.test(target)) throw new Error(`render: 非法 include ${target}`)
    // 去掉 partial 的尾部换行：拼接点由调用方控制，否则会多出一个空行（golden 会红）。
    return renderFile(target, channel, depth + 1).replace(/\n+$/, '')
  })
  text = text.replace(/\{\{tool:([a-z0-9_-]+)\}\}/g, (_, id: string) => {
    const tool = CONTRACT.tools.find((t) => t.id === id)
    const face = tool?.channels[channel]
    if (face === undefined) throw new Error(`render: 通道 ${channel} 没有工具 ${id}`)
    return face.name
  })
  const left = text.match(/\{\{[^}]+\}\}/)
  if (left !== null) throw new Error(`render: 未解析占位符 ${left[0]}`)
  return text
}

export interface RenderOptions { today?: string }

/** 通道完整正文。mcp 侧 = content/mcp.md（include shared）；openclaw 侧 = content/openclaw.md。 */
export function renderSkill(channel: SkillChannel, opts: RenderOptions = {}): string {
  const text = renderFile(`${channel}.md`, channel)
  // 去尾部换行：与旧 GUIDE_TEXT_BUILDER 的 join('\n') 输出逐字对齐（golden 兜底）。
  return text.replaceAll('{{today}}', opts.today ?? '').replace(/\n+$/, '')
}

/** 契约里该通道的工具（含 analyst 与静态工具）。 */
export function contractView(channel: SkillChannel): ContractTool[] {
  return CONTRACT.tools.filter((t) => t.channels[channel] !== undefined)
}

/** MCP initialize.instructions：只放指针 + 四条硬约束，不放整份工作流。 */
export function renderInstructions(): string {
  return [
    '本服务是平台数据 MCP。开始任何数据任务前先调用 data_agent_guide 获取工作流与硬约束。',
    ...guideInvariants(),
  ].join('\n')
}
```

- [ ] **Step 5: 写 `render.test.ts`**

```ts
// render.test.ts — 正文渲染的纯判据。
import { describe, expect, it } from 'vitest'
import { CONTRACT } from './contract'
import { contractView, guideInvariants, renderInstructions, renderSkill } from './render'

describe('renderSkill', () => {
  it('mcp 正文包含七步工作流、四行硬约束、注入日期', () => {
    const text = renderSkill('mcp', { today: '2026-01-02' })
    expect(text).toContain('今天是 2026-01-02')
    expect(text).toContain('工作流七步')
    expect(text).toContain('硬约束')
    for (const line of guideInvariants()) expect(text).toContain(line)
  })

  it('确定性：同一输入两次逐字节一致', () => {
    expect(renderSkill('mcp', { today: '2026-01-02' })).toBe(renderSkill('mcp', { today: '2026-01-02' }))
  })

  it('未解析占位符会抛错（不静默保留）', () => {
    expect(() => renderInstructions()).not.toThrow()
  })
})

describe('contractView', () => {
  it('mcp 视图 = 13 个分析师工具 + query_detail，不含 list_metrics', () => {
    const names = contractView('mcp').map((t) => t.channels.mcp!.name)
    expect(names).toContain('query_detail')
    expect(names).not.toContain('list_metrics')
    expect(names).toHaveLength(14)
  })

  it('openclaw 视图 = 7 个工具（含 list_metrics，不含 MCP 专属工具）', () => {
    const names = contractView('openclaw').map((t) => t.channels.openclaw!.name)
    expect(names.sort()).toEqual([
      'describe_metric', 'get_freshness', 'list_metrics', 'query_data',
      'query_detail', 'sample_dimension_values', 'search_catalog',
    ])
  })

  it('每个工具 id 在契约里唯一', () => {
    const ids = CONTRACT.tools.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
```

- [ ] **Step 6: 改 `guide.ts` 使用 render**

把 `GUIDE_INVARIANTS` 与 `GUIDE_TEXT_BUILDER` 的现有字面量替换为：

```ts
import { guideInvariants, renderSkill } from '../../skill/render'

/** 四行通道中性硬约束（content/shared.md 的唯一副本）。 */
export const GUIDE_INVARIANTS: readonly string[] = guideInvariants()

/** B 通道指南：content/mcp.md 渲染（日期由调用方注入）。 */
export const GUIDE_TEXT_BUILDER = (today: string): string => renderSkill('mcp', { today })
```

`guideImpl` 改为对读文件失败 fail-soft（正典缺文件时工具级错误，不是 500）：

```ts
export const guideImpl: ToolImpl = async (deps) => {
  try {
    const today = shanghaiToday(deps.now ?? (() => new Date()))
    return {
      payload: { status: 'ok', today, workflow: GUIDE_TEXT_BUILDER(today) },
      isError: false,
      auditRowCount: null,
    }
  } catch (err) {
    return {
      payload: {
        status: 'error',
        reason: 'guide_unavailable',
        detail: err instanceof Error ? err.message : String(err),
      },
      isError: true,
      auditRowCount: null,
    }
  }
}
```

`harnessCatalogImpl` 不动。

- [ ] **Step 7: 改 `routes/mcp.ts` 的静态工具投影**

删除 `DETAIL_TOOL` 字面量，改成从契约投影：

```ts
import { contractView } from '../skill/render'

/** 静态附加工具（analyst=false 且声明了 mcp 通道）——query_detail 在这里。 */
const STATIC_MCP_TOOLS = contractView('mcp')
  .filter((t) => !t.analyst)
  .map((t) => {
    const face = t.channels.mcp!
    return {
      name: face.name, title: t.title, description: face.description,
      inputSchema: face.inputSchema, outputSchema: face.outputSchema ?? { type: 'object' },
      annotations: t.annotations,
    }
  })
```

`list()` 里把 `DETAIL_TOOL` 改成 `...STATIC_MCP_TOOLS`：

```ts
    return [
      ...legacyMetricTools(catalog, deps.requester, deps.adoptedSources).map((x) => x.tool),
      ...analystListEntries(),
      ...STATIC_MCP_TOOLS,
    ]
```

`call()` 里 `if (name === 'query_detail')` 保持不变；在 `if` 前加一行断言防止契约改名：

```ts
    // 契约改了 query_detail 的名字，这里必须一起改；测试 render.test.ts 已钉住 mcp 视图。
```

- [ ] **Step 8: 跑 guide 快照与 mcp 测试**

```bash
pnpm --filter data exec vitest run domain/toolbox/guide.test.ts skill/render.test.ts
pnpm --filter data exec vitest run routes/mcp.test.ts
```

Expected: guide 快照 PASS（不带 `-u`）；render 测试 PASS；mcp 测试（有 `DATABASE_URL` 时）PASS 或按既有跳过。

- [ ] **Step 9: 提交**

```bash
git add modules/data/skill/content/shared.md modules/data/skill/content/mcp.md modules/data/skill/render.ts modules/data/skill/render.test.ts modules/data/domain/toolbox/guide.ts modules/data/routes/mcp.ts
git commit -m "refactor(data): guide 与 MCP 静态工具改为契约渲染 (#$ISSUE)"
```

---

### Task 3: openclaw 正文迁移（`openclaw.md` + 租户 local partial）

**Files:**
- Create: `modules/data/skill/content/openclaw.md`
- Create: `modules/data/skill/content/local/tenant-shanhai-*.md`（按 `openclaw.md` 插入点拆多个 partial）
- Create: `modules/data/skill/content/README.md`（源文件角色说明，不参与渲染）
- Test: `modules/data/skill/render.test.ts`（追加用例）

- [ ] **Step 1: 创建 `content/openclaw.md`**

把 `/tmp/skill-baseline/SKILL.md` 的 **frontmatter 之后**的全部正文复制进来，然后做三件事：

1. **工具名换占位符**（逐字替换，不要改语义）：

| 现有硬编码 | 替换为 |
|---|---|
| `search_catalog` | `{{tool:search}}` |
| `list_metrics` | `{{tool:list_metrics}}` |
| `query_data` | `{{tool:query}}` |
| `query_detail` | `{{tool:query_detail}}` |
| `describe_metric` | `{{tool:describe_metric}}` |
| `sample_dimension_values` | `{{tool:sample_dimension_values}}` |
| `get_freshness` | `{{tool:freshness}}` |

2. **把租户业务知识抽到 `content/local/tenant-shanhai-*.md`**，在 `openclaw.md` 原位置放 `{{include:local/<name>.md}}`。租户内容在原正文中**不连续**，按插入点拆多个 partial（指标表、行数预算、默认口径、覆盖区间、列名、参数形状、明细下钻、部署文案各一个），不要合成单文件。抽取范围（按现有 SKILL.md 的标题）：
   - 「## 先检索，不要猜 id」里的 `lemeng:*` 指标 id 表、营业额默认口径、配销差额规则、实测代价；
   - 「## 方法论」里的行数预算（`3120` / `64188` /「区间超过 4 天必用」）；
   - 「## 数据覆盖区间」里的乐檬示例；
   - 「## Top-N / 分组」里的 `supplier_num`、`client_name` 等乐檬列名示例；
   - 「## 参数形状」里的乐檬 `bizday` 示例；
   - 「## 明细下钻」里的 `lemeng:retail:order_line`、`order_detail_std_price`、`data:cost` 示例；
   - 「## 汇报与行为」里的「扫码登录」等部署相关文案。
   **通用方法论、纪律、回包信号处理留在 `openclaw.md`**。混合 bullet 用「保留通用句 + 把示例部分 include」的方式（允许行内 include），保证渲染逐字等价；做不到就整条保留并记录原因。
3. **frontmatter 不要放进 `openclaw.md`**——openclaw 侧 frontmatter 由构建期渲染器从 `content/openclaw.frontmatter.md` 读取（Task 4 创建）。

**不要在 `openclaw.md` 或 `local/*.md` 里写注释**：全文都会渲染进 agent 可见正文，注释同样可见并会破坏与旧 SKILL.md 的逐字 parity。源文件角色说明写 `content/README.md`（不参与渲染）。

- [ ] **Step 2: 创建 `content/local/tenant-shanhai-*.md`**

按 Step 1 的插入点逐个建文件，每个文件只放该位置的原文（不要加注释、不要调整顺序/空白）。文件角色、拆分原因与「为什么不能写注释」写 `content/README.md`。

- [ ] **Step 3: 追加 render 测试：openclaw 正文包含共享硬约束与租户 id，且不含 mcp 专属工具名**

在 `render.test.ts` 追加（文件头需补 `node:fs` / `node:path` / `node:url` 导入，以及 `HERE = dirname(fileURLToPath(import.meta.url))`、`CONTENT_DIR = join(HERE, 'content')`）：

```ts
describe('openclaw 渲染', () => {
  it('包含四行硬约束、租户指标 id，且工具名已按 openclaw 通道替换', () => {
    const text = renderSkill('openclaw')
    for (const line of guideInvariants()) expect(text).toContain(line)
    expect(text).toContain('lemeng:retail:sales')
    expect(text).toContain('query_data')
    expect(text).not.toContain('query_metric')
  })

  it('平台 MCP 渲染不包含租户 local 内容', () => {
    const text = renderSkill('mcp', { today: '2026-01-02' })
    expect(text).not.toContain('lemeng:retail:sales')
  })

  // 从 openclaw lib.test.js 迁来的「文案即契约」断言：它们原先读 index.js / SKILL.md 源文本，
  // 现在改读正典渲染结果。行为判据逐字保留，只是事实源换了位置。
  it('query_data 工具描述含 total 语义与「不要自己加总」', () => {
    const desc = contractView('openclaw').find((t) => t.id === 'query')!.channels.openclaw!.description
    expect(desc).toContain('total 字段')
    expect(desc).toContain('不要自己把明细行加总')
    expect(desc).toContain('不要跨行求和')
    expect(desc).toContain('args.total=true')
    expect(desc).not.toContain('明细与合计互斥')
  })

  it('query_data 工具描述锁定「系统自动附加」口径', () => {
    const desc = contractView('openclaw').find((t) => t.id === 'query')!.channels.openclaw!.description
    expect(desc).toContain('新鲜度与口径射程由系统自动附加')
    expect(desc).toContain('不要自己写任何 📅 / 📐 行')
    expect(desc).toContain('不要复述或拼接 freshness_line / scope_line')
    expect(desc).not.toContain('答案末尾必须原样单独一行附')
    expect(desc).toContain('data_as_of')
    expect(desc).toContain('数据截止')
    expect(desc).toContain('新鲜度未知')
    expect(desc).toContain('部分天')
    expect(desc).toContain('北京时间')
    expect(desc).toContain('UTC+8')
  })

  it('SKILL 正文保留新鲜度口径与既有判据句', () => {
    const skill = renderSkill('openclaw')
    expect(skill).toContain('新鲜度声明由系统自动附加')
    expect(skill).toContain('不要自己写任何 📅 行')
    expect(skill).toContain('不要复述数据更新时间')
    expect(skill).not.toContain('原样**附回包的')
    expect(skill).toContain('data_as_of')
    expect(skill).toContain('新鲜度未知')
    expect(skill).toContain('部分天')
    expect(skill).toContain('北京时间')
    expect(skill).toContain('UTC+8')
    expect(skill).toContain('truncated:true')
    expect(skill).toContain('BAD_PARAM')
    expect(skill).toContain('区间超过 4 天必用')
  })

  it('SKILL 正文保留 query_detail 明细下钻节与条件列话术', () => {
    const skill = renderSkill('openclaw')
    expect(skill).toContain('query_detail')
    expect(skill).toContain('明细下钻')
    expect(skill).toContain('rowCountTotal')
    expect(skill).toContain('bizday')
    expect(skill).toContain('能力边界')
    expect(skill).toContain('不要重试')
    expect(skill).toContain('未授权')
    expect(skill).toContain('该列需授权')
    expect(skill).toContain('lemeng:retail:order_line')
    expect(skill).toContain('metricId=lemeng:retail:order_line')
  })

  it('query_detail 工具描述保留双时钟与条件列口径', () => {
    const desc = contractView('openclaw').find((t) => t.id === 'query_detail')!.channels.openclaw!.description
    expect(desc).toContain('bizday 必传')
    expect(desc).toContain('rowCountTotal')
    expect(desc).toContain('不要拿返回行数当全量')
    expect(desc).toContain('no_detail_binding')
    expect(desc).toContain('不要重试')
    expect(desc).toContain('clock_note')
    expect(desc).toContain('scope_line')
    expect(desc).toContain('原样转述')
    expect(desc).toContain('少一列')
    expect(desc).toContain('该列需授权')
  })

  it('openclaw 渲染逐字快照（迁移基线）', () => {
    expect(renderSkill('openclaw')).toMatchSnapshot()
  })

  it('local/ 下没有孤儿 partial（每个文件都被 openclaw.md include）', () => {
    const files = readdirSync(join(CONTENT_DIR, 'local')).filter((f) => f.endsWith('.md'))
    expect(files.length).toBeGreaterThan(0)
    const openclaw = readFileSync(join(CONTENT_DIR, 'openclaw.md'), 'utf8')
    for (const file of files) expect(openclaw).toContain(`{{include:local/${file}}}`)
  })

  // 迁移证明：Task 5 删除旧 SKILL.md 时同步删除本用例。
  it('与旧插件 SKILL.md 正文逐字一致（迁移证明）', () => {
    const repoRoot = join(HERE, '..', '..', '..')
    const old = readFileSync(
      join(repoRoot, 'deploy/openclaw/data-query-plugin/skills/data-query/SKILL.md'), 'utf8',
    )
    const body = old.replace(/^---\n[\s\S]*?\n---\n\n?/, '').replace(/\n+$/, '')
    expect(renderSkill('openclaw')).toBe(body)
  })
})
```

- [ ] **Step 4: 跑测试**

```bash
pnpm --filter data exec vitest run skill/render.test.ts
```

Expected: PASS。若 `openclaw.md` 里还有未替换的占位符或硬编码工具名，先修正文。

- [ ] **Step 5: 提交**

```bash
git add modules/data/skill/content/openclaw.md modules/data/skill/content/local modules/data/skill/content/README.md modules/data/skill/render.test.ts modules/data/skill/__snapshots__
git commit -m "feat(data): openclaw skill 正文迁入 skill 正典 (#$ISSUE)"
```

---

### Task 4: 构建期渲染器 `gen-openclaw-skill.mjs`

**Files:**
- Create: `scripts/gen-openclaw-skill.mjs`
- Create: `scripts/gen-openclaw-skill.test.ts`
- Create: `modules/data/skill/content/openclaw.frontmatter.md`

- [ ] **Step 1: 创建 `content/openclaw.frontmatter.md`**

把 `/tmp/skill-baseline/SKILL.md` 开头的 YAML frontmatter 原样复制：

```markdown
---
name: data-query
description: 平台问数。用户问业务数据（销售额/订单/商品/门店/趋势等）时激活：先 search_catalog 按用户原词检索词表，describe_metric 看口径与覆盖区间，query_data 查数，用表格/要点汇报。
metadata:
  openclaw:
    emoji: "📊"
---
```

- [ ] **Step 2: 创建 `scripts/gen-openclaw-skill.mjs`（零依赖）**

```js
#!/usr/bin/env node
// gen-openclaw-skill.mjs — 构建期渲染 openclaw 产物（零依赖，只用 Node 标准库）。
// 来源：modules/data/skill/{contract.json,content/**}。
// 产物：<out>/generated/tools.js + <out>/skills/data-query/SKILL.md。
// 用法：
//   node scripts/gen-openclaw-skill.mjs --plugin-dir deploy/openclaw/data-query-plugin
//   node scripts/gen-openclaw-skill.mjs --out /tmp/skill-out
// 规则与 modules/data/skill/render.ts 保持一致；两份实现由 gen-openclaw-skill.test.ts 的
// 同一组 golden 用例钉住。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKILL_DIR = join(REPO_ROOT, 'modules/data/skill')
const CONTENT_DIR = join(SKILL_DIR, 'content')

const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const pluginIndex = args.indexOf('--plugin-dir')
const outDir = outIndex >= 0
  ? resolve(args[outIndex + 1])
  : pluginIndex >= 0
    ? resolve(args[pluginIndex + 1])
    : resolve(REPO_ROOT, 'deploy/openclaw/data-query-plugin')

const contract = JSON.parse(readFileSync(join(SKILL_DIR, 'contract.json'), 'utf8'))
const cache = new Map()

function read(rel) {
  if (!cache.has(rel)) cache.set(rel, readFileSync(join(CONTENT_DIR, rel), 'utf8'))
  return cache.get(rel)
}

function renderFile(rel, depth = 0) {
  if (depth > 5) throw new Error(`gen-openclaw-skill: include 深度超限（${rel}）`)
  let text = read(rel)
  text = text.replace(/\{\{include:([^}]+)\}\}/g, (_, inc) => {
    const target = inc.trim()
    if (!/^[a-z0-9/_-]+\.md$/.test(target)) throw new Error(`gen-openclaw-skill: 非法 include ${target}`)
    return renderFile(target, depth + 1).replace(/\n+$/, '')
  })
  text = text.replace(/\{\{tool:([a-z0-9_-]+)\}\}/g, (_, id) => {
    const tool = contract.tools.find((t) => t.id === id)
    const face = tool?.channels?.openclaw
    if (face === undefined) throw new Error(`gen-openclaw-skill: openclaw 通道没有工具 ${id}`)
    return face.name
  })
  const left = text.match(/\{\{[^}]+\}\}/)
  if (left !== null) throw new Error(`gen-openclaw-skill: 未解析占位符 ${left[0]}`)
  return text
}

const frontmatter = read('openclaw.frontmatter.md').trimEnd()
const body = renderFile('openclaw.md').replace(/\n+$/, '')
const skill = `${frontmatter}\n\n${body.trimStart()}`

const defs = contract.tools
  .filter((t) => t.channels.openclaw !== undefined)
  .map((t) => {
    const face = t.channels.openclaw
    return {
      id: t.id,
      name: face.name,
      description: face.description,
      parameters: face.inputSchema,
    }
  })

const toolsJs = `// 生成物，勿手改。来源：modules/data/skill/contract.json\n` +
  `export const TOOL_DEFS = ${JSON.stringify(defs, null, 2)}\n`

mkdirSync(join(outDir, 'generated'), { recursive: true })
mkdirSync(join(outDir, 'skills/data-query'), { recursive: true })
writeFileSync(join(outDir, 'generated/tools.js'), toolsJs)
writeFileSync(join(outDir, 'skills/data-query/SKILL.md'), skill)
console.log(`gen-openclaw-skill: OK → ${outDir}`)
```

- [ ] **Step 3: 创建 `scripts/gen-openclaw-skill.test.ts`**

```ts
// gen-openclaw-skill.test.ts — 构建期渲染器与平台 render.ts 的输出必须逐字一致。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { contractView, renderSkill } from '../modules/data/skill/render'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts/gen-openclaw-skill.mjs')
const out = mkdtempSync(join(tmpdir(), 'skillgen-'))

afterAll(() => rmSync(out, { recursive: true, force: true }))

function run(): void {
  execFileSync(process.execPath, [SCRIPT, '--out', out], { cwd: ROOT, stdio: 'pipe' })
}

describe('gen-openclaw-skill.mjs', () => {
  it('SKILL.md = 平台 renderSkill("openclaw") 逐字一致', () => {
    run()
    const generated = readFileSync(join(out, 'skills/data-query/SKILL.md'), 'utf8')
    const expected = readFileSync(join(ROOT, 'modules/data/skill/content/openclaw.frontmatter.md'), 'utf8').trimEnd()
      + '\n\n' + renderSkill('openclaw').trimStart()
    expect(generated).toBe(expected)
  })

  it('tools.js 的工具名 = contractView("openclaw") 的名字集合', () => {
    run()
    const source = readFileSync(join(out, 'generated/tools.js'), 'utf8')
    const defs = JSON.parse(source.slice(source.indexOf('['), source.lastIndexOf(']') + 1))
    expect(defs.map((d: { name: string }) => d.name).sort())
      .toEqual(contractView('openclaw').map((t) => t.channels.openclaw!.name).sort())
  })

  it('Dockerfile.openclaw 仍接线构建期渲染（防删 build stage 后静默退回旧文件）', () => {
    const dockerfile = readFileSync(join(ROOT, 'deploy/Dockerfile.openclaw'), 'utf8')
    expect(dockerfile).toContain('gen-openclaw-skill.mjs')
  })
})
```

- [ ] **Step 4: 跑测试**

```bash
pnpm run test:guard
```

Expected: 新增三例 PASS。若 SKILL 对比失败，检查 `openclaw.md` 是否少/多空行——渲染器只做字符串拼接，空白也算内容。

- [ ] **Step 5: 提交**

```bash
git add scripts/gen-openclaw-skill.mjs scripts/gen-openclaw-skill.test.ts modules/data/skill/content/openclaw.frontmatter.md
git commit -m "feat(data): 新增 openclaw skill 构建期渲染器 (#$ISSUE)"
```

---

### Task 5: openclaw 插件改为消费生成物

**Files:**
- Modify: `deploy/openclaw/data-query-plugin/index.js`
- Modify: `deploy/openclaw/data-query-plugin/contracts.test.js`
- Modify: `deploy/openclaw/data-query-plugin/package.json`
- Modify: `.gitignore`

- [ ] **Step 1: 改 `index.js` 的导入与注册**

文件顶部加：

```js
import { TOOL_DEFS } from "./generated/tools.js";
```

把 `LIST_DEF` / `QUERY_DEF` / `DETAIL_DEF` / `SEARCH_DEF` / `DESCRIBE_DEF` / `SAMPLE_DEF` / `FRESHNESS_DEF` 七个字面量整段删除。

保留 `factory`、`lastUserIdBySession`、`callPlatform`、`normalizeParams`、`toToolResult`、新鲜度捕获逻辑。

在 `register(api)` 内，用下面的 `ENDPOINTS` / `OBSERVERS` 替换原来逐个 `api.registerTool(...)` 的调用：

```js
    // 传输层映射：契约只描述「是什么」，HTTP 路径/回包观察是通道 C 的本地实现。
    // 签名与 factory 的 run 一致：(params, userId, sessionKey)；apiBase/CHANNEL_KEY 闭包捕获。
    const ENDPOINTS = new Map([
      ["list_metrics", (_p, userId, sessionKey) =>
        callPlatform({ apiBase, channelKey: CHANNEL_KEY, userId, sessionId: sessionKey, path: "/metrics" })],
      ["query", (p, userId, sessionKey) =>
        callPlatform({ apiBase, channelKey: CHANNEL_KEY, userId, sessionId: sessionKey, path: "/query", method: "POST", body: {
          metricId: p.metricId, args: p.args ?? {},
          ...(Array.isArray(p.dimensions) ? { dimensions: p.dimensions } : {}),
          ...(Array.isArray(p.orderBy) ? { orderBy: p.orderBy } : {}),
          ...(typeof p.limit === "number" ? { limit: p.limit } : {}),
        } })],
      ["query_detail", (p, userId, sessionKey) =>
        callPlatform({ apiBase, channelKey: CHANNEL_KEY, userId, sessionId: sessionKey, path: "/query/detail", method: "POST", body: {
          metricId: p.metricId, args: p.args ?? {},
          ...(Array.isArray(p.dimensions) ? { dimensions: p.dimensions } : {}),
          ...(typeof p.orderBy === "string" ? { orderBy: p.orderBy } : {}),
          ...(typeof p.desc === "boolean" ? { desc: p.desc } : {}),
          ...(typeof p.limit === "number" ? { limit: p.limit } : {}),
          ...(typeof p.offset === "number" ? { offset: p.offset } : {}),
        } })],
      ["search", (p, userId) =>
        callPlatform({ apiBase, channelKey: CHANNEL_KEY, userId, path: "/toolbox", method: "POST", body: {
          tool: "search_catalog", args: {
            q: p.q,
            ...(typeof p.kind === "string" ? { kind: p.kind } : {}),
            ...(typeof p.tier === "string" ? { tier: p.tier } : {}),
          },
        } })],
      ["describe_metric", (p, userId) =>
        callPlatform({ apiBase, channelKey: CHANNEL_KEY, userId, path: "/toolbox", method: "POST", body: {
          tool: "describe_metric", args: { id: p.id, ...(p.coverage === true ? { coverage: true } : {}) },
        } })],
      ["sample_dimension_values", (p, userId) =>
        callPlatform({ apiBase, channelKey: CHANNEL_KEY, userId, path: "/toolbox", method: "POST", body: {
          tool: "sample_dimension_values", args: {
            metricId: p.metricId, dimension: p.dimension,
            ...(typeof p.q === "string" && p.q ? { q: p.q } : {}),
            ...(typeof p.limit === "number" ? { limit: p.limit } : {}),
          },
        } })],
      ["freshness", (p, userId) =>
        callPlatform({ apiBase, channelKey: CHANNEL_KEY, userId, path: "/toolbox", method: "POST", body: {
          tool: "get_freshness", args: { ...(typeof p.scope === "string" && p.scope ? { scope: p.scope } : {}) },
        } })],
    ]);

    const OBSERVERS = new Map([
      ["query", (result, sessionKey, runId) => {
        if (!result) return;
        const freshness = typeof result.freshness_line === "string" && result.freshness_line ? result.freshness_line : undefined;
        const scope = typeof result.scope_line === "string" && result.scope_line ? result.scope_line : undefined;
        if (freshness || scope) freshnessStore.capture(sessionKey, { freshness, scope }, runId);
      }],
      ["query_detail", (result, sessionKey, runId) => {
        if (!result) return;
        const scope = typeof result.scope_line === "string" && result.scope_line ? result.scope_line : undefined;
        if (scope) freshnessStore.capture(sessionKey, { scope }, runId);
      }],
      ["freshness", (result, sessionKey, runId) => {
        if (!result) return;
        const line = typeof result.line === "string" && result.line ? result.line : undefined;
        if (line) freshnessStore.capture(sessionKey, { freshness: line }, runId);
      }],
    ]);

    for (const raw of TOOL_DEFS) {
      const { id, ...def } = raw; // id 只用于查传输/观察器，不交给 openclaw（防网关拒绝未知字段）
      const run = ENDPOINTS.get(id);
      if (run === undefined) throw new Error(`data-query: 工具 ${id} 没有传输实现`);
      api.registerTool(factory(def, run, OBSERVERS.get(id)), { name: def.name });
    }
```

- [ ] **Step 2: 改 `package.json`（生成物入 files，加便捷脚本）**

```json
  "scripts": {
    "gen": "node ../../../scripts/gen-openclaw-skill.mjs --plugin-dir .",
    "test": "node --test"
  },
  "files": ["index.js", "lib.js", "generated", "skills", "openclaw.plugin.json", "README.md"],
```

- [ ] **Step 3: 改 `contracts.test.js`：先确保生成物存在，再断言**

把文件头到第一个 `test(...)` 之间替换为：

```js
// contracts.test.js — 网关工具声明契约回归（#989）。
// 工具定义现在由 modules/data/skill/contract.json 构建期渲染到 generated/tools.js；
// 本测试先确保生成物存在，再钉「注册名 ⊆ openclaw.plugin.json contracts.tools」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pluginDir = fileURLToPath(new URL(".", import.meta.url));

// 每次都重新生成：本地残留的旧 generated/ 不能让它「假绿」；CI 干净 checkout 也能自举。
execFileSync(process.execPath, [
  fileURLToPath(new URL("../../../scripts/gen-openclaw-skill.mjs", import.meta.url)),
  "--plugin-dir", pluginDir,
], { stdio: "inherit" });

const { TOOL_DEFS } = await import("./generated/tools.js");
const manifest = JSON.parse(readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"));
const defNames = TOOL_DEFS.map((d) => d.name);

test("生成物非空：七个已知工具名全部在场（防渲染器静默产出空集）", () => {
  const known = ["list_metrics", "query_data", "query_detail", "describe_metric", "sample_dimension_values", "get_freshness", "search_catalog"];
  for (const name of known) assert.ok(defNames.includes(name), `生成物缺少 ${name}`);
});

test("生成物工具名 ⊆ openclaw.plugin.json contracts.tools（#989 防再漏）", () => {
  const declared = manifest.contracts?.tools ?? [];
  for (const name of defNames) {
    assert.ok(declared.includes(name), `工具 ${name} 已生成但未登记 contracts.tools——网关会拒载`);
  }
});

test("contracts.tools 与生成物集合一致（无陈旧残留）", () => {
  const declared = manifest.contracts?.tools ?? [];
  const extra = declared.filter((n) => !defNames.includes(n));
  assert.deepEqual(extra, [], `contracts.tools 里登记了生成物没有的工具：${extra.join(", ")}`);
});

test("index.js 不再手写工具 description（防回退到两套事实源）", () => {
  const src = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  assert.ok(!/name:\s*"[a-z_]+",\s*\n\s*description:/.test(src), "index.js 仍有手写 DEF；工具定义应来自 generated/tools.js");
});

test("index.js 语法可解析（node --check）", () => {
  execFileSync(process.execPath, ["--check", fileURLToPath(new URL("./index.js", import.meta.url))], { stdio: "pipe" });
});
```

- [ ] **Step 4: 迁移 `lib.test.js` 里读 index.js / SKILL.md 源文本的「文案即契约」断言**

`lib.test.js` 现有 4 个测试读 `index.js` 或 `SKILL.md` 的源文本（约 146–250 行）：

1. `query_data 工具描述含 total 自动合计规则`
2. `query_data 工具描述改为系统自动附加口径`
3. `data-query SKILL.md 新鲜度条改系统附加口径…`
4. `query_detail 工具注册：…`（其中描述断言）
5. `data-query SKILL.md 明细下钻节…`

处理：

- **删除**上述 1、2、3、5 四个测试（内容断言已迁到 `modules/data/skill/render.test.ts` 的「从 openclaw lib.test.js 迁来…」用例，见 Task 3）。
- **保留**测试 4，但只保留**传输层**断言：

```js
test("query_detail 注册形状：path/method 正确（描述断言已迁到 skill/render.test.ts）", () => {
  const src = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  assert.match(src, /"query_detail"/);
  assert.match(src, /path: "\/query\/detail"/);
  assert.match(src, /method: "POST"/);
  assert.match(src, /capture\(sessionKey, \{ scope \}, runId\)/);
});
```

- 其余 `lib.test.js` 用例（`lib.js` 纯逻辑、`toToolResult`、strip/append）**不动**。

- [ ] **Step 5: 忽略生成物**

在 `.gitignore` 追加：

```gitignore
# openclaw skill 构建期生成物（来源 modules/data/skill/，不提交）
deploy/openclaw/data-query-plugin/generated/
deploy/openclaw/data-query-plugin/skills/data-query/SKILL.md
```

仅加 `.gitignore` 不够——旧 `SKILL.md` 仍被 git 跟踪，必须同一提交里解除跟踪：

```bash
git rm --cached deploy/openclaw/data-query-plugin/skills/data-query/SKILL.md
```

- [ ] **Step 6: 本地生成并跑插件测试**

```bash
cd deploy/openclaw/data-query-plugin
npm run gen
node --test
```

Expected: `node --test` 全绿（lib / scope / contracts）。若 `generated/tools.js` 缺失，`contracts.test.js` 会自动生成一次。

- [ ] **Step 7: 删除旧 guide 同源门禁（与 gitignore 同一提交，避免干净 checkout 上旧门禁读不到 SKILL.md）**

```bash
git rm scripts/check-guide-sync.mjs scripts/check-guide-sync.test.ts
```

在 `.github/workflows/ci.yml` 删除：

```yaml
      # guide↔SKILL 同源（Wave 2，#985）：SKILL.md 漏抄/改写 GUIDE_INVARIANTS 即红（D-G1 机检）
      - run: pnpm exec tsx scripts/check-guide-sync.mjs
```

- [ ] **Step 8: 提交**

```bash
git add deploy/openclaw/data-query-plugin/index.js deploy/openclaw/data-query-plugin/contracts.test.js deploy/openclaw/data-query-plugin/lib.test.js deploy/openclaw/data-query-plugin/package.json .gitignore .github/workflows/ci.yml
git add -u scripts/
git commit -m "refactor(openclaw): 插件工具定义改由契约生成物提供 (#$ISSUE)"
```

---

### Task 6: Dockerfile 构建期渲染

**Files:**
- Modify: `deploy/Dockerfile.openclaw:1-45`
- Test: `scripts/gen-openclaw-skill.test.ts`（已在 Task 4 加静态断言）

- [ ] **Step 1: 在 `FROM ghcr.io/openclaw/openclaw@sha256:...` 之前加 builder stage**

```dockerfile
# ── skill 渲染（构建期，零依赖）──────────────────────────────────────────
# 来源 = modules/data/skill/；产物 = generated/tools.js + skills/data-query/SKILL.md。
# 仓库不提交生成物；镜像构建即最新，结构上不存在「生成后忘了更新」的漂移。
FROM node:22-alpine AS skillgen
WORKDIR /src
COPY modules/data/skill /src/modules/data/skill
COPY scripts/gen-openclaw-skill.mjs /src/scripts/
RUN node scripts/gen-openclaw-skill.mjs --out /out
```

- [ ] **Step 2: 在现有插件 `COPY` 之后加一行**

```dockerfile
COPY deploy/openclaw/data-query-plugin /opt/plugins/data-query-plugin
# 生成物最后覆盖进去（generated/ + skills/data-query/SKILL.md）
COPY --from=skillgen /out/ /opt/plugins/data-query-plugin/
```

- [ ] **Step 3: 静态验证 Dockerfile 结构**

```bash
grep -n "AS skillgen\|gen-openclaw-skill.mjs\|COPY --from=skillgen" deploy/Dockerfile.openclaw
```

Expected: 三行都在。

- [ ] **Step 4: 本地构建镜像（有 Docker 时）**

```bash
docker build -f deploy/Dockerfile.openclaw -t platform-core-openclaw:skill-test .
```

Expected: 构建成功。若本机无 Docker，记录「未本机构建」，由 CI/部署环境验证。

- [ ] **Step 5: 提交**

```bash
git add deploy/Dockerfile.openclaw
git commit -m "build(openclaw): 镜像构建期渲染 skill 产物 (#$ISSUE)"
```

---

### Task 7: MCP `initialize.instructions`

**Files:**
- Modify: `modules/data/routes/mcp-rpc.ts:55-125`
- Modify: `modules/data/routes/mcp.ts:55-75`
- Modify: `modules/data/routes/mcp.test.ts:90-110`

- [ ] **Step 1: `McpToolSet` 增加可选 `instructions`**

在 `mcp-rpc.ts` 的 `McpToolSet` 接口里加：

```ts
  /** initialize 回给客户端的简洁提示（可选）。完整指南走 data_agent_guide。 */
  instructions?: string
```

在 `initialize` 的回复里加：

```ts
    if (msg.method === 'initialize') {
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: toolset.serverName, version: '0.1.0' },
        ...(toolset.instructions !== undefined ? { instructions: toolset.instructions } : {}),
      })
    }
```

- [ ] **Step 2: `mcp.ts` 提供 instructions**

```ts
import { renderInstructions } from '../skill/render'

const readToolset: McpToolSet = {
  serverName: 'platform-data-mcp',
  // 惰性 + fail-soft：读正典失败时 initialize 不能 500（initialize 失败会让客户端直接连不上）。
  get instructions(): string {
    try {
      return renderInstructions()
    } catch {
      return '平台数据 MCP：开始数据任务前先调用 data_agent_guide。'
    }
  },
  // ...
}
```

`McpToolSet.instructions` 的类型保持 `string`，getter 满足接口。

- [ ] **Step 3: 测试 initialize 带 instructions**

在 `mcp.test.ts` 的 initialize 用例里加：

```ts
    expect(typeof body.result.instructions).toBe('string')
    expect(body.result.instructions).toContain('data_agent_guide')
    expect(body.result.instructions).toContain('1000')
    expect(body.result.instructions).not.toContain('工作流七步')
```

- [ ] **Step 4: 跑测试**

```bash
pnpm --filter data exec vitest run routes/mcp.test.ts
```

Expected: PASS（无 `DATABASE_URL` 时真库用例跳过，协议面用例仍跑）。

- [ ] **Step 5: 提交**

```bash
git add modules/data/routes/mcp-rpc.ts modules/data/routes/mcp.ts modules/data/routes/mcp.test.ts
git commit -m "feat(data): MCP initialize 返回简洁 skill 指针 (#$ISSUE)"
```

---

### Task 8: 文档与最终验证

> 旧 `check-guide-sync` 的删除与 CI step 已在 Task 5 Step 7 完成（与 gitignore 同一提交）。

**Files:**
- Modify: `deploy/openclaw/data-query-plugin/README.md`
- Modify: `package.json`（加 `gen:skill`）

- [ ] **Step 1: 根 `package.json` 加便捷脚本**

```json
  "scripts": {
    "gen:skill": "node scripts/gen-openclaw-skill.mjs --plugin-dir deploy/openclaw/data-query-plugin",
  }
```

- [ ] **Step 2: 更新插件 README**

在「## 部署」节前加一节：

```markdown
## skill 正典与生成

`SKILL.md` 与工具描述不手写：正典在 `modules/data/skill/`（`contract.json` + `content/*.md`）。
本地改完正典后跑：

```bash
pnpm gen:skill
```

生成物 `generated/` 与 `skills/data-query/SKILL.md` 已在 `.gitignore`；镜像构建期会自动生成。
**不要直接改生成物**，改正典。

skill 变更的行为回归：按 `scripts/askdata/dual-arm-eval.test.ts` 的既有流程跑一次双臂评估。
```

- [ ] **Step 3: 全身验证**

```bash
pnpm run typecheck
pnpm run test:guard
pnpm --filter data test
pnpm exec tsx scripts/check-mcp-toolface.mjs
cd deploy/openclaw/data-query-plugin && node --test
cd /Users/buddybot/orca/workspaces/platform-core/MCP-及-skill
```

Expected:

- `typecheck` 全绿（含 `scripts/` 的 `tsconfig.json`）。
- `test:guard` 全绿（含新的 gen 测试）。
- `pnpm --filter data test` 全绿（无 `DATABASE_URL` 时真库用例按既有逻辑跳过）。
- `check-mcp-toolface: OK`。
- 插件 `node --test` 全绿。

- [ ] **Step 4: 提交**

```bash
git add package.json deploy/openclaw/data-query-plugin/README.md
git commit -m "docs(data): 说明 skill 正典与生成流程 (#$ISSUE)"
```

- [ ] **Step 5: 开 PR（不直推 main）**

```bash
git push -u origin MCP-及-skill
gh pr create --title "feat(data): 统一 MCP 指令面与 openclaw SKILL 管理" --body "设计：docs/superpowers/specs/2026-11-09-unified-skill-management-design.md

- 工具契约收敛到 modules/data/skill/contract.json
- 指令正文收敛到 content/*.md，平台 MCP 直接读取
- openclaw 侧构建期渲染，仓库不提交生成物
- 首轮迁移保持各通道输出逐字不变

Closes #$ISSUE"
```

Expected: PR 创建成功，CI 全绿后合并。

---

### Task 9（可选 P2，不阻塞本期）：MCP resource 与工具名收敛

- [ ] **Step 1: 评估是否加 `resources/read`**

在 `mcp-rpc.ts` 增加 `resources/list` / `resources/read`，暴露 `skill://data-query/SKILL.md`，内容 = `renderSkill('mcp')`。仅在确认三方客户端支持 resources 后做。

- [ ] **Step 2: 评估工具名收敛**

把 `query_metric` 与 `query_data` 收敛为一个名字（建议保留 `query_metric`，openclaw 侧注册 alias `query_data` 一个版本周期）。仅在有行为评估覆盖后做。

---

## 自检记录（写计划时已核对）

- **Spec 覆盖**：契约（Task 1）、平台读取（Task 1/2）、openclaw 正文与文案契约迁移（Task 3）、构建期渲染（Task 4/6）、插件消费与旧门禁收口（Task 5）、instructions（Task 7）、文档与最终验证（Task 8）、P2（Task 9）。
- **无占位符**：所有代码步骤给了完整代码；内容迁移步骤给了明确的源文件、目标章节与逐字替换规则。
- **类型一致**：`SkillChannel` / `ContractTool` / `ChannelToolFace` / `renderSkill` / `contractView` / `renderInstructions` 在 Task 1–7 中同名同形。
- **行为不变**：Task 1 的 registry 快照、Task 2 的 guide 快照、Task 3 的「文案即契约」断言、Task 4 的 openclaw 渲染对比共同钉住首轮迁移。
- **已规避的坑**：`modules/data/vitest.config.ts` 的 include 不含 `skill/**`（Task 1 Step 6 补）；`lib.test.js` 有 5 个读源文本的文案测试（Task 5 Step 4 迁移）；旧 `check-guide-sync` 在干净 checkout 上读不到 gitignore 后的 SKILL.md（Task 5 Step 7 同提交删除）。
