# main 分支保护：现状、软替代、以及升级后怎么切回真的

> 状态：**服务端分支保护在本仓当前 plan 上不可用** —— 不是"没配"，是这个功能在该 tier
> 上不存在。本文件记录：403 实证 → 由此采用的四层软机制 → 各层局限 → 将来升级后如何
> 切回真保护。**改动其中任何一层之前，先读完全文。**

## 一、结论先行

本仓（私有仓 + `MYTech-Co-Ltd` 组织 plan = free）**无法**使用 GitHub 的 branch protection
与 rulesets。实测：

```console
$ gh api repos/MYTech-Co-Ltd/platform-core/branches/main/protection
gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)
```

关键旁证：同一次身份检查显示 `permissions.admin = true` —— 当前身份**有**仓库管理权限，
却依然 403。所以这不是"权限不够、让管理员开一下"的问题，而是**该 tier 上根本没有这个
功能，管理员也开不了**。（rulesets 同样不可用。）

> 历史注记：M0 Task 21 的 Step 4 曾把此事记作「无权限则记 runbook 待管理员执行」——
> 那个判断是错的。本文件即为纠正，并把原来的"待办"换成实际可用的替代方案。

## 二、防线因此降级为「本地拦 + 事后可见」

服务端"防"既然不可得，只能退一步。共四层：

| 层 | 是什么 | 拦什么 | 住哪 |
|----|--------|--------|------|
| ① | `.githooks/pre-push` | 本机 `git push` 直推 `main`/`master` | 版本化文件 |
| ② | 根 `package.json` 的 `prepare` → `scripts/install-git-hooks.mjs` | 让①在**同事机器上自动**生效 | 版本化 |
| ③a | CI `gates` job 的「校验提交纪律装置完好」步 | ①被删或丢执行位、②被改掉 | `.github/workflows/ci.yml` |
| ③b | CI `main-guard` job | 已绕过①进入 main 的提交（**事后**） | 同上 |
| ④ | 本文件 + 根 README「提交纪律」段 | 让人知道有这些机制、以及怎么正当绕过 | 文档 |

### ① `.githooks/pre-push`

git 通过 stdin 把推送计划喂给钩子，每行 `<local_ref> <local_sha> <remote_ref> <remote_sha>`。
只要 `remote_ref` 落在 `refs/heads/main` 或 `refs/heads/master` 就拒绝——**包括删除推送**
（那时 `local_sha` 是全 0，同样是"动 main"）。

放行口是 `PLATFORM_ALLOW_DIRECT_PUSH=1`，**刻意要求显式打一个变量**而不是随手一个开关；
放行时也会出声提醒，避免"静默放行等于没有这道防线"。

钩子的行为由 `scripts/git-hooks.test.ts` 覆盖（黑盒 spawn + 断言退出码），跑在 CI 的 `unit` job。

### ② 自动安装：为什么不能只靠"仓库里放个 .githooks"

`core.hooksPath` **不随 clone 继承**——它是本地配置，不是版本化内容。所以光把钩子放进仓里，
新 clone 的人不设这个配置，钩子永远不会跑。落点因此放在根 `package.json` 的 `prepare`
生命周期上：`pnpm install` 之后 pnpm 会执行根工程的 `prepare`，于是 **clone + `pnpm install`
这一步就把钩子装上了**，不需要任何人记得额外做什么。

实测（在 /tmp 造一个 workspace 形态的最小仓，跑全新 `pnpm install`，看它是否真的执行了
`prepare` 以及钩子有没有装上）：

```console
$ pnpm install
...   prepare$ node scripts/install-git-hooks.mjs
$ git config --get core.hooksPath
.githooks
```

**已知缺口（照实记）**：`prepare` 只在 pnpm 认为"这个工程的脚本还没执行过"时才跑。
对**依赖已经装好的 checkout** 再跑一次 `pnpm install` 不会重跑它；`--ignore-scripts` 同理。所以——

> 别拿"输出里有 `Already up to date`"当判据：一次**确实跑了** `prepare` 的安装同样会打印
> 这一行（pnpm 的 up-to-date 说的是依赖解析，与脚不脚本是两码事）。判别依据是 pnpm 维护的
> "该工程脚本已执行"状态，不是某行输出。这也是本条曾经写错的地方。

- **全新 clone 的同事**：自动装上，无需操作。
- **早就 clone 过、依赖已装好的老机器**：不会自动补上，需手动跑一次 `pnpm run prepare`。

这正是不能把②当作唯一防线的原因；③a 用来兜"装置被改坏"。

安装脚本另有一条刻意的行为：**在 git 工作树里却找不到 `.githooks/` 时必须出声**（而不是静默跳过）。
这里的"工作树"取 **git 自己认定的仓根**（`--show-toplevel`），不是从脚本位置倒推的目录——
git 把 `core.hooksPath` 当"仓根下的相对路径"来解析，只有两者一致才谈得上正确。这条挡两种情形：

- **脚本被挪走**导致倒推出的目录不是仓根；
- **本包被当依赖装进别人的仓库**（此时 toplevel 是使用方仓库，不是本包目录）。后者危害更大：
  若无条件写配置，会把使用方仓库的**所有**钩子指向一个它那里不存在的 `.githooks`，
  该仓钩子集体静默失效——而使用方根本不会知道。

不在任何 git 仓库里（源码被解到别处）时则静默退出。

### ③a 装置完好校验（"守卫守卫本身"）

①与②任一失效都是**静默**的：没有报错，只会"从此刻起拦不住"。所以 CI 的 `gates` job 里
钉死两条不变量：`.githooks/pre-push` 存在**且带执行位**（git 只运行可执行钩子），
根 `prepare` 仍指向 `scripts/install-git-hooks.mjs`。

### ③b `main-guard`：直推进入 main 的事后绊线

push 到 main 后，回头检查本次推送的每个提交是否经由 PR 进来；不是就报警。

**判据为什么用 `GET /repos/{owner}/{repo}/commits/{sha}/pulls`，而不是"数父提交有几个"**——
因为 squash / rebase 合并产生的提交**同样是单父的**，"数父"会把正常的 squash 合并误判成直推。
用本仓的真实提交实测（2026-09-11）：

| 提交 | 来路 | associated-pulls | 父提交数 |
|------|------|------------------|----------|
| `241ed3a` | PR #1 **squash 合并** | **1**（正确认出 PR #1） | 1 |
| `eec7791` | 历史**直推** | **0**（正确判为直推） | 1 |

两者父提交数都是 1 —— 按"数父"判，合法的 squash 合并与违规直推**给出完全相同的结论**，
该判据等于废掉。associated-pulls 才能把它们分开。

**它不是闸门。** `main-guard` 跑在 push **之后**，报警时 main 已经被改了。它的价值在"可见、
可追溯"，不在"阻止"。别拿它当门禁用。

## 三、局限（照实说，不粉饰）

1. **`git push --no-verify` 一步绕过①。** git 此时压根不调用钩子，所以钩子**看不见**这个标志——
   这是最省事的绕过方式，必须列在最前，而不是藏起来。缓解只有 ③b 的事后记录。
2. ①是个本地文件，**删掉它即可绕过**；③a 能发现，但发现时改动已在分支上。
3. ①只在**装过**的机器上有效；没跑过 `pnpm install`（或用了 `--ignore-scripts`）的机器照推不误。
4. ①只看远端 **ref**、**不看远端名**，故 `git push backup main` 这类推 fork / 备份仓也会被拦。
   方向是 fail-closed（多拦而非漏拦），**刻意不去"修"**——放宽远端名等于又开一个口子。
5. ①②③ **全都拦不住在 GitHub 网页上直接 commit / 走网页合并**。
6. ③b 是事后绊线，报警时 main 已经变了。
7. ③b 的判据有三条边界：commits 数组**上限 20 条**；**只删提交的 force push** 会让它无对象可判
   （此时它打印"无法判定"而**不是**谎报干净）；**直推一个已有开着 PR 的分支**到 main
   （`git push origin mybranch:main`）会被关联 API 判成"经由 PR"。

**一句话**：这套东西的价值是「让直推变麻烦、让绕过变可见」，**不是**「让直推不可能」。
诚实的说法是：**一个 `--no-verify` 就够了**（第 1 条）。它拦的是"顺手直推"，不是"决意直推"。
真要"不可能"，只有升级 plan 或把仓库转 public —— 见下节。

## 四、日常怎么走（本仓走 PR）

```bash
git switch -c <你的分支名>
git push -u origin <你的分支名>
gh pr create --fill          # 然后在 PR 上等 CI 绿，由服务端合并
```

合并由服务端完成（`gh pr merge`），因此**不经过**本机的 pre-push 钩子。

确有理由要直推（首次 bootstrap、紧急热修）：

```bash
PLATFORM_ALLOW_DIRECT_PUSH=1 git push origin main
```

直推不会被 pre-push 拦下，但 `main-guard` 仍会事后记一笔 —— 请在 issue 或 PR 里补一条
说明，让那次直推可追溯。**要的是可见，不是禁止。**

## 五、将来升级 plan 后，怎么切回真保护

前提是二者之一：组织升级到 GitHub Pro / Team / Enterprise，**或**本仓转为 public。
验证方式：下面第一条命令不再返回 403。

### 1. 先拿到 check 的真实 context 名（别抄猜的名字）

GitHub Actions 的状态检查名**通常**等于 job id（`unit` / `gates` / `web` / `smoke`），
但仓库若改过 job 名或用了 matrix，实际 context 会不同。以最近一次成功的 run 为准：

```bash
gh run list --branch main --limit 1
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
  "enforce_admins": true,
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

两处刻意与直觉相反的地方，各有原因：

- **`contexts` 里没有 `main-guard`。** 它是 `if: github.event_name == 'push'` 的 job，在
  **每个 PR 上都会被 skip**。把一个只可能 skip 的 job 列进必过检查，轻则白占一格，重则让每个
  PR 永远卡在 "Expected — Waiting for status to be reported" ——那正是本节开头警告的那种失败。
  它是 push 之后的绊线，本来也不属于"合并前必须绿"的集合。
- **`enforce_admins: true`。** 若为 `false`，管理员**不受**保护约束，而下面执行 `PUT` 的人必然
  就是管理员 ⇒ 第 3 步那条"直推应被拒"的验证会**自己失败**（直推反而成功、空提交落进 main）。
  开启它，验证步骤才成立、管理员也别想绕。

`contexts` 若与第 1 步查出的名字对不上，GitHub **不会报错**，而是永远等一个不会出现的检查
——同样表现为卡在 "Expected — Waiting for status to be reported"。所以第 1 步不能跳。

### 3. 验证

```bash
gh api repos/MYTech-Co-Ltd/platform-core/branches/main/protection \
  --jq '{checks: .required_status_checks.contexts, strict: .required_status_checks.strict,
         reviews: .required_pull_request_reviews.required_approving_review_count,
         force_push: .allow_force_pushes.enabled, deletions: .allow_deletions.enabled}'

# 直推应被拒（预期报 protected branch，这正是我们要的效果）
git commit --allow-empty -m "chore: 验证分支保护（应当被拒）"
git push origin main   # ← 预期失败；失败后：
git reset --soft HEAD~1   # 扔掉这条空提交。**用 --soft 而非 --hard**：--soft 只挪 HEAD，
                          # 不碰工作树；--hard 会连带丢掉你此刻未提交的其他工作。
```

### 4. 切回之后，软机制要不要拆

**建议留着。** 四层里没有任何一层会因为有了服务端保护而变成负担：

- ① 让开发者在本机就拿到即时反馈，而不是等 push 被服务端拒绝；
- ③a 变成"防止①被误删"，仍然成立；
- ③b 与 `required_status_checks` 语义部分重叠（都管"进 main 的东西走没走流程"），可以删掉该 job；
  留着也无害——它**不在** contexts 里，不会卡住任何 PR（理由见第 2 节）。

## 六、回退

```bash
# 关掉全部分支保护（回到当前状态）
gh api -X DELETE repos/MYTech-Co-Ltd/platform-core/branches/main/protection
```

若要单独拆掉某一层软机制：删 `.githooks/pre-push` 与 `package.json` 里的 `prepare`、
再删 ci.yml 的 `main-guard` job 与 `gates` 里那一步即可 —— **四处要一起动**，
否则 ③a 会发现装置不全并让 CI 变红（这是它该有的行为）。同样记得同步 README。

## 七、相关

- `.github/workflows/ci.yml` —— `gates`（装置校验）与 `main-guard`（绊线）两个 job 的定义
- `.githooks/pre-push` / `scripts/install-git-hooks.mjs` / `scripts/git-hooks.test.ts` —— ①与②及其测试
- 根 `README.md` 的「提交纪律」段 —— 面向开发者的简版
