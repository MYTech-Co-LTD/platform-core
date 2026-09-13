# console SaaS 化改造（Pro v6 风格）：设计

> 本文是 platform-core console 壳「SaaS 布局改造」的**规划稿**（spec）。
> **状态：规划已定稿，未开工**——按用户工作铁律（2026-09-13）：任何项目先做规划再开工，
> 中途任何调整**先改本文**再动代码。开工指令 = 用户明确回复「开工」。
>
> 触发链：「要国内 SaaS 布局、开箱即用」→ 调研 Ant Design Pro v6 / 飞书风（Semi/Arco）→
> 本地实跑 Pro v6 验证 → 用户拍板「**就用 Ant Design Pro 的风格，只参考菜单摆放位置**」。

## 1. 现状核实（2026-09-13 实测）

- `apps/web` console 壳（`src/pages/Console.tsx`）**已在用 ProLayout**（pro-components 3.1.14-7），
  当前 `layout="side"`、菜单 = 概览 + registry 聚合模块页（config∩registry∩scope 三重过滤）、
  avatar + 登出按钮、branding 主色经 ConfigProvider 注入。
- Pro v6 官方脚手架（v6.0.3，本地 `~/Documents/mytechcode/explore/ant-design-pro` 实跑验证）：
  默认 `layout: 'mix'`（一级导航顶栏、组内二级进侧栏）、玻璃拟态卡片、顶栏暗色切换/搜索、
  概览工作台页、项目内嵌 Cheatsheet 文档。**无多标签页**（官方 issue #10550）。
- 飞书系对比结论：Semi 无像样 admin 模板（GitHub 最高 3★）；Arco Pro 成品但丢 antd 生态
  （`@ant-design/x` 不可用，AI 通路 spec 作废）→ 否决换栈。
- 风格定案 = Pro v6；这与既定方向 A（不迁 Umi、按需吸收，见记忆与 PR #34 的 D1）一致，无翻案。

## 2. 决策

- **D1 不换栈**：在现有 Vite + ProLayout 壳上抄 Pro v6 的风格与菜单摆放；不引入 Umi，不换组件体系。
- **D2 菜单摆放规则照抄 Pro v6 的位置规律**（数据看板打头 → 高频工具第二 → 业务居中按组 →
  管理垫后 → 个人/帮助最末；`mix` 形态）。具体映射见 §3。
- **D3 风格配置从 Pro `config/defaultSettings.ts` 抄值**：`layout: 'mix'`、`fixSiderbar: true`、
  玻璃卡片/暗色主题（antd 6 token）；主色/标题/logo **保留现有 branding API 链**（多租户品牌化，
  这条比 Pro 模板更对，不抄它的写死值）。
- **D4 范围收敛（本期做/不做）**：
  - **做**：mix 布局改造、菜单位置规则实现、工作台概览页升级（欢迎卡 + 模块入口卡片网格）、
    顶栏暗色切换。
  - **不做（后续可选，出现在菜单前必须先回来改本文）**：多标签页（Pro 风格本无此项，若将来要，
    属于偏离本规划的调整）；通知铃铛（依赖 Novu 接入）；租户切换（依赖 auth-core 会话模型决策）；
    「平台管理」「帮助」组的**页面本体**（本期只挂菜单占位规则，页面就绪一个挂一个，不留死链）。
- **D5 工作方式**：本 spec 即规划基线；实施分批走 PR（feat 需 issue）；任何调整先改本文再动码。

## 3. 菜单布局蓝图（顶栏一级，mix 形态）

```
概览(工作台) │ AI 助手 │ <业务模块区> │ 平台管理 ▾ │ 帮助 ▾
   第1位        第2位      中间按组        垫后         最末
```

| 位置 | 内容 | 来源与规则 |
|---|---|---|
| 1 概览 | 工作台：欢迎卡（用户/租户/品牌）+ 模块入口卡片网格（icon+名+描述）+ 预留数据位 | 壳固定项，升级现有 `ConsoleOverview` |
| 2 AI 助手 | case-engine 聊天页 | `modules/case-engine` 薄模块（PR #34 spec，未排期）——**该模块落地前此菜单位不存在**，落位后自然插入第 2 位 |
| 3 业务模块区 | registry 聚合的模块页，按 manifest 声明顺序 | **现有三重过滤机制原样保留**（config∩registry∩scope），只改插入位置规则 |
| 4 平台管理 ▾ | 二级（侧栏）：用户与权限 / 租户管理 / 模块管理 / 品牌设置 | 待建页；页面就绪才挂对应菜单项 |
| 5 帮助 ▾ | 二级：使用文档（学 Pro 内嵌 Cheatsheet 模式）/ 关于 | 待建；同上 |

菜单数据仍由 `Console.tsx` 的 `menuItems` 构造函数产出——改动是**位置规则**（固定项序 + 分组），
聚合机制（`console-registry.gen.ts`、`gen-console-registry.mjs`）零改动。

## 4. 实现要点（改哪些文件）

| 文件 | 改动 |
|---|---|
| `apps/web/src/pages/Console.tsx` | `ProLayout` 加 `layout="mix"`；`menuItems` 构造加位置规则（§3）；`actionsRender` 加暗色切换 |
| `apps/web/src/pages/Console.tsx`（`ConsoleOverview`） | 重写为工作台：欢迎卡 + 模块入口卡片网格（数据源 config∩registry，点击进模块页） |
| `apps/web/src/App.tsx` | **（修订 2026-09-13，issue #38）** 根路径 `/` 与顶层 `*` 重定向 `/console`；删除 `Placeholder.tsx`——全站不再出现「工作台建设中」占位 |
| 概览页样式 | 玻璃卡片风格（antd 6 token / 自定义 class），对齐 Pro v6 观感 |
| 模块页 | 本期**不改**（demo 模块页保持现状；面包屑/PageContainer 规范属后续项，不在本期范围） |

### 修订记录

- 2026-09-13：v0.3.0 部署后验收反馈——直接打开根域名仍见 Task 18 占位页「工作台建设中」（初版规划漏了根路由，当时 `/` 不在改动面）。修订为重定向并删占位组件（issue #38）。

## 5. 测试与验收

- 既有 `Console.test.tsx` / `console-registry.gen.test.ts` 全量适配通过（菜单项顺序断言更新）。
- 新增：工作台渲染测试（有/无模块权限两种 session）、mix 布局下菜单分组断言。
- **验收 = ① 有权限账号进 console 见顶栏一级菜单（概览在首、模块区居中）；② 工作台展示模块入口卡片且点击可达；③ 暗色切换可用；④ 无权限模块不可见（三重过滤回归）；⑤ 仓 CI 全绿。**

## 6. 已知边界

1. 多标签页明确**不在**本规划内（Pro 风格无此项）；若将来需要 → 先改本文（重新评估自研/插件）。
2. 「平台管理」「帮助」菜单组本期只定**位置规则**，不产出页面；挂占位菜单前必须已有对应页面。
3. Pro v6 本地参照实例（`~/Documents/mytechcode/explore/ant-design-pro`，dev server :8000）为
   临时调研产物，不进仓；实施完成后可清理。
4. 本期不动模块页样式体系（面包屑/页头规范），那是独立后续项，做之前同样先补规划。

## 7. 关联

- AI 通路底座 spec：`2026-09-13-case-engine-ai-pathway-design.md`（PR #34）——「AI 助手」菜单位的数据来源。
- 方向 A 决策记忆：`frontend-stack-no-antdpro-migration`（本文 D1 与其一致）。
- 工作铁律记忆：`plan-first-adjust-plan-first`（本文即按其产出的规划基线）。
- 调研事实沉淀：WeKnora「Ant Design Pro v6 与 @ant-design/x 选型事实」条目。
