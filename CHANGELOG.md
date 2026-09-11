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

### Added - 分支保护软替代：本地拦 + 事后可见（free 私有仓无服务端分支保护）

- 【新增】**四层提交纪律机制**。起因：本仓是私有仓 + org plan=free，GitHub 的 branch protection
  与 rulesets **在该 tier 上不可用**（实测 `gh api .../branches/main/protection` → 403
  `Upgrade to GitHub Pro or make this repository public`；同一身份 `permissions.admin=true`
  却仍 403 ⇒ 是 tier 限制、管理员也开不了，不是权限问题）。服务端拦不住直推，改为：
  **①** `.githooks/pre-push` 拦本机直推 `main`/`master`（含删除推送；放行口
  `PLATFORM_ALLOW_DIRECT_PUSH=1` 须显式打、且放行时出声）；**②** 根 `prepare` →
  `scripts/install-git-hooks.mjs`，让同事 clone 后 `pnpm install` 即自动装上（`core.hooksPath`
  **不随 clone 继承**，光把钩子放进仓里没用）；**③a** CI `gates` 增「校验装置完好」步；
  **③b** 新增 `main-guard` job（push 到 main 后的事后绊线）
- 【新增】**`main-guard` 的判据是 associated-pulls，不是"数父提交有几个"**：squash / rebase 合并
  产生的新提交同样是单父的。用本仓真实提交实测——`241ed3a`（PR #1 **squash 合并**）与
  `eec7791`（历史**直推**）**父提交数都是 1**，按"数父"判两者结论完全相同、判据等于废掉；
  `/commits/{sha}/pulls` 才能分开（1 vs 0）。此结论写进了 ci.yml 注释
- 【新增】**装置行为测试 20 条**（`scripts/git-hooks.test.ts`）：除纯 spawn 外专设一档
  **经真 git 真推**（建裸 origin + 工作仓）锁住钩子赖以工作的 stdin 契约——只对着自造 fixture
  断言，等于用自己的假设验证自己的假设。另含两条**特征化测试**，把「`--no-verify` 可一步绕过」
  与「对任意远端名都拦（推 fork / 备份仓会误伤）」钉在代码里，免得日后有人以为它滴水不漏
- 【修复】**`install-git-hooks.mjs` 的仓根改取 `--show-toplevel`**（原先从脚本位置倒推）。git 把
  `core.hooksPath` 当"仓根下的相对路径"解析，倒推的目录与之不一致时会去写**错的仓库**——最坏
  情形是本包被当依赖装进别人的仓库，那会把对方**所有**钩子指向一个它那里不存在的 `.githooks`，
  该仓钩子集体静默失效。同时把 `readdirSync` 收进 try：头注承诺"任何失败都不阻断安装"是**绝对**
  承诺，而列目录失败（`.githooks` 是普通文件 ⇒ ENOTDIR）曾会让 `pnpm install` 以退出码 1 挂掉
- 【新增】**`deploy/branch-protection-runbook.md` 重写**：原版把上述 tier 限制误记为「权限问题、
  待管理员执行」，**前提就是错的**。新版记录 403 原文、四层机制、**七条局限**（首条即
  `git push --no-verify` 一步绕过——最省事的绕过方式，不该藏起来），以及将来升级 Pro / Team
  后切回真保护的完整操作单，含两条会自相矛盾或卡死 PR 的坑（`enforce_admins` 必须为 true，
  否则"验证直推被拒"这一步自己就失败；push-only 的 `main-guard` **不能**放进 required contexts，
  否则每个 PR 都卡在 "Expected — Waiting for status to be reported"）。README 补「提交纪律」段
- 【修复】**`main-guard` 的「首次推送」分支自己会挂（bash 3.2）**：那条 `echo` 里 `$BEFORE`
  紧跟全角右括号「）」，而 bash 3.2（macOS 自带 `/bin/bash`）在 UTF-8 locale 下把 0x80 以上
  的字节**也算作变量名字符**——`$BEFORE）` 被解析成变量 `BEFORE）`，`set -u` 下直接
  "unbound variable" 退出 1。也就是说，**这条本意是「安全跳过」的分支，反而会把 job 弄挂**。
  CI 用的是 bash 5（实测 5.2.37 解析正确），所以只坑本地复跑；已改为 `${BEFORE}`，两种
  bash 上都正确。**这条是靠"把 run 块抽出来用真 bash 跑一遍"发现的**——纸面推演和自造夹具
  看不见 shell 解析器本身的行为，这正是它当初没被审出来的原因
- 【修复】**本条改动最初漏记 CHANGELOG**：首次提交时把它误判为「此仓无 CHANGELOG 机制」——
  该判断是错的（本文件自 M0 Task 22 建立，其头部正是「可见变更必须有 CHANGELOG 行内标注」）。
  那句错误判断作为既成事实留在 git 历史里，在此更正

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
