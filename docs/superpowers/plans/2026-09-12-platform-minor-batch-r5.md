# 平台底座剩余小项（M1 闭债 R5）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修掉 CI 的 web flake（#12）、给静态响应加 `Cache-Control`、把 compose 的 server 端口绑回环并标注版本下限。

**Architecture:** 三处彼此独立的小改动：① web 测试的 antd 定时器收尸；② 静态托管按"是否内容哈希"分档设缓存头；③ compose 端口绑定与一条版本说明。

**Tech Stack:** TypeScript / Hono 4.13 / vitest / Docker Compose

**取证依据（本轮开工前实测，供参考）**：issue #3 第五节原 8 条里，**1 条已被 #10 修掉**（install-git-hooks 执行位）、2 条已处理/休眠（`?next=` 语义、SPA 深链），其余仍真。**不属本轮**：`branding.background` 渲染语义、`/healthz` vs `/readyz` 拆分、`getPermissions` 翻页——这三条要语义决策，另议。

## Global Constraints

- Node `>=22`；包管理器 `pnpm@11.22.0`
- 本地 PG：`docker compose -f deploy/docker-compose.yml up -d postgres` → `DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform`
- **守卫脚本必须经 `tsx`**：`pnpm exec tsx scripts/<x>.mjs`
- **验收命令必须覆盖本仓 CI 跑的全部命令**（尤其 `pnpm typecheck`）
- ⚠️ **还原变异别用 `git checkout <file>`**；用精确还原或先 commit
- 提交纪律：可见变更必须在 `CHANGELOG.md` 行内标注——**本轮 CHANGELOG 由 T4 统一收口，T1–T3 不要动它**（共享热文件，并行必冲突）
- 只动各任务 Files 段列出的文件；需要越界 → escalation

---

### Task 1: CI web flake——antd 定时器在环境拆除后触发（#12）

**Files:**
- Modify: `apps/web/src/pages/Console.test.tsx`
- （必要时）Modify: `apps/web/vitest.config.ts`

**背景（issue #12 的取证）**：CI 的 web job **24 条测试全过**却以退出码 1 失败，报 2 个未捕获异常 `ReferenceError: window is not defined`，栈顶指向 `@ant-design/pro-components/lib/layout/components/SiderMenu/BaseMenu.js:25` 的 `setTimeout` → `dispatchSetState`。**同一 commit `gh run rerun --failed` 即变绿** ⇒ 时序 flaky（CI 慢机更易触发）。它不是测试断言失败，而是**拆掉 jsdom 之后**还有一个 antd 的定时器回调在跑。

- [ ] **Step 1: 复现**

```bash
pnpm --filter @platform/web test   # 连跑多次；CI 慢机上更易触发
```
先按 issue #12 的记录确认现象（本地可能跑不出——那就以 CI 的失败日志为复现依据，并在报告里写明"本地 N 次未复现"）。

- [ ] **Step 2: 定位那个定时器的来源与生命周期**

读 `Console.test.tsx` 的 `beforeEach/afterEach` 与它渲染的组件路径，确认：
- 它渲染的是 `ProLayout`/`BaseMenu` 吗（即 antd 的定时器由谁调度）？
- 现有 `afterEach` 做了什么（`:107` 附近）？
- **给出"定时器在用例结束后仍存活"的最小证据**（例如把该测试文件的 teardown 顺序打印出来，或用一个不等 antd 稳定的用例复现）。

- [ ] **Step 3: 修**

按你 Step 2 的定位选一种（**说明选择理由**）：
- **(a) 让定时器落在用例生命周期内**：在断言前后 `await waitFor(...)` 等菜单稳定；或对渲染加 `act(...)` 包裹。
- **(b) 用假时钟**：该 describe 内 `vi.useFakeTimers()`（问题：RTL 的 `waitFor` 需相应配置，可能影响既有 24 条）。
- **(c) 显式收尸**：`afterEach` 里卸载组件后清掉遗留定时器（**只有假时钟下 `clearAllTimers` 才有效**，真时钟下需别的办法——若走这条，说明你实际清的是什么）。

⚠️ **不要**改成 `process.exitCode`/`onUnhandledError` 之类的"把红压成绿"——那正是本仓反对的"静默降级"。若你判定只能在 vitest 配置里对未捕获异常做**显式**处置，必须写清取舍并在此 issue 记录。

- [ ] **Step 4: 验证（flake 的验收靠重复，不靠单次）**

```bash
for i in $(seq 1 30); do pnpm --filter @platform/web test >/dev/null 2>&1 || { echo "第 $i 次红"; break; }; done; echo done
```
**要求：连跑 ≥30 次全绿**，把循环命令与结果写进报告。（单次绿不能证明 flake 修好——这正是它当初混过去的原因。）

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/Console.test.tsx apps/web/vitest.config.ts
git commit -m "test(web): 修 CI 间歇性失败——antd 定时器在 jsdom 拆除后触发（#12）"
```

---

### Task 2: 静态响应加 `Cache-Control`

**Files:**
- Modify: `apps/server/src/app.ts`（静态托管段）
- Modify: `apps/server/src/app.test.ts`
- Test: 同上

**背景**：全仓 `Cache-Control` 零命中（实测）。当前静态托管（`app.ts` 的 ⑩ 段）把 vite 产物与 SPA 兜底一视同仁，浏览器/edge 只能靠默认启发式缓存——**带内容哈希的产物没被标成 immutable（每次白重验），而 `index.html` 又可能被缓存住导致发版后用户拿到旧壳**。

- [ ] **Step 1: 写失败测试**

`apps/server/src/app.test.ts` 追加（复用该文件已有可发请求的 app 装配；**注意本轮可能与 T3 的 app.test 改动重叠——见 Files 段，本任务只加静态缓存相关断言**）：

```ts
  it('★ 负例：/assets/* 带内容哈希 ⇒ immutable 长缓存', async () => {
    // 用真实构建产物路径（先 pnpm --filter @platform/web build）
    const index = await app.request('/', { headers: { host: 'acme.test' } })
    const html = await index.text()
    const m = /\/assets\/[^"']+\.js/.exec(html)
    expect(m).not.toBeNull()
    const asset = await app.request(m![0], { headers: { host: 'acme.test' } })
    expect(asset.headers.get('cache-control')).toContain('immutable')
    expect(asset.headers.get('cache-control')).toContain('max-age=31536000')
  })

  it('★ 负例：SPA 入口（/ 与深链兜底）必须可重验，不得长缓存', async () => {
    for (const p of ['/', '/login', '/console/demo']) {
      const res = await app.request(p, { headers: { host: 'acme.test' } })
      const cc = res.headers.get('cache-control') ?? ''
      expect(cc).toContain('no-cache')       // 或 max-age=0, must-revalidate——二选一，全仓统一
      expect(cc).not.toContain('immutable')
    }
  })
```

（若 `/console/demo` 在当前 app 里落到别的分支，按实际调整路径；**语义不变**：凡是**返回 index.html** 的响应都必须可重验。）

- [ ] **Step 2: 跑测试确认失败**

```bash
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter @platform/server test -- app.test
```
预期：两条都红在 `expect(...).toContain(...)`——现在根本没有 `cache-control` 头。

- [ ] **Step 3: 实现**

`apps/server/src/app.ts` 静态段加一个**按路径分档**的头中间件（放在 `serveStatic` **之后**、SPA 兜底之前，或对 `spaIndex` 单独设）：

```ts
  // 静态缓存策略（M1 闭债 R5）：vite 产物带内容哈希 ⇒ immutable 长缓存；index.html（含 SPA 兜底
  // 返回的那份）**必须可重验**——否则发版后用户拿到旧壳去请求已删除的旧 assets，页面白屏。
  // 现有 serveStatic 不设 Cache-Control，浏览器的启发式缓存对两者一视同仁。
  const CACHE_ASSET = 'public, max-age=31536000, immutable'
  const CACHE_REVALIDATE = 'no-cache'
```

落点与判定（**动手前先读 `app.ts` 的 ⑩ 段确认现状再落**）：对 `/assets/*` 命中（`serveStatic` 成功返回）的响应设 `CACHE_ASSET`；对返回 `index.html` 的响应（`/`、`/login`、`/console/*` 深链、以及非 `/api` 的 GET 兜底）设 `CACHE_REVALIDATE`。

⚠️ **不要**用"路径里有没有点"这类启发式判断——按**实际命中的产物类型**判（`/assets/` 前缀 + 其余一律可重验），避免又造出一个"看起来对但会随 vite 配置漂移"的规则。

- [ ] **Step 4: 跑测试确认通过 + 全量**

```bash
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm test
pnpm typecheck
```
预期：全绿。**特别核对**：`smoke` 里那条「`/assets/*` 必须是构建产物本体」的断言仍成立（它断言字节，不受头影响）。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/app.ts apps/server/src/app.test.ts
git commit -m "feat(server): 静态响应按产物类型设 Cache-Control（哈希产物 immutable / index 可重验）"
```

---

### Task 3: compose——server 端口绑回环 + 版本下限标注

**Files:**
- Modify: `deploy/docker-compose.yml`

**背景（用户已裁决）**：`server` 的宿主端口映射现在是 `'${HOST_PORT:-13000}:13000'`——**绑在 `0.0.0.0`**，即任何能访问宿主 13000 的人可绕过 edge 直连应用（丢掉了 edge 上的证书、限速、访问控制）。生产上它只经 openship edge 访问（edge 在宿主上反代 `127.0.0.1:<port>`，本仓实测过），故**绑回环是安全的**。DB 端口此前已按同样理由改回环（R1 的 B4）。

- [ ] **Step 1: 改端口绑定**

```yaml
      # 绑回环（M1 闭债 R5）：生产上本服务只经 openship edge 访问，edge 在宿主上反代
      # 127.0.0.1:<port> ⇒ 绑 0.0.0.0 会让任何能访问宿主该端口的人**绕过 edge**
      # （丢掉证书、限速与访问控制）。与 DB 端口同理由（R1 的 B4 已这么改）。
      # 本地冒烟/开发不受影响（它们走 127.0.0.1）。
      - '127.0.0.1:${HOST_PORT:-13000}:13000'
```

- [ ] **Step 2: 标注 `env_file: required` 的 Compose 版本下限**

`env_file` 下 `required: false` 处补一句（**只加注释，不改结构**）：

```yaml
    # 注意：`required` 字段需 **Compose ≥ 2.24**；更早版本会因未知字段报错或静默忽略。
    # 本仓 CI 与生产均用较新版；本地若 `docker compose version` < 2.24，请改用 `-f` 显式传 .env。
    env_file:
```

- [ ] **Step 3: 实测小样（两件事都要真跑）**

```bash
docker compose -f deploy/docker-compose.yml config >/dev/null && echo "compose config OK"
docker compose -f deploy/docker-compose.yml up -d postgres   # 仍应正常
pnpm exec tsx scripts/check-compose.mjs                       # 守卫仍应 OK（它只查多余 compose 文件，不查端口）
```
并**实测绑定生效**：起一次 server（或 `docker compose up -d server` 若镜像可构建），确认 `ss -ltnp | grep 13000` 显示 `127.0.0.1:13000` 而**非** `0.0.0.0:13000`。若本机不便起 server，退而用 `docker compose config` 的输出证明映射串为 `127.0.0.1:...`（**并说明这是替代证据**）。

- [ ] **Step 4: 验证冒烟不受影响**

```bash
pnpm --filter @platform/web build && DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm smoke
```
预期：绿（冒烟走 `127.0.0.1`，不受绑定范围收窄影响）。

- [ ] **Step 5: Commit**

```bash
git add deploy/docker-compose.yml
git commit -m "fix(deploy): server 宿主端口绑回环（免绕过 edge）+ 标注 env_file.required 的 Compose 版本下限"
```

---

## 完成判据

1. `pnpm test` 全绿且 PG 用例真跑（非 skip）；`pnpm typecheck` EXIT 0；四个守卫绿；`pnpm smoke` 绿
2. T1 的 flake 验收靠**连跑 ≥30 次全绿**（单次绿不算）
3. T2/T3 的实测证据（缓存头实测、端口绑定实测）进报告
4. 每个任务一条 commit

## 本计划不做

- **需语义决策的三条**（另议）：`branding.background` 渲染语义（现为原样塞 CSS，填 URL 是无效 CSS）、`/healthz` vs `/readyz` 拆分、`getPermissions` 翻页（`pageSize=100` 截断风险）
- **已修/已过时**（本轮不重复做）：install-git-hooks 执行位（#10 已修）、`?next=` 语义（评审 fix-3 已处理）、SPA 深链（休眠取舍）
- 守卫脚本骨架收敛、B1 不扫 `.sql`、B2 只匹配裸说明符——**待核实后再定**（本轮取证未定位到，且收敛属重构）

## 协调者自办（不在 worker 范围）

- **第五节清账**：把本轮三角定位结论（哪些已修 / 已过时 / 仍真）写回 issue #3，让总账与实际一致
