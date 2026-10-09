# #531 seed 期望集按账套过滤 + 排班完整性门禁 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans。裁决记录：issue #531 评论区（用户拍板方案 1）。

**Goal:** `seed-console.sh` 的期望集从「检出全部 15 件」改为「共享族 + 本账套后缀族」，并在 CI 加排班↔能力完整性门禁；机侧清理两件交叉孤儿。

**Architecture:** 卷内文件集的正确语义 =「本账套排班可能引用的一切都该在、不该跑的不必在」（裁决依据见 #531 分析评论：管线体账套无关、`--book` 只进 name、危害形态在排班不在文件）。排班完整性检查放 **CI 侧**（新 check 脚本，PR 时拦截）而非 seed 运行时——配置错误在源头抓。

**Tech Stack:** POSIX sh + awk（seed 工具）；Node/tsx checkJs（新门禁，遵守「单形状、字段恒在」——JSDoc 字面量加宽坑）。

## Global Constraints

- 管线 name == 文件名 stem（生成器保证）；后缀形如 `.<纯数字>.json` 才算账套后缀（`l0`/`l1` 是字母开头，不误伤）。
- seed 工具**永不删除**卷内文件（既有设计）⇒ 孤儿清理是一次性机侧动作，不进工具。
- 断言必须变异确认；抽不到函数/变量 = 判红；相邻中文一律 `${VAR}`。
- lock 覆盖 seed-console.sh ⇒ 改完必须重跑 `data-plane-lock.mjs`。
- feat/fix 必须 issue（#531 已开）；PR body `Closes #531`；squash subject 尾部**半角** ` (#PR号)`（#529 教训）。

---

### Task 1: seed-console.sh 期望集过滤

**Files:** Modify `scripts/lemeng/seed-console.sh`（`_pairs()` awk + 头注）

- [ ] awk 在 `pipelines/*.json` 分支加后缀判定：`match(p2, /\.[0-9]+\.json$/)` 命中时取 `substr(p2, RSTART+1, RLENGTH-6)` 与 `book` 全等比较，不等则 `next`；无数字后缀照旧保留。`--only all` 的 schedules/alerts/owners 分支不动。
- [ ] 头注补「期望集 = 共享族 + 本账套后缀族（#531）」与判据理由（一句话指 issue）。

### Task 2: seed-console.test.sh（新文件——本工具此前零测试，缺口一并补）

**Files:** Create `scripts/lemeng/seed-console.test.sh`

- [ ] 手法同族：从脚本抽**真 awk 程序**（`_pairs` 是函数内 awk——抽函数 eval 后直接调 `_pairs`，以 `LOCK` 指向 tmp 夹具锁文件）。
- [ ] 夹具锁文件行集：共享族 2 行、本账套 `.3120` 1 行、他账套 `.64188` 1 行、`schedules/3120.json`、`alerts.lemeng.json`；断言 `BOOK=3120 --only pipelines` 恰输出共享 2 + `.3120` 1（不含 `.64188`）。
- [ ] `--only all` 时 schedules 行映射到 `/workspace/schedules.json`、alerts/owners 同理。
- [ ] 变异确认：把过滤的 `!= book → next` 删掉（改为不过滤）⇒ 恰有用例变红；还原绿。
- [ ] 无匹配判红保护：抽不到 `_pairs` = FAIL（不是跳过）。

### Task 3: 排班完整性门禁（CI 侧）

**Files:** Create `scripts/check-console-schedules.mjs`；Modify `.github/workflows/ci.yml`（gates job 加一步，带理由注释）

- [ ] 规则：对 `deploy/duckle/console/schedules/<book>.json` 每条目：① `pipeline_id` 必须等于某管线文件的顶层 `name`（抓拼写错）；② `enabled` 条目的 name 还必须「能力属于本账套」——name stem 无数字后缀或后缀 == `<book>`（抓错账套排班 = SOP §F.1 危害形态的闸）。
- [ ] books 从 `schedules/*.json` 文件集推导（不写死两本）。
- [ ] 失败字面量 `SCHEDULE_INTEGRITY_FAILED:`（可 grep）；每条违规一行（book/条目 id/违规原因）。
- [ ] 遵守 checkJs 纪律：单形状、字段恒在，不做可辨识联合收窄。
- [ ] 自验：本仓现状必须绿；构造一个坏夹具（tmp 内复制改 pipeline_id）验它能红。

### Task 4: 收口

- [ ] `pnpm exec tsx scripts/lemeng/data-plane-lock.mjs`（seed-console.sh 进 lock）。
- [ ] 本地八条 check-*（新增的也跑）+ 全部 lemeng *.test.sh。
- [ ] Commit（单 scope `fix(data)`）→ push（代理坏相位则 `-c http.proxy=` 直连）→ PR `Closes #531`，subject 尾 ` (#PR号)` 半角。
- [ ] CI CLEAN 才 squash 合并。

### Task 5: 机侧落地（openship 通路）

- [ ] `sh /opt/lemeng-sync.sh <合并后全SHA>` → SYNC_OK。
- [ ] 孤儿清理（一次性，不进工具）：64188 卷删 `item_price.l0.3120.json`；3120 卷删 `item_price.l0.json`（均惰性：不在本卷排班）。
- [ ] `seed-console.sh 3120/64188 --check` 双 SEED_OK（过滤后的期望集）。
- [ ] issue #531 关闭评论（判据逐条对账）。
