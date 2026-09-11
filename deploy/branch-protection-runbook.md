# Runbook（待管理员执行）：main 分支保护

> 状态：**未执行**。M0 Task 21 的 Step 4 要求在 GitHub 上开启 `main` 分支保护，
> 实际执行被推迟——理由见「为什么没在 Task 21 里直接开」。本文件是留给有仓库
> admin 权限者的操作单，照着敲即可，含验证与回退。

## 为什么没在 Task 21 里直接开

开启分支保护是**对外、影响全仓、且难以无痛回退**的仓库设置变更：一旦生效，任何直推
`main` 立即被拒。而本仓 M0 阶段的前序任务一直是「提交即直推 main」的工作方式
（`git log` 可见），本流程自身的 Task 21 提交也是直推的。在「后续是否改用 PR 流程」
这个问题被决策之前就打开闸门，会立刻把当前流程卡死在自己设的门禁上——而且此时**唯一**
能提交的方式就是先改流程，属于把两件事绑死。

因此本任务的落法是「产出 runbook + 明确 required checks 清单」，执行留给管理员，
与简报 Step 4 的「无权限则记 runbook 待管理员执行」分支一致。

## 开启前必须先确认的一件事

**本仓的日常提交流程要改成 PR。** 保护规则要求 PR + 1 个 review，直推会被直接拒绝。
确认方式：问清楚 M0 之后的主力开发是否接受「分支 → PR → review → squash/merge」。
如果不接受，就不要开保护，而是改用别的轻量手段（例如仅开 required status checks、
不开 PR 要求）——见文末「分级选项」。

## 要保护的规则

| 项 | 值 | 理由 |
|----|----|------|
| required status checks | `unit` / `gates` / `web` / `smoke` | 四个 job = 全门禁，缺一条就有一条路能绕过（`.github/workflows/ci.yml`） |
| strict（分支必须是最新再合并） | true | 防「本地绿、合并后红」的语义漂移 |
| 禁止 force push | true | 保护历史可追溯 |
| 禁止删除分支 | true | 同上 |
| PR 必须 review | 1 人 | 简报 Step 4 原文 |
| 管理员豁免（enforce_admins） | 由管理员定 | 建议 false（开了才有意义）；代价是紧急热修也必须走 PR |

## 操作单

### 1. 拿到 check 的真实 context 名（先做这步，别抄猜的名字）

GitHub Actions 的状态检查名**通常**等于 job id（`unit` / `gates` / `web` / `smoke`），
但仓库若改过 job 名或用了 matrix，实际 context 会不同。以最近一次成功的 run 为准：

```bash
# 最近一次 main 上的 run（Task 21 推送后应有一次）
gh run list --branch main --limit 1

# 该 run 的 check 名清单——这就是要以原样填进 contexts 的字符串
gh api "repos/MYTech-Co-Ltd/platform-core/commits/main/check-runs" \
  --jq '[.check_runs[].name] | unique | .[]'
```

### 2. 开启保护

```bash
gh api -X PUT repos/MYTech-Co-Ltd/platform-core/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["unit", "gates", "web", "smoke"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
```

`contexts` 里若与第 1 步查出的名字对不上，GitHub 不会报错，而是**永远等一个不会出现的
检查**——表现为 PR 卡在 "Expected — Waiting for status to be reported"。所以第 1 步
不能跳。

### 3. 验证

```bash
# 规则回读
gh api repos/MYTech-Co-Ltd/platform-core/branches/main/protection \
  --jq '{checks: .required_status_checks.contexts, strict: .required_status_checks.strict,
         reviews: .required_pull_request_reviews.required_approving_review_count,
         force_push: .allow_force_pushes.enabled, deletions: .allow_deletions.enabled}'

# 直推应被拒（预期报 protected branch，这正是我们要的效果）
git commit --allow-empty -m "chore: 验证分支保护（应当被拒）"
git push origin main   # ← 预期失败；失败后 git reset --hard HEAD~1 扔掉这条空提交
```

## 分级选项（如果团队不想立刻上 PR 流程）

按「保护强度 / 流程代价」从低到高：

1. **只开 required checks**：`required_pull_request_reviews` 传 `null`。直推仍被禁（保护
   规则对 push 一样生效），但**任何人**都得先开 PR 才能落——所以这一档同样要求改流程，
   只是不需要 review 排队。适合「先上机检门禁，review 慢慢来」。
2. **只在 PR 上跑门禁、不开保护**（当前状态）：靠 review 纪律约束，机检能发现但拦不住。
   最弱的实际效果，但零流程摩擦。
3. **完整保护 + 1 review**（本文档主推）：流程代价最高，防线上事故最强。

## 回退

```bash
# 关掉全部分支保护（回到当前状态）
gh api -X DELETE repos/MYTech-Co-Ltd/platform-core/branches/main/protection
```

## 相关

- `.github/workflows/ci.yml` —— 四个 job 的定义；required checks 的清单以它为准
- `scripts/smoke-load.mjs` —— smoke job 跑的东西（job 名与脚本是一对，改名要同步）
