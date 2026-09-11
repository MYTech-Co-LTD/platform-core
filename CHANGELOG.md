# Changelog

> 本文件记录 platform-core 的**行为变化**（新增 / 修复 / 优化 / 破坏），按
> [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 维护，行内用
> **【新增】/【优化】/【修复】** 标注类型（公司开发纪律：可见变更必须有 CHANGELOG 行内标注）。
>
> **本文件自 M0 Task 22 起建立**：它由「部署面」这一任务新建（此前仓里没有任何 CHANGELOG 文件）。
> M0 的 Task 1–21（脚手架、auth-core、SDK、模块协议、宿主装配、console 壳、门禁与冒烟）在
> 本文件里**不追述**——历史可从 `git log --oneline --reverse` 逐条追溯，事后补写只会写出
> 一份与提交历史不同源的第二事实。是否回填留给 M1 计划决定。

## [Unreleased]

### Added - 部署面：Dockerfile / compose / OpenShip 接入 runbook / M0 手工冒烟清单（M0 Task 22）

- 【新增】**`deploy/Dockerfile.server`**：node:22-alpine 多阶段宿主镜像。build 阶段
  `corepack enable`（pnpm 版本取自 package.json 的 `packageManager`，不在 Dockerfile 里写第二份）
  + `pnpm install --frozen-lockfile && pnpm -r --if-present build`；runtime 阶段**逐目录 COPY**
  （root 清单 / 根 TS 工程 / scripts / packages / apps / modules / deploy），非 `COPY . .` ——
  漏一个目录就是一类启动期故障（gateway 漏 COPY 新模块 crash loop 三次的教训）。非 root 运行，
  镜像内置 HEALTHCHECK 打容器内 `$PORT/healthz`
- 【新增】**`deploy/docker-compose.yml`**（全仓唯一 compose，约束 B7）：`postgres`（healthcheck +
  命名卷）与 `server`（build 上面的 Dockerfile、`depends_on: service_healthy`、宿主 13000）。
  顶层 **`name: platform-core` 是必需的**：compose 默认项目名取自 compose 文件所在**目录名**，
  本文件在 `deploy/` 下，与任何同样把 compose 放 `deploy/` 的仓库共用项目名与卷名——
  实测已发生「本仓 `up -d postgres` 把另一个项目的容器就地 Recreate」的事故
- 【新增】**`.dockerignore`**：挡住宿主 `node_modules`（darwin 产物 + 悬空 workspace 链接）与
  陈旧 `apps/web/dist`——后者会伪装成「构建成功但页面正常」的假绿，镜像里的 dist 必须出自构建阶段
- 【新增】**`deploy/openship-adopt.md`**：OpenShip adopt + 生产部署的操作单（前置决策、env 13 键
  清单与生产取值、卷/域名/证书、生产差异、部署触发、验证、回滚、四个已知陷阱）
- 【新增】**`docs/m0-smoke-checklist.md`**：M0 手工冒烟清单。含「容器日志不得出现
  `[web] … 不存在，跳过静态托管`」这一条（静态托管静默降级 = 白屏前兆，而 `/healthz` 照绿）；
  企微真机两用例标注**待企微配置后补验**并写清前置条件，不留空勾选框
- 【新增】**`ci.yml` 的 `deploy` job**（CD 触发，默认惰性）：四个门禁 job 全绿后
  `POST /api/deployments {projectId, commitSha}` 让 openship 按 commit 部署。闸门用 repo variable
  `OPENSHIP_PROJECT_ID`——GitHub 的 job 级 `if` 读不到 `secrets` 上下文，「配了 secret 就跑」
  这个写法不成立；未设该变量时 job 显示 skipped，不产生任何控制面请求
- 【优化】**`deploy/README.md` / 根 `README.md`**：从「部署编排占位」改为指向真实产物
  （compose / Dockerfile / 两份 runbook / 冒烟清单），CI job 数从四个改为四个门禁 + 一个惰性 CD

### Fixed - 冒烟清单的复现路径与 C1 浏览器验证（Task 22 fix-1）

- 【修复】**`docs/m0-smoke-checklist.md` C1**：原文以「Orca CLI 这个版本没有 browser 子命令」
  为由把 console 演示页浏览器验证留成待人工——**这个理由不成立**（Orca CLI 1.4.197 有一整组
  Browser Automation 命令，`orca browser` 只是帮助里的分组标题而非子命令）。已**实际跑完**并记录
  结果：登录页渲染 → `admin1/pw` 登录落 `/console` → 左菜单「演示」→ `/console/demo` 便签列表
  从 `/api/modules/demo/notes` 渲染 → 深链 `reload` 不 404 → 全程 `/api/*` 200、零未捕获 JS 异常。
  截图落 `docs/img/console-demo-notes.png`
- 【修复】**A2 的复现路径**：原文标 ✅ 但照着做复现不了——它依赖一个**未提交、被 gitignore** 的
  `.tmp/mock-casdoor-net.ts` TCP 转发（MockCasdoor 只绑 `127.0.0.1`，容器够不着宿主环回），
  且没写 `CASDOOR_URL` 必须容器可达、也没交代实际跑的是 `HOST_PORT=13001` 而非文中写的 13000。
  已在 A2 内补齐这三条前置，并新增**容器内那一遍的坑记账**
- 【新增】**`scripts/dev-stack.mjs`（`pnpm dev:stack`）**：本地长驻开发栈——一次起 MockCasdoor
  + 宿主进程 + 本机 PG，打印可点的登录页/控制台/演示页 URL，长驻到 Ctrl-C 后收净（宿主进程组 +
  mock）。**自持全部 env、不读 `.env`、不依赖任何未提交的临时文件**，因此 A2 与 C1 都能从
  克隆下来的仓库直接复现。缺 `apps/web/dist` 时它**先死**——半启动会得到「`/healthz` 照绿而页面
  全白」的假绿，那正是本仓被坑过一次的那类问题
- 【优化】**冒烟清单 A 节前置**：把两条起栈路（`pnpm dev:stack` 看页面 / `docker compose` 验镜像）
  分开写清，并补上共用的两条前置——**PG 端口冲突**（本机 5432 常年被别的容器占着，A4 的复跑命令
  现在直接跑会失败）与 **Casdoor 可达性**（容器内 `127.0.0.1` ≠ 宿主 `127.0.0.1`）
- 【优化】**`.env.example`**：新增 `DEV_STACK_PORT`（仅 `pnpm dev:stack` 读，默认 13100，
  避开 13000 这个 `pnpm dev` / compose 的默认端口）；`package.json` 增 `dev:stack` 脚本别名

### 已知留白（不假装已完成）

- Dockerfile **没有** `ARG NPM_REGISTRY` 构建源入口：境内生产机构建可能被限速，届时按
  `data-platform-scaffold/core/gateway/Dockerfile` 的先例补（见 `deploy/openship-adopt.md` 陷阱 3）
- 生产 adopt **未执行**：需先由人拍板目标服务器与 PG 策略（`deploy/openship-adopt.md` 的
  「前置决策」与「为什么没在 Task 22 里直接 adopt」）
