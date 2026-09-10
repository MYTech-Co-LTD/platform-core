# platform-core

通用平台底座 monorepo（工单系统未来迁入为第一个模块）。

## 布局

- `apps/` — 可部署应用：`server`（Hono API）、`web`（前端，Task 17 生成）
- `packages/` — 共享库：`auth-core`（认证内核）、`platform-sdk`（`@platform/sdk`）
- `modules/` — 业务模块：`demo` 为占位，工单系统将迁入
- `deploy/` — 部署编排（占位）
- `scripts/` — 工具脚本（占位）

## 常用命令

```bash
pnpm install   # 安装全部 workspace 依赖
pnpm test      # 递归跑各包 test（--if-present）
pnpm build     # 递归构建（--if-present）
pnpm dev       # 启动 @platform/server 开发模式
```
