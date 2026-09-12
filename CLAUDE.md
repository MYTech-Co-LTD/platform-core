# CLAUDE.md

<!--
  本文件**只做一件事**：把 Claude Code 引到唯一来源 AGENTS.md。
  `@AGENTS.md` 是 Claude Code 的 import 语法（已实测：能读到 AGENTS.md 的内容；
  反之，Claude Code **不读**仓库根 AGENTS.md——所以不要只写一句"见 AGENTS.md"的指针）。
  不要在下面再写内容，否则两份规矩必然漂移。
-->

@AGENTS.md

## 本仓的 agent 指令分布（指针）

- **项目专属内容（唯一来源）**：`AGENTS.md` —— 项目结构、文档地图、项目专属硬约束（模块声明即授权 / 装载期双向核对 / `routePath` 基准 / HEAD 归一 / `enabledFor` 按租户门控 / 四层软保护 / 冒烟）
- **团队级通用约束**（teamai 分发，本项目不重复写）：`~/.claude/rules/common/` —— 架构先行 · 数据库迁移纪律 · 部署后验 · 提交与 PR 纪律 · 密钥规矩 · 知识沉淀 · 派发与可见性 · 根本法则
- **契约必读**：`docs/module-protocol.md`　**债账**：issue #3
